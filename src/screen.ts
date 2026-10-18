/*
 * The machine's screen in a panel beside the editor: taken at every stop,
 * and once a second while the machine runs and the panel is visible.
 */
import * as vscode from 'vscode';

export class ScreenPanel {
    private static current: ScreenPanel | undefined;
    private timer: NodeJS.Timeout | undefined;
    private busy = false;
    private disposed = false;

    static show(session: vscode.DebugSession): ScreenPanel {
        if (ScreenPanel.current) {
            ScreenPanel.current.session = session;
            ScreenPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
            void ScreenPanel.current.refresh();
            return ScreenPanel.current;
        }
        const panel = vscode.window.createWebviewPanel('esp32emu.screen', 'Machine screen',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true });
        ScreenPanel.current = new ScreenPanel(panel, session);
        return ScreenPanel.current;
    }

    /* A stop: a fresh picture; running: one a second (while live) */
    static setRunning(session: vscode.DebugSession, running: boolean): void {
        const p = ScreenPanel.current;
        if (p && p.session.id === session.id) {
            p.running = running;
            void p.refresh();
        }
    }

    static sessionEnded(session: vscode.DebugSession): void {
        const p = ScreenPanel.current;
        if (p && p.session.id === session.id) {
            p.stopTimer();
            void p.panel.webview.postMessage({ kind: 'status', text: 'The debug session ended' });
        }
    }

    private constructor(private panel: vscode.WebviewPanel, private session: vscode.DebugSession) {
        panel.webview.html = this.html();
        panel.onDidDispose(() => {
            this.disposed = true;
            this.stopTimer();
            ScreenPanel.current = undefined;
        });
        panel.webview.onDidReceiveMessage((m) => {
            if (m.kind === 'refresh') {
                void this.refresh();
            } else if (m.kind === 'live') {
                this.setLive(Boolean(m.on));
            }
        });
        panel.onDidChangeViewState(() => {
            if (!panel.visible) {
                this.stopTimer();
            } else {
                void this.refresh();
            }
        });
        void this.refresh();
    }

    private live = true;
    private running = true;

    private setLive(on: boolean): void {
        this.live = on;
        if (!on) {
            this.stopTimer();
        } else {
            void this.refresh();
        }
    }

    private stopTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    async refresh(): Promise<void> {
        if (this.busy || this.disposed) {
            return;
        }
        this.busy = true;
        this.stopTimer();
        try {
            const r = await this.session.customRequest('esp32emu.screen');
            await this.panel.webview.postMessage({ kind: 'frame', ...r });
            this.panel.title = `${r.machine ?? 'Machine'} screen`;
        } catch (e) {
            await this.panel.webview.postMessage({ kind: 'status', text: (e as Error).message });
        } finally {
            this.busy = false;
        }
        if (this.live && this.running && this.panel.visible && !this.disposed) {
            this.timer = setTimeout(() => void this.refresh(), 1000);
        }
    }

    private html(): string {
        const nonce = Math.random().toString(36).slice(2);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 8px; font: 12px var(--vscode-font-family); color: var(--vscode-foreground); }
  .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           border: none; padding: 3px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  canvas { width: 100%; image-rendering: pixelated; background: #000; display: block; }
  #status { opacity: 0.75; }
</style>
</head>
<body>
<div class="bar">
  <button id="refresh">Refresh</button>
  <label><input type="checkbox" id="live" checked> Live while running</label>
  <span id="status"></span>
</div>
<canvas id="screen" width="320" height="200"></canvas>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const status = document.getElementById('status');
  document.getElementById('refresh').onclick = () => vscode.postMessage({ kind: 'refresh' });
  document.getElementById('live').onchange = (e) => vscode.postMessage({ kind: 'live', on: e.target.checked });
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.kind === 'status') { status.textContent = m.text; return; }
    if (m.kind !== 'frame') { return; }
    const bin = atob(m.data);
    const w = m.width, h = m.height;
    /* Wide pictures (ST medium, the IIGS's 640) have pixels twice as tall */
    const rows = w / h > 2 ? 2 : 1;
    canvas.width = w;
    canvas.height = h * rows;
    const img = ctx.createImageData(w, h * rows);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 2;
        const v = bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8);
        const r = ((v >> 11) & 31) * 255 / 31, g = ((v >> 5) & 63) * 255 / 63, b = (v & 31) * 255 / 31;
        for (let k = 0; k < rows; k++) {
          const o = (((y * rows + k) * w) + x) * 4;
          img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    status.textContent = w + ' x ' + h + ', ' + new Date().toLocaleTimeString();
  });
</script>
</body>
</html>`;
    }
}
