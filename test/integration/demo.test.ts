/*
 * The debug adapter against esp32emu's demo machine (a 6502 or a Z80 with
 * RAM and an interrupt every frame): make -C ../esp32emu/components/emudbg/test
 * builds it; ESP32EMU_DEMO=<path> to use another.
 */
import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const root = path.join(__dirname, '..', '..', '..');
const adapter = path.join(root, 'out', 'src', 'adapter.js');
const fixtures = path.join(root, 'test', 'fixtures');
const demo = process.env.ESP32EMU_DEMO ?? path.join(root, '..', 'esp32emu', 'components', 'emudbg', 'test', 'build', 'demo');
const source = path.join(fixtures, 'hello.s');

function startDemo(cpu: string, port: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        const p = spawn(demo, [cpu, String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
        p.stderr?.on('data', (d: Buffer) => {
            if (d.toString().includes('debugger on')) {
                resolve(p);
            }
        });
        p.on('error', reject);
        setTimeout(() => reject(new Error('the demo machine did not start')), 5000);
    });
}

async function top(dc: DebugClient): Promise<DebugProtocol.StackFrame[]> {
    const st = await dc.stackTraceRequest({ threadId: 1 });
    return st.body.stackFrames;
}

async function stopAfter(dc: DebugClient, request: Promise<unknown>): Promise<DebugProtocol.StoppedEvent> {
    const [ev] = await Promise.all([dc.waitForEvent('stopped', 10000), request]);
    return ev as DebugProtocol.StoppedEvent;
}

(fs.existsSync(demo) ? describe : describe.skip)('the demo 6502', function () {
    this.timeout(30000);
    let machine: ChildProcess;
    let dc: DebugClient;
    const port = 17000 + Math.floor(Math.random() * 1000);

    before(async () => {
        machine = await startDemo('6502', port);
    });
    after(() => machine?.kill());

    beforeEach(async () => {
        dc = new DebugClient('node', adapter, 'esp32emu');
        await dc.start();
    });
    afterEach(async () => {
        await dc.stop();
    });

    async function launch(extra: Record<string, unknown> = {}) {
        const [, , stopped] = await Promise.all([
            dc.configurationSequence(),
            dc.launch({ host: '127.0.0.1', port, program: path.join(fixtures, 'hello.xex'), stopOnEntry: true,
                        resetFrames: 2, ...extra } as DebugProtocol.LaunchRequestArguments),
            dc.waitForEvent('stopped', 15000),
        ]);
        return stopped as DebugProtocol.StoppedEvent;
    }

    it('loads the program and stops at its entry, on its source line', async () => {
        const ev = await launch();
        assert.strictEqual(ev.body.reason, 'entry');
        const frames = await top(dc);
        assert.strictEqual(frames[0].name, 'start');
        assert.strictEqual(frames[0].source?.path, source);
        assert.strictEqual(frames[0].line, 5);
        const th = await dc.threadsRequest();
        assert.deepStrictEqual(th.body.threads.map((t) => t.name), ['6502']);
    });

    it('stops at a source breakpoint and shows the caller', async () => {
        await launch();
        const bps = await dc.setBreakpointsRequest({ source: { path: source }, breakpoints: [{ line: 11 }] });
        assert.strictEqual(bps.body.breakpoints[0].verified, true);
        const ev = await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        assert.strictEqual(ev.body.reason, 'breakpoint');
        const frames = await top(dc);
        assert.strictEqual(frames[0].line, 11);
        assert.strictEqual(frames[0].name, 'bump');
        assert.ok(frames.length >= 2, 'a caller from the stack');
        assert.strictEqual(frames[1].line, 7);
        assert.strictEqual(frames[1].instructionPointerReference, '0x2004');
    });

    it('steps over, into and out of calls, never into the interrupt handler', async () => {
        await launch();
        const lines: number[] = [];
        for (const step of ['next', 'next', 'next', 'next', 'stepIn', 'next', 'next', 'stepOut', 'next']) {
            const req = step === 'next' ? dc.nextRequest({ threadId: 1 }) : step === 'stepIn'
                ? dc.stepInRequest({ threadId: 1 }) : dc.stepOutRequest({ threadId: 1 });
            const ev = await stopAfter(dc, req);
            assert.strictEqual(ev.body.reason, 'step');
            const f = await top(dc);
            lines.push(f[0].line);
            assert.ok(f[0].source, `stopped outside the program (${f[0].name})`);
        }
        /* 5 lda, 6 sta, 7 jsr (over), 8 jmp, 7 jsr (into), 11, 12, out: 8, 7 */
        assert.deepStrictEqual(lines, [6, 7, 8, 7, 11, 12, 13, 8, 7]);
    });

    it('shows and changes registers and flags', async () => {
        await launch();
        const frames = await top(dc);
        const scopes = await dc.scopesRequest({ frameId: frames[0].id });
        const regsRef = scopes.body.scopes[0].variablesReference;
        let vars = (await dc.variablesRequest({ variablesReference: regsRef })).body.variables;
        assert.deepStrictEqual(vars.map((v) => v.name), ['PC', 'A', 'X', 'Y', 'S', 'P', 'cycles']);
        assert.match(vars[0].value, /^\$2000/);
        await dc.setVariableRequest({ variablesReference: regsRef, name: 'A', value: '$55' });
        vars = (await dc.variablesRequest({ variablesReference: regsRef })).body.variables;
        assert.match(vars[1].value, /^\$55/);
        const flags = vars.find((v) => v.name === 'P');
        assert.ok(flags && flags.variablesReference > 0, 'the flags open');
        const bits = (await dc.variablesRequest({ variablesReference: flags.variablesReference })).body.variables;
        assert.deepStrictEqual(bits.map((b) => b.name), ['N', 'V', 'B', 'D', 'I', 'Z', 'C']);
    });

    it('evaluates expressions, labels and memory', async () => {
        await launch();
        await stopAfter(dc, dc.nextRequest({ threadId: 1 }));
        await stopAfter(dc, dc.nextRequest({ threadId: 1 }));      /* lda #0, sta $80 */
        let r = await dc.evaluateRequest({ expression: '[$80]', context: 'watch' });
        assert.match(r.body.result, /^\$00/);
        r = await dc.evaluateRequest({ expression: 'bump + 3', context: 'watch' });
        assert.match(r.body.result, /^\$2013/);
        r = await dc.evaluateRequest({ expression: 'bump', context: 'hover' });
        assert.match(r.body.result, /^\$2010  \[\$2010\] = \$E6/);
        r = await dc.evaluateRequest({ expression: '>state', context: 'repl' });
        assert.match(r.body.result, /"state":"stopped"/);
    });

    it('honours conditions, hit counts and log points', async () => {
        await launch();
        await dc.setBreakpointsRequest({ source: { path: source }, breakpoints: [
            { line: 12, logMessage: 'counter is {[$80]}' },
            { line: 13, condition: '[$80] == 5' },
        ] });
        const logged = dc.waitForEvent('output', 10000);
        await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        const r = await dc.evaluateRequest({ expression: '[$80]', context: 'watch' });
        assert.match(r.body.result, /^\$05/);
        let out = (await logged) as DebugProtocol.OutputEvent;
        while (!/counter is/.test(out.body.output)) {
            out = (await dc.waitForEvent('output', 5000)) as DebugProtocol.OutputEvent;
        }
        assert.match(out.body.output, /counter is \$0[1-5]/);
        await dc.setBreakpointsRequest({ source: { path: source }, breakpoints: [{ line: 11, hitCondition: '3' }] });
        await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        const r2 = await dc.evaluateRequest({ expression: '[$80]', context: 'watch' });
        assert.match(r2.body.result, /^\$07/, 'the third time: counter 5 + 2');
    });

    it('reads memory and disassembles around an address', async () => {
        await launch();
        const mem = await dc.send('readMemory', { memoryReference: '0x2000', count: 24 });
        const bytes = Buffer.from(mem.body.data, 'base64');
        assert.deepStrictEqual([...bytes.subarray(0, 4)], [0xA9, 0x00, 0x85, 0x80]);
        const dis = await dc.send('disassemble', { memoryReference: '0x2010', instructionOffset: -2,
                                                   instructionCount: 6 });
        const ins = dis.body.instructions as DebugProtocol.DisassembledInstruction[];
        assert.strictEqual(ins.length, 6);
        const at = ins.findIndex((i) => i.address === '0x2010');
        assert.strictEqual(at, 2);
        assert.strictEqual(ins[at].instruction, 'INC $80');
        assert.strictEqual(ins[at].symbol, 'bump');
        assert.strictEqual(ins[at].line, 11);
        await dc.send('writeMemory', { memoryReference: '0x3000', data: Buffer.from([1, 2, 3]).toString('base64') });
        const back = await dc.send('readMemory', { memoryReference: '0x3000', count: 3 });
        assert.deepStrictEqual([...Buffer.from(back.body.data, 'base64')], [1, 2, 3]);
    });

    it('sets function and instruction breakpoints', async () => {
        await launch();
        await dc.send('setFunctionBreakpoints', { breakpoints: [{ name: 'bump' }] });
        await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        assert.strictEqual((await top(dc))[0].instructionPointerReference, '0x2010');
        await dc.send('setFunctionBreakpoints', { breakpoints: [] });
        await dc.send('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0x2014' }] });
        await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        assert.strictEqual((await top(dc))[0].line, 13);
    });

    it('pauses and shows the machine\'s screen', async () => {
        await Promise.all([
            dc.configurationSequence(),
            dc.launch({ host: '127.0.0.1', port, program: path.join(fixtures, 'hello.xex'), resetFrames: 2 } as
                DebugProtocol.LaunchRequestArguments),
            dc.waitForEvent('output', 5000),
        ]);
        await new Promise((r) => setTimeout(r, 300));
        const ev = await stopAfter(dc, dc.pauseRequest({ threadId: 1 }));
        assert.strictEqual(ev.body.reason, 'pause');
        const s = await dc.send('esp32emu.screen');
        assert.strictEqual(s.body.width, 320);
        assert.strictEqual(s.body.height, 200);
        assert.strictEqual(Buffer.from(s.body.data, 'base64').length, 320 * 200 * 2);
    });
});

(fs.existsSync(demo) ? describe : describe.skip)('the demo Z80', function () {
    this.timeout(30000);
    let machine: ChildProcess;
    let dc: DebugClient;
    const port = 18000 + Math.floor(Math.random() * 1000);

    before(async () => {
        machine = await startDemo('z80', port);
    });
    after(() => machine?.kill());

    it('attaches, pauses and steps through the idle loop and its interrupts', async () => {
        dc = new DebugClient('node', adapter, 'esp32emu');
        await dc.start();
        await Promise.all([dc.configurationSequence(),
            dc.attachRequest({ host: '127.0.0.1', port } as DebugProtocol.AttachRequestArguments)]);
        await stopAfter(dc, dc.pauseRequest({ threadId: 1 }));
        for (let i = 0; i < 20; i++) {
            await stopAfter(dc, dc.stepInRequest({ threadId: 1, granularity: 'instruction' }));
            const pc = (await top(dc))[0].instructionPointerReference;
            assert.ok(pc === '0x6' || pc === '0x7', `step ${i} stopped at ${pc}`);
        }
        const frames = await top(dc);
        const scopes = await dc.scopesRequest({ frameId: frames[0].id });
        const vars = (await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference }))
            .body.variables;
        assert.strictEqual(vars[0].name, 'PC');
        assert.ok(vars.some((v) => v.name === "AF'"));
        await dc.disconnectRequest({});
        await dc.stop();
    });
});
