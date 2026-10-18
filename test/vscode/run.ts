/*
 * The extension inside VS Code (its activation, launch configurations,
 * commands and the screen panel), against esp32emu's demo machine:
 * npm run test:vscode (VSCODE_EXECUTABLE: an installed VS Code; else one is downloaded)
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const root = path.join(__dirname, '..', '..', '..');
    await runTests({
        vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
        extensionDevelopmentPath: root,
        extensionTestsPath: path.join(__dirname, 'suite'),
        launchArgs: [path.join(root, 'test', 'fixtures'), '--disable-extensions', '--skip-welcome',
                     '--skip-release-notes'],
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
