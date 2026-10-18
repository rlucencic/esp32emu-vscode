/*
 * The extension: the debug adapter runs inside it (inline), launch
 * configurations find the boards on the network, and commands show the
 * machine's screen and type on its keyboard.
 */
import * as vscode from 'vscode';
import { findBoards } from './discovery';
import { ScreenPanel } from './screen';
import { Esp32emuSession } from './session';

class AdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new Esp32emuSession());
    }
}

/* Pick a board found over mDNS, the desktop build, or an address */
async function pickHost(): Promise<{ host: string; port: number } | undefined> {
    const boards = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Looking for esp32emu boards…' },
        () => findBoards());
    type Item = vscode.QuickPickItem & { host?: string; port?: number; other?: boolean };
    const items: Item[] = boards.map((b) => ({
        label: b.machine,
        description: `${b.host}:${b.port}`,
        detail: b.address,
        host: b.host,
        port: b.port,
    }));
    items.push({ label: 'Desktop build', description: '127.0.0.1:6502', host: '127.0.0.1', port: 6502 });
    items.push({ label: 'Another address…', other: true });
    const pick = await vscode.window.showQuickPick(items, {
        title: boards.length ? 'Debug which machine?' : 'No boards found on the network',
        placeHolder: 'A board, or the desktop build',
    });
    if (!pick) {
        return undefined;
    }
    if (pick.other) {
        const text = await vscode.window.showInputBox({ prompt: 'host or host:port', value: 'atari-xl.local' });
        if (!text) {
            return undefined;
        }
        const [host, port] = text.split(':');
        return { host, port: port ? Number(port) : 6502 };
    }
    return { host: pick.host as string, port: pick.port as number };
}

class ConfigurationProvider implements vscode.DebugConfigurationProvider {
    async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined,
                                    config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
        /* F5 without a launch.json: attach to a board */
        if (!config.type && !config.request && !config.name) {
            config.type = 'esp32emu';
            config.request = 'attach';
            config.name = 'Attach';
        }
        if (!config.host) {
            const picked = await pickHost();
            if (!picked) {
                return undefined;
            }
            config.host = picked.host;
            config.port = config.port ?? picked.port;
        }
        return config;
    }
}

function esp32emuSession(): vscode.DebugSession | undefined {
    const s = vscode.debug.activeDebugSession;
    if (!s || s.type !== 'esp32emu') {
        void vscode.window.showWarningMessage('No esp32emu debug session is running.');
        return undefined;
    }
    return s;
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('esp32emu', new AdapterFactory()),
        vscode.debug.registerDebugConfigurationProvider('esp32emu', new ConfigurationProvider()),
        vscode.debug.registerDebugConfigurationProvider('esp32emu', {
            provideDebugConfigurations: () => [{
                type: 'esp32emu', request: 'attach', name: 'Attach to a board', host: '',
            }],
        }, vscode.DebugConfigurationProviderTriggerKind.Dynamic),

        vscode.commands.registerCommand('esp32emu.showScreen', () => {
            const s = esp32emuSession();
            if (s) {
                ScreenPanel.show(s);
            }
        }),
        vscode.commands.registerCommand('esp32emu.typeText', async () => {
            const s = esp32emuSession();
            if (!s) {
                return;
            }
            const text = await vscode.window.showInputBox({
                prompt: 'Text to type on the machine (\\n is Return)', value: 'RUN\\n',
            });
            if (text) {
                await s.customRequest('esp32emu.type', { text: text.replace(/\\n/g, '\n') });
            }
        }),
        vscode.commands.registerCommand('esp32emu.reset', async () => {
            const s = esp32emuSession();
            if (s) {
                await s.customRequest('esp32emu.reset');
            }
        }),
        vscode.commands.registerCommand('esp32emu.runFrames', async () => {
            const s = esp32emuSession();
            if (!s) {
                return;
            }
            const n = await vscode.window.showInputBox({ prompt: 'Frames to run, then stop', value: '1' });
            if (n && Number(n) > 0) {
                await s.customRequest('esp32emu.frames', { frames: Number(n) });
            }
        }),

        vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
            if (e.session.type !== 'esp32emu') {
                return;
            }
            if (e.event === 'esp32emu.stopped') {
                ScreenPanel.setRunning(e.session, false);
            } else if (e.event === 'esp32emu.running') {
                ScreenPanel.setRunning(e.session, true);
            } else if (e.event === 'esp32emu.showScreen') {
                ScreenPanel.show(e.session);
            }
        }),
        vscode.debug.onDidTerminateDebugSession((s) => ScreenPanel.sessionEnded(s)),
    );
}

export function deactivate(): void {
    /* (the sessions end with VS Code's) */
}
