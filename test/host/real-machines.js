/*
 * The adapter against the real machines' desktop builds (local only: they
 * need the machines' ROMs). node test/host/real-machines.js
 */
const { DebugClient } = require('@vscode/debugadapter-testsupport');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dev = path.join(__dirname, '..', '..', '..');
const adapter = path.join(__dirname, '..', '..', 'out', 'src', 'adapter.js');
const fixtures = path.join(__dirname, '..', 'fixtures');
const scratch = fs.mkdtempSync(path.join(require('os').tmpdir(), 'esp32emu-'));

function start(cmd, args, env, cwd) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'ignore', 'pipe'] });
        p.stderr.on('data', (d) => { if (d.toString().includes('debugger on')) resolve(p); });
        p.on('exit', (c) => reject(new Error(`${cmd} exited ${c}`)));
        setTimeout(() => reject(new Error('no debugger')), 8000);
    });
}

async function session(port, launch) {
    const dc = new DebugClient('node', adapter, 'esp32emu');
    await dc.start();
    const [, , ev] = await Promise.all([dc.configurationSequence(),
        dc.launch({ host: '127.0.0.1', port, stopOnEntry: true, ...launch }), dc.waitForEvent('stopped', 60000)]);
    return { dc, ev };
}

async function top(dc) {
    return (await dc.stackTraceRequest({ threadId: 1 })).body.stackFrames;
}

async function atari() {
    const xl = await start(path.join(dev, 'esp32xl/components/atari_xl/host/build/xl_host'),
        [path.join(dev, 'esp32xl/roms/atarixl.rom')], { XL_DEBUG: '17501' });
    try {
        const { dc, ev } = await session(17501, { program: path.join(fixtures, 'hello.xex') });
        assert.strictEqual(ev.body.reason, 'entry');
        let f = await top(dc);
        assert.strictEqual(f[0].line, 5);
        await dc.setBreakpointsRequest({ source: { path: path.join(fixtures, 'hello.s') }, breakpoints: [{ line: 13 }] });
        await Promise.all([dc.waitForEvent('stopped'), dc.continueRequest({ threadId: 1 })]);
        f = await top(dc);
        assert.strictEqual(f[0].line, 13);
        assert.strictEqual(f[1].line, 7, 'the caller');
        /* Through the Atari's VBI and DLIs: steps stay in the program */
        for (let i = 0; i < 30; i++) {
            await Promise.all([dc.waitForEvent('stopped'), dc.nextRequest({ threadId: 1 })]);
            assert.ok((await top(dc))[0].source, 'a step left the program');
        }
        const s = await dc.send('esp32emu.screen');
        console.log(`  Atari: ${s.body.width} x ${s.body.height} screen, ${f.length} frames, steps OK`);
        await dc.stop();
    } finally {
        xl.kill();
    }
}

/* A C64 BASIC program: 10 SYS2061, then INC $D020 / INC $0400 / JMP */
async function c64() {
    const code = [0xEE, 0x20, 0xD0, 0xEE, 0x00, 0x04, 0x4C, 0x0D, 0x08];
    const prg = Buffer.from([0x01, 0x08, 0x0B, 0x08, 0x0A, 0x00, 0x9E, ...Buffer.from('2061'), 0, 0, 0, ...code]);
    const file = path.join(scratch, 'border.prg');
    fs.writeFileSync(file, prg);
    fs.writeFileSync(path.join(scratch, 'border.lbl'), 'al C:080D .main\nal C:0813 .again\n');
    const cbm = await start(path.join(dev, 'esp32cbm/components/cbm/host/build/cbm_host'), ['c64'],
        { CBM_DEBUG: '17502', CBM_ROMS: path.join(dev, 'esp32cbm/roms') });
    try {
        const { dc, ev } = await session(17502, { program: file, resetFrames: 120 });
        assert.strictEqual(ev.body.reason, 'entry', 'RUN typed, stopped at the SYS address');
        let f = await top(dc);
        assert.strictEqual(f[0].name, 'main');
        const th = await dc.threadsRequest();
        await Promise.all([dc.waitForEvent('stopped'), dc.nextRequest({ threadId: 1 })]);
        await Promise.all([dc.waitForEvent('stopped'), dc.nextRequest({ threadId: 1 })]);
        f = await top(dc);
        assert.strictEqual(f[0].name, 'again');
        const r = await dc.evaluateRequest({ expression: '[$0400]', context: 'watch' });
        console.log(`  C64: threads ${th.body.threads.map((t) => t.name).join(', ')}; RUN typed, [$0400] = ${r.body.result}`);
        await dc.stop();
    } finally {
        cbm.kill();
    }
}

(async () => {
    await atari();
    await c64();
    console.log('real machines: OK');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
