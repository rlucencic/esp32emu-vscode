/*
 * The debug adapter against esp32pc's host build (an IBM PC/AT, its x86
 * core: linear addresses, segment registers) running the speed benchmark's
 * boot sector (test/fixtures/pcbench.bin, esp32pc's tools/bench.s):
 * make -C ../esp32pc/components/ibmpc/host builds it; ESP32PC_HOST=<path>
 * to use another.
 */
import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { DebugProtocol } from '@vscode/debugprotocol';

const root = path.join(__dirname, '..', '..', '..');
const adapter = path.join(root, 'out', 'src', 'adapter.js');
const host = process.env.ESP32PC_HOST ??
    path.join(root, '..', 'esp32pc', 'components', 'ibmpc', 'host', 'build', 'pc_host');
const FIB = 0x7CCA;                     /* the benchmark's recursive fib() */
const CALL_FIB = 0x7CE5;                /* fib's second call to itself */

async function top(dc: DebugClient): Promise<DebugProtocol.StackFrame[]> {
    return (await dc.stackTraceRequest({ threadId: 1 })).body.stackFrames;
}

async function stopAfter(dc: DebugClient, request: Promise<unknown>): Promise<DebugProtocol.StoppedEvent> {
    const [ev] = await Promise.all([dc.waitForEvent('stopped', 10000), request]);
    return ev as DebugProtocol.StoppedEvent;
}

(fs.existsSync(host) ? describe : describe.skip)('the IBM PC (x86)', function () {
    this.timeout(30000);
    let machine: ChildProcess;
    let dc: DebugClient;
    const port = 19000 + Math.floor(Math.random() * 1000);
    const disk = path.join(os.tmpdir(), `pcbench-${port}.img`);

    before(async () => {
        const sector = fs.readFileSync(path.join(root, 'test', 'fixtures', 'pcbench.bin'));
        const image = Buffer.alloc(1474560);
        sector.copy(image);
        fs.writeFileSync(disk, image);
        machine = spawn(host, ['1', path.join(os.tmpdir(), `pcbench-${port}.ppm`)], {
            stdio: 'ignore',
            env: { ...process.env, PC_MACHINE: 'at', PC_FLOPPY_A: disk, PC_DEBUG: String(port), PC_QUIET: '1' },
        });
        await new Promise((r) => setTimeout(r, 1500));
    });
    after(() => {
        machine?.kill();
        fs.rmSync(disk, { force: true });
    });

    beforeEach(async () => {
        dc = new DebugClient('node', adapter, 'esp32emu');
        await dc.start();
        /* As VS Code: initialize, attach, configurationDone (the test client's
         * configurationSequence() sends it only after its own launch())
         */
        await dc.initializeRequest();
        await Promise.all([dc.waitForEvent('initialized').then(() => dc.configurationDoneRequest()),
            dc.attachRequest({ host: '127.0.0.1', port } as DebugProtocol.AttachRequestArguments)]);
    });
    afterEach(async () => {
        await dc.send('setInstructionBreakpoints', { breakpoints: [] });
        await dc.disconnectRequest({});
        await dc.stop();
    });

    it('stops at an instruction breakpoint and finds the callers on the stack', async () => {
        await stopAfter(dc, dc.pauseRequest({ threadId: 1 }));
        await dc.send('setInstructionBreakpoints', { breakpoints: [{ instructionReference: '0x' + FIB.toString(16) }] });
        const ev = await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        assert.strictEqual(ev.body.reason, 'breakpoint');
        const frames = await top(dc);
        assert.strictEqual(frames[0].instructionPointerReference, '0x' + FIB.toString(16));
        assert.ok(frames.length >= 2, 'a caller from the stack');
        const callers = frames.slice(1).map((f) => parseInt(f.instructionPointerReference ?? '0', 16));
        assert.ok(callers.every((a) => a > 0x7C00 && a < 0x7E00), `callers in the boot sector: ${callers}`);
    });

    it('shows the registers, linear PC and stack among them', async () => {
        await stopAfter(dc, dc.pauseRequest({ threadId: 1 }));
        const frames = await top(dc);
        const scopes = await dc.scopesRequest({ frameId: frames[0].id });
        const vars = (await dc.variablesRequest({ variablesReference: scopes.body.scopes[0].variablesReference }))
            .body.variables;
        const names = vars.map((v) => v.name);
        for (const r of ['AX', 'SP', 'CS', 'SS', 'IP', 'FLAGS', 'PC', 'SSP']) {
            assert.ok(names.includes(r), `${r} in ${names}`);
        }
        const flags = vars.find((v) => v.name === 'FLAGS');
        assert.ok(flags && flags.variablesReference > 0, 'the flags open');
        const bits = (await dc.variablesRequest({ variablesReference: flags.variablesReference })).body.variables;
        assert.deepStrictEqual(bits.map((b) => b.name), ['N', 'O', 'D', 'I', 'T', 'S', 'Z', 'A', 'P', 'C']);
    });

    it('disassembles around an address and steps over a call', async () => {
        await stopAfter(dc, dc.pauseRequest({ threadId: 1 }));
        await dc.send('setInstructionBreakpoints', {
            breakpoints: [{ instructionReference: '0x' + CALL_FIB.toString(16) }] });
        await stopAfter(dc, dc.continueRequest({ threadId: 1 }));
        await dc.send('setInstructionBreakpoints', { breakpoints: [] });
        const dis = await dc.send('disassemble', { memoryReference: '0x' + FIB.toString(16), instructionOffset: -1,
                                                   instructionCount: 4 });
        const ins = dis.body.instructions as DebugProtocol.DisassembledInstruction[];
        const at = ins.find((i) => parseInt(i.address, 16) === FIB);      /* (24 bits: six digits) */
        assert.ok(at, `fib in the disassembly: ${JSON.stringify(ins.map((i) => [i.address, i.instruction]))}`);
        assert.match(at.instruction, /^PUSH\s+BP/);
        const ev = await stopAfter(dc, dc.nextRequest({ threadId: 1, granularity: 'instruction' }));
        assert.strictEqual(ev.body.reason, 'step');
        assert.strictEqual((await top(dc))[0].instructionPointerReference, '0x' + (CALL_FIB + 3).toString(16));
    });
});
