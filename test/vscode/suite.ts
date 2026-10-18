/* Runs inside VS Code's extension host (see run.ts) */
import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const root = path.join(__dirname, '..', '..', '..');
const fixtures = path.join(root, 'test', 'fixtures');
const demo = process.env.ESP32EMU_DEMO ?? path.join(root, '..', 'esp32emu', 'components', 'emudbg', 'test', 'build', 'demo');

function waitFor<T>(what: string, setup: (done: (v: T) => void) => vscode.Disposable, ms = 20000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { d.dispose(); reject(new Error(`no ${what}`)); }, ms);
        const d = setup((v) => { clearTimeout(timer); d.dispose(); resolve(v); });
    });
}

export async function run(): Promise<void> {
    const ext = vscode.extensions.getExtension('rlucencic.esp32emu-debug');
    assert.ok(ext, 'the extension is there');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const c of ['esp32emu.showScreen', 'esp32emu.typeText', 'esp32emu.reset', 'esp32emu.runFrames']) {
        assert.ok(commands.includes(c), `command ${c}`);
    }
    if (!fs.existsSync(demo)) {
        console.log('(no demo machine: the debugging part is skipped)');
        return;
    }
    const port = 19000 + Math.floor(Math.random() * 500);
    const machine: ChildProcess = spawn(demo, ['6502', String(port)], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));

    /* The adapter's 'stopped' events, as VS Code sees them */
    const stops: { reason: string }[] = [];
    vscode.debug.registerDebugAdapterTrackerFactory('esp32emu', {
        createDebugAdapterTracker: () => ({
            onDidSendMessage: (m) => {
                if (m.type === 'event' && m.event === 'stopped') {
                    stops.push(m.body);
                }
            },
        }),
    });
    const stopped = async (n: number) => {
        for (let i = 0; i < 200 && stops.length < n; i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(stops.length >= n, `stop ${n}`);
        return stops[n - 1];
    };
    try {
        const source = vscode.Uri.file(path.join(fixtures, 'hello.s'));
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(source, new vscode.Position(10, 0)))]);
        const started = waitFor<vscode.DebugSession>('session', (done) => vscode.debug.onDidStartDebugSession(done));
        const ok = await vscode.debug.startDebugging(undefined, {
            type: 'esp32emu', request: 'launch', name: 'test', host: '127.0.0.1', port,
            program: path.join(fixtures, 'hello.xex'), stopOnEntry: true, resetFrames: 2, showScreen: true,
        });
        assert.ok(ok, 'started');
        const session = await started;
        assert.strictEqual((await stopped(1)).reason, 'entry');

        const st = await session.customRequest('stackTrace', { threadId: 1 });
        assert.strictEqual(st.stackFrames[0].line, 5);
        await session.customRequest('continue', { threadId: 1 });
        assert.strictEqual((await stopped(2)).reason, 'breakpoint');
        const st2 = await session.customRequest('stackTrace', { threadId: 1 });
        assert.strictEqual(st2.stackFrames[0].line, 11);

        /* The screen panel opened (showScreen) and shows the demo's picture */
        await new Promise((r) => setTimeout(r, 1500));
        const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
        assert.ok(tabs.some((t) => /screen/i.test(t)), `a screen tab among ${tabs.join(', ')}`);

        await vscode.commands.executeCommand('workbench.action.debug.stop');
        await new Promise((r) => setTimeout(r, 500));
        console.log('VS Code: activation, commands, launch, breakpoint, screen panel: OK');
    } finally {
        machine.kill();
    }
}
