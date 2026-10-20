/*
 * The debugger protocol (esp32emu's docs/debugger.md) over TCP: requests
 * are lines "<id> <command> <args>", answers and events JSON lines.
 */
import * as net from 'net';
import { EventEmitter } from 'events';

export interface RegInfo {
    name: string;
    bits: number;
    flags: number;
    flag_names?: string;
}

export const REG_PC = 1;
export const REG_SP = 2;
export const REG_FLAGS = 4;
export const REG_RO = 8;
export const REG_FLOAT = 16;
/* A REG_FLOAT register with nothing in it (a coprocessor's empty stack register) */
export const FLOAT_EMPTY = 0x7FA00000;

export type Arch = '6502' | '65c816' | 'z80' | '68000' | 'x86';

export interface CpuInfo {
    name: string;
    arch: Arch;
    addr_bits: number;
    regs: RegInfo[];
}

export interface StopInfo {
    reason: string;
    cpu: number;
    pc: number;
    where?: string;
}

export interface Hello {
    protocol: number;
    machine: string | null;
    state: 'none' | 'running' | 'stopped' | 'paused';
    frame: number;
    cpus: CpuInfo[];
    stop?: StopInfo;
}

export interface StoppedEvent extends StopInfo {
    event: 'stopped';
}

export class ProtocolError extends Error {}

interface Pending {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

/*
 * Events: 'stopped' (StoppedEvent), 'continued' ({reason}), 'machine'
 * ({name}), 'close' (), 'log' (text)
 */
export class Connection extends EventEmitter {
    private socket?: net.Socket;
    private buffer = '';
    private nextId = 1;
    private pending = new Map<number, Pending>();
    /* Requests go one at a time: the board's lines are short, answers big */
    private queue: Promise<unknown> = Promise.resolve();
    timeoutMs = 10000;

    connect(host: string, port: number, timeoutMs = 5000): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host, port });
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new ProtocolError(`No answer from ${host}:${port}`));
            }, timeoutMs);
            socket.setNoDelay(true);
            socket.setEncoding('utf8');
            socket.once('connect', () => {
                clearTimeout(timer);
                this.socket = socket;
                resolve();
            });
            socket.once('error', (err) => {
                clearTimeout(timer);
                if (!this.socket) {
                    reject(new ProtocolError(`Can't connect to ${host}:${port}: ${err.message}`));
                }
            });
            socket.on('data', (data: string) => this.receive(data));
            socket.on('close', () => {
                const was = this.socket !== undefined;
                this.socket = undefined;
                for (const p of this.pending.values()) {
                    clearTimeout(p.timer);
                    p.reject(new ProtocolError('The connection closed'));
                }
                this.pending.clear();
                if (was) {
                    this.emit('close');
                }
            });
        });
    }

    get connected(): boolean {
        return this.socket !== undefined;
    }

    close(): void {
        this.socket?.end();
        this.socket?.destroy();
        this.socket = undefined;
    }

    /* A command; its answer (ok: true), or a ProtocolError */
    request<T = any>(command: string): Promise<T> {
        const run = () => this.send<T>(command);
        const p = this.queue.then(run, run);
        this.queue = p.catch(() => undefined);
        return p;
    }

    private send<T>(command: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (!this.socket) {
                reject(new ProtocolError('Not connected'));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ProtocolError(`No answer to "${command.split(' ')[0]}"`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(`${id} ${command}\n`);
        });
    }

    private receive(data: string): void {
        this.buffer += data;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line) {
                this.line(line);
            }
        }
    }

    private line(line: string): void {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            this.emit('log', `Not JSON: ${line}`);
            return;
        }
        if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            if (!p) {
                return;
            }
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) {
                p.resolve(msg);
            } else {
                p.reject(new ProtocolError(msg.error ?? 'failed'));
            }
        } else if (typeof msg.event === 'string') {
            this.emit(msg.event, msg);
        }
    }

    /* ---- The commands ---- */

    hello(): Promise<Hello> {
        return this.request<Hello>('hello');
    }

    async state(): Promise<{ state: Hello['state']; frame: number; stop?: StopInfo }> {
        return this.request('state');
    }

    async regs(cpu: number): Promise<number[]> {
        return (await this.request<{ regs: number[] }>(`regs ${cpu}`)).regs;
    }

    async setReg(cpu: number, name: string, value: number): Promise<number> {
        return (await this.request<{ value: number }>(`setreg ${cpu} ${name} ${value >>> 0}`)).value;
    }

    /* Memory as the CPU sees it, any length (in requests of 4 KB) */
    async read(cpu: number, addr: number, len: number): Promise<Uint8Array> {
        const out = new Uint8Array(len);
        for (let at = 0; at < len; at += 4096) {
            const n = Math.min(4096, len - at);
            const r = await this.request<{ data: string }>(`read ${cpu} ${addr + at} ${n}`);
            out.set(Buffer.from(r.data, 'hex'), at);
        }
        return out;
    }

    async write(cpu: number, addr: number, data: Uint8Array): Promise<void> {
        for (let at = 0; at < data.length; at += 2048) {
            const chunk = Buffer.from(data.subarray(at, at + 2048)).toString('hex');
            await this.request(`write ${cpu} ${addr + at} ${chunk}`);
        }
    }

    async disasm(cpu: number, addr: number, count: number): Promise<[number, string, string][]> {
        const out: [number, string, string][] = [];
        while (count > 0) {
            const n = Math.min(64, count);
            const r = await this.request<{ lines: [number, string, string][] }>(`disasm ${cpu} ${addr} ${n}`);
            out.push(...r.lines);
            if (r.lines.length === 0) {
                break;
            }
            const last = r.lines[r.lines.length - 1];
            addr = last[0] + last[1].length / 2;
            count -= n;
        }
        return out;
    }

    async setBreakpoints(cpu: number, addrs: number[]): Promise<void> {
        await this.request(`bps ${cpu}${addrs.map((a) => ' ' + a).join('')}`);
    }

    async screenSize(): Promise<{ width: number; height: number }> {
        return this.request('screen');
    }

    /* The whole picture, RGB565 */
    async screen(): Promise<{ width: number; height: number; pixels: Uint16Array }> {
        const { width, height } = await this.screenSize();
        const pixels = new Uint16Array(width * height);
        let y = 0;
        while (y < height) {
            const r = await this.request<{ y: number; count: number; data: string }>(`screen ${y} ${height - y}`);
            if (r.count === 0) {
                break;
            }
            const bytes = Buffer.from(r.data, 'base64');
            for (let i = 0; i + 1 < bytes.length && y * width + i / 2 < pixels.length; i += 2) {
                pixels[y * width + i / 2] = bytes[i] | (bytes[i + 1] << 8);
            }
            y += r.count;
        }
        return { width, height, pixels };
    }

    async type(text: string): Promise<void> {
        for (let at = 0; at < text.length; at += 200) {
            await this.request(`type ${Buffer.from(text.slice(at, at + 200), 'latin1').toString('hex')}`);
        }
    }
}
