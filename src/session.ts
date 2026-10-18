/*
 * The debug adapter: VS Code's Debug Adapter Protocol on one side, the
 * machine's debugger (esp32emu's docs/debugger.md) on the other. Each of
 * the machine's CPUs is a thread; source lines and labels come from the
 * program's symbol files.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    Breakpoint, ContinuedEvent, Event, Handles, InitializedEvent, InvalidatedEvent, LoggingDebugSession, OutputEvent,
    Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, ThreadEvent,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Connection, CpuInfo, Hello, REG_FLAGS, REG_PC, REG_RO, REG_SP, StopInfo } from './connection';
import { evaluate, ExprError, isPlainName, parseNumber } from './expr';
import { Format, parseProgram, Program } from './loaders/program';
import { findSymbolFiles, loadSymbolFile, SymbolTable } from './symbols';
import { fileKey } from './symbols/table';

export interface SymbolSpec {
    file: string;
    cpu?: number | string;
    offset?: number | string;
}

export interface Esp32emuArgs {
    request?: 'launch' | 'attach';
    host?: string;
    port?: number;
    program?: string;
    format?: Format;
    loadAddress?: number | string;
    entry?: number | string;
    cpu?: number | string;
    symbols?: string | (string | SymbolSpec)[];
    sourceRoot?: string;
    reset?: boolean;
    resetFrames?: number;
    typeAfterLoad?: string;
    stopOnEntry?: boolean;
    disk?: { file: string; drive?: number };
    stackScan?: boolean;
    showScreen?: boolean;
}

type LaunchArgs = DebugProtocol.LaunchRequestArguments & Esp32emuArgs;
type AttachArgs = DebugProtocol.AttachRequestArguments & Esp32emuArgs;

interface Bp {
    id: number;
    cpu: number;
    addr: number;
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
    hits: number;
}

type VarRef =
    | { kind: 'regs'; cpu: number }
    | { kind: 'flags'; cpu: number; reg: number }
    | { kind: 'stack'; cpu: number };

/* Where to stop after an internal run (launch, line steps) */
interface Waiter {
    resolve: (s: StopInfo) => void;
}

function hex(v: number, digits: number): string {
    return '$' + (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

/* A number or "$1234" / "0x1234" from launch.json */
function argNumber(v: number | string | undefined): number | undefined {
    if (v === undefined || v === '') {
        return undefined;
    }
    if (typeof v === 'number') {
        return v;
    }
    return parseNumber(v.trim());
}

export class Esp32emuSession extends LoggingDebugSession {
    private conn = new Connection();
    private hello?: Hello;
    private args: Esp32emuArgs = {};
    private symbols: SymbolTable[] = [];
    private regs = new Map<number, number[]>();
    private lastStop?: StopInfo;
    private running = true;
    private waiter?: Waiter;
    private ready = false;              /* breakpoints go to the machine once the launch is done */
    private bpId = 1;
    private sourceBps = new Map<string, Bp[]>();
    private functionBps: Bp[] = [];
    private instructionBps: Bp[] = [];
    private sentBps = new Map<number, string>();
    private varRefs = new Handles<VarRef>();
    private frames = new Map<number, number>();     /* frame id -> cpu */
    private nextFrameId = 1;
    private launchedProgram?: Program;
    private warnedMachine = false;

    constructor() {
        super();
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
        this.conn.on('stopped', (e: StopInfo) => this.onStopped(e));
        this.conn.on('continued', () => {
            this.running = true;
            this.regs.clear();
            this.output('The machine was paused on the board (setup screen): it runs to the end of its frame.\n');
            this.sendEvent(new ContinuedEvent(1, true));
        });
        this.conn.on('machine', () => this.onMachine());
        this.conn.on('close', () => {
            this.output('The connection to the machine closed.\n', 'stderr');
            this.sendEvent(new TerminatedEvent());
        });
        this.conn.on('log', (t: string) => this.output(t + '\n', 'console'));
    }

    /* For the extension's commands (the screen, typing) */
    get connection(): Connection {
        return this.conn;
    }

    private output(text: string, category: 'console' | 'stdout' | 'stderr' | 'important' = 'console'): void {
        this.sendEvent(new OutputEvent(text, category));
    }

    private cpu(i: number): CpuInfo {
        const c = this.hello?.cpus[i];
        if (!c) {
            throw new Error(`no CPU ${i}`);
        }
        return c;
    }

    private cpuIndex(v: number | string | undefined): number {
        if (v === undefined) {
            return 0;
        }
        if (typeof v === 'number') {
            return v;
        }
        const i = this.hello?.cpus.findIndex((c) => c.name.toLowerCase() === v.toLowerCase()) ?? -1;
        if (i < 0) {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n)) {
                return n;
            }
            throw new Error(`no CPU "${v}" (the machine has ${this.hello?.cpus.map((c) => c.name).join(', ')})`);
        }
        return i;
    }

    private addrDigits(cpu: number): number {
        return (this.hello?.cpus[cpu]?.addr_bits ?? 16) > 16 ? 6 : 4;
    }

    private addrMask(cpu: number): number {
        const bits = this.hello?.cpus[cpu]?.addr_bits ?? 16;
        return bits >= 32 ? 0xFFFFFFFF : (1 << bits) - 1;
    }

    private table(cpu: number): SymbolTable {
        let t = this.symbols[cpu];
        if (!t) {
            t = new SymbolTable();
            this.symbols[cpu] = t;
        }
        return t;
    }

    /* "main+3" or "$1234" */
    private addrName(cpu: number, addr: number): string {
        const l = this.table(cpu).nearestLabel(addr);
        if (l) {
            return l.offset ? `${l.name}+${l.offset}` : l.name;
        }
        return hex(addr, this.addrDigits(cpu));
    }

    private source(file: string): Source {
        return new Source(path.basename(file), this.convertDebuggerPathToClient(file));
    }

    /* ---- Registers ---- */

    private async getRegs(cpu: number): Promise<number[]> {
        let r = this.regs.get(cpu);
        if (!r) {
            r = await this.conn.regs(cpu);
            this.regs.set(cpu, r);
        }
        return r;
    }

    private regIndex(cpu: number, flag: number): number {
        return this.cpu(cpu).regs.findIndex((r) => r.flags & flag);
    }

    private async pc(cpu: number): Promise<number> {
        const r = await this.getRegs(cpu);
        return r[Math.max(0, this.regIndex(cpu, REG_PC))];
    }

    private bigEndian(cpu: number): boolean {
        return this.cpu(cpu).arch === '68000';
    }

    private async readValue(cpu: number, addr: number, size: 1 | 2 | 4): Promise<number> {
        const b = await this.conn.read(cpu, addr & this.addrMask(cpu), size);
        let v = 0;
        for (let i = 0; i < size; i++) {
            v = this.bigEndian(cpu) ? (v * 256) + b[i] : v + b[i] * 2 ** (8 * i);
        }
        return v >>> 0;
    }

    /* Registers, flags and labels for an expression */
    private async evalContext(cpu: number) {
        const info = this.cpu(cpu);
        const regs = this.running ? undefined : await this.getRegs(cpu);
        const table = this.table(cpu);
        return {
            register: (name: string) => {
                if (!regs) {
                    return undefined;
                }
                const i = info.regs.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
                if (i >= 0) {
                    return regs[i];
                }
                /* a flag by its letter: "C", "Z" */
                if (name.length === 1) {
                    for (let k = 0; k < info.regs.length; k++) {
                        const r = info.regs[k];
                        const at = r.flag_names?.toUpperCase().indexOf(name.toUpperCase()) ?? -1;
                        if (r.flag_names && at >= 0 && name !== '-') {
                            return (regs[k] >> (r.flag_names.length - 1 - at)) & 1;
                        }
                    }
                }
                return undefined;
            },
            label: (name: string) => table.label(name) ?? table.label('_' + name),
            read: (addr: number, size: 1 | 2 | 4) => this.readValue(cpu, addr, size),
        };
    }

    /* ---- Breakpoints ---- */

    private allBps(): Bp[] {
        return [...[...this.sourceBps.values()].flat(), ...this.functionBps, ...this.instructionBps];
    }

    /* Each CPU's addresses to the machine (only what changed) */
    private async syncBreakpoints(): Promise<void> {
        if (!this.ready || !this.hello) {
            return;
        }
        const byCpu = new Map<number, Set<number>>();
        for (let i = 0; i < this.hello.cpus.length; i++) {
            byCpu.set(i, new Set());
        }
        for (const bp of this.allBps()) {
            byCpu.get(bp.cpu)?.add(bp.addr);
        }
        for (const [cpu, addrs] of byCpu) {
            const list = [...addrs].sort((a, b) => a - b);
            const key = list.join(',');
            if (this.sentBps.get(cpu) !== key) {
                await this.conn.setBreakpoints(cpu, list.slice(0, 128));
                this.sentBps.set(cpu, key);
                if (list.length > 128) {
                    this.output(`Only 128 breakpoints per CPU: ${list.length - 128} left out.\n`, 'stderr');
                }
            }
        }
    }

    private cpuForSource(file: string): number {
        for (let i = 0; i < this.symbols.length; i++) {
            if (this.symbols[i]?.hasFile(file)) {
                return i;
            }
        }
        return this.cpuIndex(this.args.cpu);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse,
                                          args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        const file = args.source.path ? this.convertClientPathToDebugger(args.source.path) : '';
        const cpu = file ? this.cpuForSource(file) : 0;
        const bps: Bp[] = [];
        const result: DebugProtocol.Breakpoint[] = [];
        for (const sb of args.breakpoints ?? []) {
            const found = file ? this.table(cpu).addrsForLine(file, sb.line) : undefined;
            if (!found) {
                const b = new Breakpoint(false, sb.line) as DebugProtocol.Breakpoint;
                b.message = this.table(cpu).size ? 'No code on this line (or no symbols for this file)'
                    : 'No symbols: give the program\'s .dbg, .sld, .elf or label file in "symbols"';
                result.push(b);
                continue;
            }
            const id = this.bpId++;
            for (const addr of found.addrs) {
                bps.push({ id, cpu, addr, condition: sb.condition, hitCondition: sb.hitCondition,
                           logMessage: sb.logMessage, hits: 0 });
            }
            const b = new Breakpoint(true, found.line, undefined, this.source(file)) as DebugProtocol.Breakpoint;
            b.id = id;
            b.instructionReference = '0x' + found.addrs[0].toString(16);
            result.push(b);
        }
        this.sourceBps.set(fileKey(file), bps);
        try {
            await this.syncBreakpoints();
        } catch (e) {
            this.output(`Breakpoints: ${(e as Error).message}\n`, 'stderr');
        }
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse,
                                                  args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<void> {
        this.functionBps = [];
        const result: DebugProtocol.Breakpoint[] = [];
        for (const fb of args.breakpoints) {
            /* "name", "cpu:name", or an address */
            let cpu = this.cpuIndex(this.args.cpu);
            let name = fb.name.trim();
            const colon = name.lastIndexOf(':');
            if (colon > 0 && this.hello) {
                try {
                    cpu = this.cpuIndex(name.slice(0, colon));
                    name = name.slice(colon + 1);
                } catch {
                    /* (a name with a colon) */
                }
            }
            const t = this.table(cpu);
            const addr = parseNumber(name) ?? t.label(name) ?? t.label('_' + name);
            if (addr === undefined) {
                const b = new Breakpoint(false) as DebugProtocol.Breakpoint;
                b.message = `No label "${name}"`;
                result.push(b);
                continue;
            }
            const id = this.bpId++;
            this.functionBps.push({ id, cpu, addr, condition: fb.condition, hitCondition: fb.hitCondition, hits: 0 });
            const line = t.lineAt(addr);
            const b = (line ? new Breakpoint(true, line.line, undefined, this.source(line.file))
                : new Breakpoint(true)) as DebugProtocol.Breakpoint;
            b.id = id;
            b.instructionReference = '0x' + addr.toString(16);
            result.push(b);
        }
        await this.syncBreakpoints().catch((e) => this.output(`Breakpoints: ${e.message}\n`, 'stderr'));
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    protected async setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse,
                                                     args: DebugProtocol.SetInstructionBreakpointsArguments):
                                                     Promise<void> {
        this.instructionBps = [];
        const result: DebugProtocol.Breakpoint[] = [];
        const cpu = this.lastStop?.cpu ?? this.cpuIndex(this.args.cpu);
        for (const ib of args.breakpoints) {
            const base = parseNumber(ib.instructionReference) ?? Number(ib.instructionReference);
            const addr = (base + (ib.offset ?? 0)) & this.addrMask(cpu);
            const id = this.bpId++;
            this.instructionBps.push({ id, cpu, addr, condition: ib.condition, hitCondition: ib.hitCondition, hits: 0 });
            const b = new Breakpoint(true) as DebugProtocol.Breakpoint;
            b.id = id;
            b.instructionReference = '0x' + addr.toString(16);
            result.push(b);
        }
        await this.syncBreakpoints().catch((e) => this.output(`Breakpoints: ${e.message}\n`, 'stderr'));
        response.body = { breakpoints: result };
        this.sendResponse(response);
    }

    /* A stop at breakpoints with conditions, hit counts, log messages: go on? */
    private async shouldStop(stop: StopInfo): Promise<boolean> {
        const here = this.allBps().filter((b) => b.cpu === stop.cpu && b.addr === stop.pc);
        if (!here.length) {
            return true;
        }
        let stop_ = false;
        for (const bp of here) {
            bp.hits++;
            if (bp.hitCondition) {
                const h = bp.hitCondition.trim();
                const m = /^(>=|<=|==|>|<|%)?\s*(\d+)$/.exec(h);
                if (m) {
                    const n = parseInt(m[2], 10);
                    const ok = m[1] === '%' ? bp.hits % n === 0 : m[1] === '==' ? bp.hits === n
                        : m[1] === '>' ? bp.hits > n : m[1] === '<' ? bp.hits < n : m[1] === '<=' ? bp.hits <= n
                            : bp.hits >= n;
                    if (!ok) {
                        continue;
                    }
                }
            }
            if (bp.condition) {
                try {
                    if (!(await evaluate(bp.condition, await this.evalContext(stop.cpu)))) {
                        continue;
                    }
                } catch (e) {
                    this.output(`Breakpoint condition "${bp.condition}": ${(e as Error).message}\n`, 'stderr');
                }
            }
            if (bp.logMessage) {
                this.output(await this.interpolate(bp.logMessage, stop.cpu) + '\n', 'stdout');
                continue;
            }
            stop_ = true;
        }
        return stop_;
    }

    /* A log message's {expressions} */
    private async interpolate(text: string, cpu: number): Promise<string> {
        const ctx = await this.evalContext(cpu);
        let out = '';
        let at = 0;
        for (const m of text.matchAll(/\{([^}]+)\}/g)) {
            out += text.slice(at, m.index);
            try {
                const v = await evaluate(m[1], ctx);
                out += hex(v, v > 0xFFFF ? 6 : v > 0xFF ? 4 : 2);
            } catch (e) {
                out += `<${(e as Error).message}>`;
            }
            at = (m.index ?? 0) + m[0].length;
        }
        return out + text.slice(at);
    }

    /* ---- Stops ---- */

    private async onStopped(e: StopInfo): Promise<void> {
        this.running = false;
        this.lastStop = e;
        this.regs.clear();
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            w.resolve(e);
            return;
        }
        if (e.reason === 'breakpoint' && !(await this.shouldStop(e))) {
            this.running = true;
            this.regs.clear();
            await this.conn.request('continue').catch(() => undefined);
            return;
        }
        this.report(e);
    }

    private report(e: StopInfo, reason?: string): void {
        const map: Record<string, string> = { breakpoint: 'breakpoint', step: 'step', pause: 'pause',
                                              frames: 'pause', entry: 'entry' };
        const ev = new StoppedEvent(reason ?? map[e.reason] ?? 'pause', e.cpu + 1) as DebugProtocol.StoppedEvent;
        ev.body.allThreadsStopped = true;
        if (e.where) {
            ev.body.description = `${this.cpu(e.cpu).name} at ${this.addrName(e.cpu, e.pc)}: ${e.where}`;
        }
        if (e.reason === 'breakpoint') {
            const ids = this.allBps().filter((b) => b.cpu === e.cpu && b.addr === e.pc).map((b) => b.id);
            ev.body.hitBreakpointIds = [...new Set(ids)];
        }
        this.sendEvent(ev);
        this.varRefsFresh();
        this.sendEvent(new Event('esp32emu.stopped', e));
    }

    /* Variables and frames of the stop before are gone */
    private varRefsFresh(): void {
        this.varRefs.reset();
        this.frames.clear();
    }

    private setRunning(): void {
        this.running = true;
        this.regs.clear();
        this.sendEvent(new Event('esp32emu.running'));
    }

    /* Run a command that lets the machine go, and wait for its stop here */
    private runAndWait(command: string, timeoutMs = 60000): Promise<StopInfo> {
        return new Promise<StopInfo>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = undefined;
                reject(new Error(`The machine didn't stop (${command})`));
            }, timeoutMs);
            this.waiter = {
                resolve: (s) => {
                    clearTimeout(timer);
                    resolve(s);
                },
            };
            this.setRunning();
            this.conn.request(command).catch((e) => {
                clearTimeout(timer);
                this.waiter = undefined;
                reject(e);
            });
        });
    }

    private async onMachine(): Promise<void> {
        /* The machine was started again: other CPUs perhaps, no breakpoints */
        try {
            const old = this.hello?.cpus.length ?? 0;
            this.hello = await this.conn.hello();
            this.sentBps.clear();
            this.regs.clear();
            this.output(`The machine started again: ${this.hello.machine}\n`);
            for (let i = 0; i < Math.max(old, this.hello.cpus.length); i++) {
                this.sendEvent(new ThreadEvent(i < this.hello.cpus.length ? 'started' : 'exited', i + 1));
            }
            await this.syncBreakpoints();
            this.running = this.hello.state !== 'stopped';
        } catch (e) {
            this.output(`${(e as Error).message}\n`, 'stderr');
        }
    }

    /* ---- Requests ---- */

    protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
        response.body = {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: true,
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsDisassembleRequest: true,
            supportsInstructionBreakpoints: true,
            supportsSteppingGranularity: true,
            supportsFunctionBreakpoints: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: true,
            supportsLogPoints: true,
            supportsRestartRequest: true,
            supportsCompletionsRequest: true,
            supportsTerminateRequest: false,
            supportsValueFormattingOptions: false,
        };
        this.sendResponse(response);
    }

    private async open(args: Esp32emuArgs): Promise<void> {
        this.args = args;
        const host = args.host || '127.0.0.1';
        const port = args.port ?? 6502;
        await this.conn.connect(host, port);
        this.hello = await this.conn.hello();
        if (this.hello.protocol !== 1) {
            this.output(`The machine speaks protocol ${this.hello.protocol}; this extension knows 1.\n`, 'stderr');
        }
        if (this.hello.state === 'none') {
            throw new Error(`The machine at ${host} isn't running yet (its setup screen is open): start it first.`);
        }
        this.output(`${this.hello.machine} at ${host}:${port}: ${this.hello.cpus.map((c) => `${c.name} (${c.arch})`)
            .join(', ')}\n`);
        this.loadSymbols(args);
    }

    private loadSymbols(args: Esp32emuArgs): void {
        this.symbols = [];
        const specs: SymbolSpec[] = [];
        const given = args.symbols === undefined ? [] : Array.isArray(args.symbols) ? args.symbols : [args.symbols];
        for (const s of given) {
            specs.push(typeof s === 'string' ? { file: s } : s);
        }
        if (!specs.length && args.program) {
            for (const f of findSymbolFiles(args.program)) {
                specs.push({ file: f });
            }
        }
        for (const s of specs) {
            try {
                const cpu = this.cpuIndex(s.cpu ?? args.cpu);
                const t = loadSymbolFile(s.file, args.sourceRoot);
                this.table(cpu).merge(t, argNumber(s.offset) ?? 0);
                this.output(`Symbols: ${path.basename(s.file)} (${this.cpu(cpu).name}): ${t.labelNames().length} labels, `
                    + `${t.files.size} source files\n`);
            } catch (e) {
                this.output(`Symbols: ${s.file}: ${(e as Error).message}\n`, 'stderr');
            }
        }
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs): Promise<void> {
        try {
            await this.open({ ...args, request: 'launch' });
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        } catch (e) {
            this.sendErrorResponse(response, 1001, (e as Error).message);
        }
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachArgs): Promise<void> {
        try {
            await this.open({ ...args, request: 'attach' });
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        } catch (e) {
            this.sendErrorResponse(response, 1002, (e as Error).message);
        }
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
        this.sendResponse(response);
        if (this.args.showScreen) {
            this.sendEvent(new Event('esp32emu.showScreen'));
        }
        try {
            if (this.args.request === 'launch' && this.args.program) {
                await this.loadProgram();
            } else {
                this.ready = true;
                await this.syncBreakpoints();
                const st = await this.conn.state();
                if (st.state === 'stopped' && st.stop) {
                    this.running = false;
                    this.lastStop = st.stop;
                    this.report(st.stop);
                } else if (this.args.stopOnEntry) {
                    await this.conn.request('pause');
                }
            }
        } catch (e) {
            this.output(`${(e as Error).message}\n`, 'stderr');
            this.sendEvent(new TerminatedEvent());
        }
    }

    /* Reset (or stop) the machine, put the program in, start it */
    private async loadProgram(): Promise<void> {
        const args = this.args;
        const file = args.program as string;
        const bytes = new Uint8Array(fs.readFileSync(file));
        const program = parseProgram(file, bytes, args.format ?? 'auto', argNumber(args.loadAddress));
        this.launchedProgram = program;
        const cpu = this.cpuIndex(args.cpu);
        const machine = this.hello?.machine ?? '';

        if (args.disk) {
            await this.uploadDisk(args.disk.file, args.disk.drive ?? 0);
        }
        this.ready = false;
        if (args.reset !== false) {
            this.output(`Resetting the ${machine}\n`);
            await this.conn.request('reset');
            const frames = args.resetFrames ?? 150;
            await this.runAndWait(`frames ${Math.max(1, frames)}`, 30000 + frames * 100);
        } else {
            const st = await this.conn.state();
            if (st.state !== 'stopped') {
                await this.runAndWait('pause');
            }
        }
        for (const seg of program.segments) {
            await this.conn.write(cpu, seg.addr, seg.data);
        }
        const size = program.segments.reduce((n, s) => n + s.data.length, 0);
        this.output(`Loaded ${path.basename(file)} (${program.format}, ${size} bytes${program.notes.length ? ', '
            + program.notes.join(', ') : ''})\n`);

        /* Where it starts: given, the format's, or BASIC's RUN */
        let entry: number | undefined;
        let typed = args.typeAfterLoad;
        if (args.entry !== undefined && args.entry !== 'none') {
            entry = argNumber(args.entry) ?? this.table(cpu).label(String(args.entry))
                ?? this.table(cpu).label('_' + String(args.entry));
            if (entry === undefined) {
                throw new Error(`entry: no address or label "${args.entry}"`);
            }
        } else if (args.entry !== 'none') {
            if (program.basic && /commodore/i.test(machine) && typed === undefined) {
                await this.setBasicEnd(cpu, program.basic, /128/.test(machine));
                typed = 'run\n';           /* (as on a PC keyboard: the Commodore's capitals) */
            } else {
                entry = program.entry;
            }
        }
        if (entry !== undefined) {
            await this.conn.setReg(cpu, this.cpu(cpu).regs[this.regIndex(cpu, REG_PC)].name, entry);
        }
        this.regs.clear();
        this.ready = true;
        this.sentBps.clear();

        let stopAt: number | undefined;
        if (args.stopOnEntry) {
            stopAt = entry ?? (program.basic ? program.entry : undefined);
            if (entry !== undefined && typed === undefined) {
                /* It's there now */
                await this.syncBreakpoints();
                const pc = await this.pc(cpu);
                this.lastStop = { reason: 'entry', cpu, pc };
                this.running = false;
                this.report(this.lastStop, 'entry');
                return;
            }
        }
        if (stopAt !== undefined) {
            /* Stop where it starts: a breakpoint there until then */
            this.instructionBps.push({ id: -1, cpu, addr: stopAt, hits: 0 });
        }
        await this.syncBreakpoints();
        if (typed) {
            await this.conn.type(typed);
        }
        this.running = true;
        if (stopAt !== undefined) {
            const s = await this.runAndWait('continue', 120000);
            this.instructionBps = this.instructionBps.filter((b) => b.id !== -1);
            await this.syncBreakpoints();
            this.report(s, s.pc === stopAt ? 'entry' : undefined);
        } else {
            await this.conn.request('continue');
        }
    }

    /* Commodore BASIC: the program's end (VARTAB, ARYTAB, STREND; the C128's TEXT_TOP) */
    private async setBasicEnd(cpu: number, basic: { start: number; end: number }, c128: boolean): Promise<void> {
        const end = new Uint8Array([basic.end & 0xFF, basic.end >> 8]);
        if (c128) {
            await this.conn.write(cpu, 0x1210, end);
        } else {
            for (const at of [0x2D, 0x2F, 0x31]) {
                await this.conn.write(cpu, at, end);
            }
        }
    }

    /* The board's web API: upload the image, put it in the drive */
    private async uploadDisk(file: string, drive: number): Promise<void> {
        const host = this.args.host || '127.0.0.1';
        const name = path.basename(file);
        const body = fs.readFileSync(file);
        this.output(`Uploading ${name} to ${host} (drive ${drive})\n`);
        let r = await fetch(`http://${host}/disks/${encodeURIComponent(name)}`, { method: 'PUT', body });
        if (!r.ok) {
            throw new Error(`Uploading ${name}: ${r.status} ${await r.text()}`);
        }
        r = await fetch(`http://${host}/api/drive/${drive}`, { method: 'PUT', body: name });
        if (!r.ok) {
            throw new Error(`Inserting ${name}: ${r.status} ${await r.text()}`);
        }
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = { threads: (this.hello?.cpus ?? []).map((c, i) => new Thread(i + 1, c.name)) };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse,
                                      args: DebugProtocol.StackTraceArguments): Promise<void> {
        const cpu = args.threadId - 1;
        try {
            const pc = await this.pc(cpu);
            const frames: StackFrame[] = [this.frame(cpu, pc, 0)];
            if (this.args.stackScan !== false) {
                const callers = await this.scanStack(cpu).catch(() => []);
                callers.forEach((a, i) => frames.push(this.frame(cpu, a, i + 1)));
            }
            const start = args.startFrame ?? 0;
            const count = args.levels ? args.levels : frames.length;
            response.body = { stackFrames: frames.slice(start, start + count), totalFrames: frames.length };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1003, (e as Error).message);
        }
    }

    private frame(cpu: number, addr: number, depth: number): StackFrame {
        const id = this.nextFrameId++;
        this.frames.set(id, cpu);
        const line = this.table(cpu).lineAt(addr);
        const name = this.addrName(cpu, addr);
        const f = new StackFrame(id, depth ? `${name} (caller)` : name,
            line ? this.source(line.file) : undefined, line?.line ?? 0, 1) as DebugProtocol.StackFrame;
        f.instructionPointerReference = '0x' + addr.toString(16);
        if (depth) {
            f.presentationHint = 'subtle';
        }
        return f;
    }

    /* Likely callers: return addresses on the stack just after a call */
    private async scanStack(cpu: number): Promise<number[]> {
        const info = this.cpu(cpu);
        const regs = await this.getRegs(cpu);
        const sp = regs[this.regIndex(cpu, REG_SP)];
        const out: number[] = [];
        const read = (a: number, n: number) => this.conn.read(cpu, a & this.addrMask(cpu), n);
        const at = async (a: number) => (await read(a, 1))[0];
        switch (info.arch) {
        case '6502': {
            const page = await read(0x100, 256);
            for (let s = (sp & 0xFF) + 1; s < 0xFF && out.length < 12; s++) {
                const ret = (page[s] | (page[s + 1] << 8)) + 1;
                if (await at(ret - 3) === 0x20) {
                    out.push(ret - 3);
                    s++;
                }
            }
            break;
        }
        case '65c816': {
            const pbr = regs[info.regs.findIndex((r) => r.name === 'PBR')] ?? 0;
            const st = await read(sp + 1, 48);
            for (let i = 0; i + 1 < st.length && out.length < 12; i++) {
                const w = st[i] | (st[i + 1] << 8);
                if (i + 2 < st.length) {
                    const long = (st[i + 2] << 16 | w) + 1;
                    if (await at(long - 4) === 0x22) {
                        out.push(long - 4);
                        i += 2;
                        continue;
                    }
                }
                const ret = (pbr << 16) | ((w + 1) & 0xFFFF);
                const op = await at(ret - 3);
                if (op === 0x20 || op === 0xFC) {
                    out.push(ret - 3);
                    i++;
                }
            }
            break;
        }
        case 'z80': {
            const st = await read(sp, 48);
            for (let i = 0; i + 1 < st.length && out.length < 12; i += 2) {
                const ret = st[i] | (st[i + 1] << 8);
                const call = await read(ret - 3, 3);
                if (call[0] === 0xCD || (call[0] & 0xC7) === 0xC4) {
                    out.push((ret - 3) & 0xFFFF);
                } else if ((call[2] & 0xC7) === 0xC7) {
                    out.push((ret - 1) & 0xFFFF);
                }
            }
            break;
        }
        case '68000': {
            const st = await read(sp, 96);
            for (let i = 0; i + 3 < st.length && out.length < 12; i += 2) {
                const ret = ((st[i] << 24) | (st[i + 1] << 16) | (st[i + 2] << 8) | st[i + 3]) >>> 0;
                if (ret & 1 || ret > 0xFFFFFF || ret < 8) {
                    continue;
                }
                const b = await read(ret - 6, 6);
                const w = (k: number) => (b[k] << 8) | b[k + 1];
                const w2 = w(4), w4 = w(2), w6 = w(0);
                if ((w2 & 0xFFF8) === 0x4E90 || ((w2 & 0xFF00) === 0x6100 && (w2 & 0xFF) !== 0 && (w2 & 0xFF) !== 0xFF)) {
                    out.push(ret - 2);
                } else if (w4 === 0x6100 || w4 === 0x4EB8 || w4 === 0x4EBA || (w4 & 0xFFF8) === 0x4EA8) {
                    out.push(ret - 4);
                } else if (w6 === 0x4EB9) {
                    out.push(ret - 6);
                } else {
                    continue;
                }
                i += 2;
            }
            break;
        }
        }
        return out;
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        const cpu = this.frames.get(args.frameId) ?? 0;
        response.body = {
            scopes: [
                new Scope('Registers', this.varRefs.create({ kind: 'regs', cpu }), false),
                new Scope('Stack', this.varRefs.create({ kind: 'stack', cpu }), true),
            ],
        };
        this.sendResponse(response);
    }

    private regValue(cpu: number, i: number, v: number): string {
        const r = this.cpu(cpu).regs[i];
        if (r.bits === 1) {
            return String(v);
        }
        const digits = Math.ceil(r.bits / 4);
        let s = hex(v, digits);
        if (r.flags & REG_FLAGS && r.flag_names) {
            const names = r.flag_names;
            const set = [...names].map((c, k) => (c !== '-' && (v >> (names.length - 1 - k)) & 1 ? c : c === '-'
                ? '' : '.')).join('');
            s += `  ${set}`;
        } else if (r.name === 'cycles') {
            s = String(v);
        } else if (r.bits >= 16 && this.table(cpu).labelsAt(v).length) {
            s += `  ${this.table(cpu).labelsAt(v)[0]}`;
        }
        return s;
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse,
                                     args: DebugProtocol.VariablesArguments): Promise<void> {
        const ref = this.varRefs.get(args.variablesReference);
        try {
            if (!ref || this.running) {
                response.body = { variables: [] };
            } else if (ref.kind === 'regs') {
                const regs = await this.getRegs(ref.cpu);
                const info = this.cpu(ref.cpu);
                response.body = {
                    variables: info.regs.map((r, i): DebugProtocol.Variable => ({
                        name: r.name,
                        value: this.regValue(ref.cpu, i, regs[i]),
                        evaluateName: r.name,
                        variablesReference: r.flags & REG_FLAGS && r.flag_names
                            ? this.varRefs.create({ kind: 'flags', cpu: ref.cpu, reg: i }) : 0,
                        memoryReference: r.bits >= 16 && !(r.flags & REG_FLAGS) && r.name !== 'cycles'
                            ? '0x' + (regs[i] & this.addrMask(ref.cpu)).toString(16) : undefined,
                        presentationHint: r.flags & REG_RO ? { attributes: ['readOnly'] } : undefined,
                    })),
                };
            } else if (ref.kind === 'flags') {
                const regs = await this.getRegs(ref.cpu);
                const r = this.cpu(ref.cpu).regs[ref.reg];
                const names = r.flag_names ?? '';
                const v = regs[ref.reg];
                response.body = {
                    variables: [...names].map((c, k) => ({ c, bit: names.length - 1 - k }))
                        .filter((f) => f.c !== '-')
                        .map((f): DebugProtocol.Variable => ({
                            name: f.c, value: String((v >> f.bit) & 1), evaluateName: f.c, variablesReference: 0,
                        })),
                };
            } else {
                response.body = { variables: await this.stackVariables(ref.cpu) };
            }
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1004, (e as Error).message);
        }
    }

    /* The top of the stack, a byte (6502, 65C816) or word (Z80) or long (68000) per row */
    private async stackVariables(cpu: number): Promise<DebugProtocol.Variable[]> {
        const info = this.cpu(cpu);
        const regs = await this.getRegs(cpu);
        const sp = regs[this.regIndex(cpu, REG_SP)];
        const size = info.arch === '68000' ? 4 : info.arch === 'z80' ? 2 : 1;
        const first = info.arch === '6502' ? 0x100 + ((sp + 1) & 0xFF) : info.arch === '65c816' ? sp + 1 : sp;
        const count = info.arch === '6502' ? Math.min(16, 0xFF - (sp & 0xFF)) : 16;
        if (count <= 0) {
            return [];
        }
        const bytes = await this.conn.read(cpu, first & this.addrMask(cpu), count * size);
        const out: DebugProtocol.Variable[] = [];
        for (let i = 0; i < count; i++) {
            let v = 0;
            for (let k = 0; k < size; k++) {
                v = this.bigEndian(cpu) ? v * 256 + bytes[i * size + k] : v + bytes[i * size + k] * 2 ** (8 * k);
            }
            const addr = (first + i * size) & this.addrMask(cpu);
            const label = size > 1 ? this.table(cpu).nearestLabel(v, 0x100) : undefined;
            out.push({
                name: hex(addr, this.addrDigits(cpu)),
                value: hex(v, size * 2) + (label ? `  ${label.name}${label.offset ? '+' + label.offset : ''}` : ''),
                variablesReference: 0,
                memoryReference: '0x' + addr.toString(16),
            });
        }
        return out;
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse,
                                       args: DebugProtocol.SetVariableArguments): Promise<void> {
        const ref = this.varRefs.get(args.variablesReference);
        try {
            if (!ref || ref.kind === 'stack') {
                throw new Error('can\'t be changed here: use the memory view');
            }
            const ctx = await this.evalContext(ref.cpu);
            const v = await evaluate(args.value, ctx);
            const info = this.cpu(ref.cpu);
            let regIndex: number;
            let value: number;
            if (ref.kind === 'regs') {
                regIndex = info.regs.findIndex((r) => r.name === args.name);
                value = v;
            } else {
                regIndex = ref.reg;
                const regs = await this.getRegs(ref.cpu);
                const names = info.regs[regIndex].flag_names ?? '';
                const bit = names.length - 1 - names.indexOf(args.name);
                value = v ? regs[regIndex] | (1 << bit) : regs[regIndex] & ~(1 << bit);
            }
            const set = await this.conn.setReg(ref.cpu, info.regs[regIndex].name, value);
            this.regs.delete(ref.cpu);
            response.body = { value: ref.kind === 'regs' ? this.regValue(ref.cpu, regIndex, set) : String(v ? 1 : 0) };
            this.sendResponse(response);
            this.sendEvent(new InvalidatedEvent(['variables']));
        } catch (e) {
            this.sendErrorResponse(response, 1005, (e as Error).message);
        }
    }

    /* ---- Running ---- */

    private threadCpu(threadId: number | undefined): number {
        return threadId ? threadId - 1 : this.lastStop?.cpu ?? 0;
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
        this.setRunning();
        response.body = { allThreadsContinued: true };
        this.sendResponse(response);
        await this.conn.request('continue').catch((e) => this.output(`${e.message}\n`, 'stderr'));
    }

    protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
        this.sendResponse(response);
        await this.conn.request('pause').catch((e) => this.output(`${e.message}\n`, 'stderr'));
    }

    /* A step: an instruction, or source lines (until the line changes) */
    private async step(command: 'step' | 'next' | 'out', threadId: number,
                       granularity?: DebugProtocol.SteppingGranularity): Promise<void> {
        const cpu = this.threadCpu(threadId);
        const table = this.table(cpu);
        const startPc = await this.pc(cpu);
        const from = granularity === 'instruction' || command === 'out' ? undefined : table.lineAt(startPc);
        let s = await this.runAndWait(`${command} ${cpu}`);
        for (let n = 0; from && s.reason === 'step' && n < 2000; n++) {
            const now = table.lineAt(s.pc);
            if (!now || now.file !== from.file || now.line !== from.line) {
                break;
            }
            s = await this.runAndWait(`${command} ${cpu}`);
        }
        if (s.reason === 'breakpoint' && !(await this.shouldStop(s))) {
            /* (a condition false on the way: on to the next stop) */
            this.running = true;
            await this.conn.request('continue');
            return;
        }
        this.report(s);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this.sendResponse(response);
        this.step('next', args.threadId, args.granularity).catch((e) => this.stepFailed(e));
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.sendResponse(response);
        this.step('step', args.threadId, args.granularity).catch((e) => this.stepFailed(e));
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.sendResponse(response);
        this.step('out', args.threadId, args.granularity).catch((e) => this.stepFailed(e));
    }

    private stepFailed(e: Error): void {
        this.output(`${e.message}\n`, 'stderr');
        /* The machine runs on (a step out of the top level never ends): pause shows where it is */
    }

    protected async restartRequest(response: DebugProtocol.RestartResponse): Promise<void> {
        try {
            if (this.args.request === 'launch' && this.args.program) {
                this.sendEvent(new ContinuedEvent(1, true));
                await this.loadProgram();
            } else {
                await this.conn.request('reset');
            }
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1006, (e as Error).message);
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse): Promise<void> {
        try {
            if (this.conn.connected) {
                await this.conn.request('detach');
            }
        } catch {
            /* (gone already) */
        }
        this.conn.removeAllListeners('close');
        this.conn.close();
        this.sendResponse(response);
    }

    /* ---- Expressions ---- */

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse,
                                    args: DebugProtocol.EvaluateArguments): Promise<void> {
        const cpu = args.frameId !== undefined ? this.frames.get(args.frameId) ?? 0 : this.lastStop?.cpu ?? 0;
        const expr = args.expression.trim();
        try {
            /* The debug console: ">command" goes to the machine as it is */
            if (args.context === 'repl' && expr.startsWith('>')) {
                const r = await this.conn.request(expr.slice(1).trim());
                delete r.id;
                delete r.ok;
                response.body = { result: JSON.stringify(r), variablesReference: 0 };
                this.sendResponse(response);
                return;
            }
            const table = this.table(cpu);
            const ctx = await this.evalContext(cpu);
            const v = await evaluate(expr, ctx);
            const digits = v > 0xFFFF ? 6 : v > 0xFF ? 4 : 2;
            let result = `${hex(v, digits)} (${v})`;
            /* A label: its address and what's there */
            if (isPlainName(expr) && ctx.register(expr) === undefined) {
                const b = await this.readValue(cpu, v, 1);
                result = `${hex(v, this.addrDigits(cpu))}  [${hex(v, this.addrDigits(cpu))}] = ${hex(b, 2)}`;
            } else if (table.labelsAt(v).length) {
                result += `  ${table.labelsAt(v)[0]}`;
            }
            response.body = {
                result,
                variablesReference: 0,
                memoryReference: v >= 0 && v <= this.addrMask(cpu) ? '0x' + v.toString(16) : undefined,
            };
            this.sendResponse(response);
        } catch (e) {
            if (args.context === 'hover') {
                this.sendErrorResponse(response, 1007, '');
                return;
            }
            this.sendErrorResponse(response, 1007, e instanceof ExprError ? e.message : (e as Error).message);
        }
    }

    protected completionsRequest(response: DebugProtocol.CompletionsResponse,
                                 args: DebugProtocol.CompletionsArguments): void {
        const cpu = args.frameId !== undefined ? this.frames.get(args.frameId) ?? 0 : this.lastStop?.cpu ?? 0;
        const before = args.text.slice(0, args.column - 1);
        const word = /[\w.@']*$/.exec(before)?.[0] ?? '';
        const names = [
            ...(this.hello?.cpus[cpu]?.regs.map((r) => r.name) ?? []),
            ...this.table(cpu).labelNames(),
        ].filter((n) => n.toLowerCase().startsWith(word.toLowerCase())).slice(0, 200);
        response.body = {
            targets: names.map((n) => ({ label: n, start: before.length - word.length, length: word.length })),
        };
        this.sendResponse(response);
    }

    /* ---- Memory and disassembly ---- */

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse,
                                      args: DebugProtocol.ReadMemoryArguments): Promise<void> {
        const cpu = this.lastStop?.cpu ?? this.cpuIndex(this.args.cpu);
        try {
            const base = (parseNumber(args.memoryReference) ?? Number(args.memoryReference)) + (args.offset ?? 0);
            const mask = this.addrMask(cpu);
            const start = Math.max(0, base);
            const count = Math.max(0, Math.min(args.count, mask + 1 - start, 65536));
            const data = count ? await this.conn.read(cpu, start, count) : new Uint8Array(0);
            response.body = {
                address: '0x' + start.toString(16),
                data: Buffer.from(data).toString('base64'),
                unreadableBytes: args.count - count,
            };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1008, (e as Error).message);
        }
    }

    protected async writeMemoryRequest(response: DebugProtocol.WriteMemoryResponse,
                                       args: DebugProtocol.WriteMemoryArguments): Promise<void> {
        const cpu = this.lastStop?.cpu ?? this.cpuIndex(this.args.cpu);
        try {
            const addr = (parseNumber(args.memoryReference) ?? Number(args.memoryReference)) + (args.offset ?? 0);
            const data = Buffer.from(args.data, 'base64');
            await this.conn.write(cpu, addr, data);
            response.body = { bytesWritten: data.length };
            this.sendResponse(response);
            this.sendEvent(new InvalidatedEvent(['variables']));
        } catch (e) {
            this.sendErrorResponse(response, 1009, (e as Error).message);
        }
    }

    protected async disassembleRequest(response: DebugProtocol.DisassembleResponse,
                                       args: DebugProtocol.DisassembleArguments): Promise<void> {
        const cpu = this.lastStop?.cpu ?? this.cpuIndex(this.args.cpu);
        try {
            const base = ((parseNumber(args.memoryReference) ?? Number(args.memoryReference)) + (args.offset ?? 0))
                & this.addrMask(cpu);
            const off = args.instructionOffset ?? 0;
            const count = args.instructionCount;
            let lines: [number, string, string][];
            if (off < 0) {
                const before = await this.disassembleBefore(cpu, base, -off);
                const after = count + off > 0 ? await this.conn.disasm(cpu, base, count + off) : [];
                lines = [...before, ...after];
            } else {
                const skip = off ? await this.conn.disasm(cpu, base, off) : [];
                const last = skip[skip.length - 1];
                const from = last ? last[0] + last[1].length / 2 : base;
                lines = await this.conn.disasm(cpu, from, count);
            }
            lines = lines.slice(0, count);
            const table = this.table(cpu);
            const digits = this.addrDigits(cpu);
            response.body = {
                instructions: lines.map(([addr, bytes, text]): DebugProtocol.DisassembledInstruction => {
                    const line = table.lineAt(addr);
                    const labels = table.labelsAt(addr);
                    return {
                        address: '0x' + addr.toString(16).padStart(digits, '0'),
                        instructionBytes: bytes.replace(/(..)(?!$)/g, '$1 ').toUpperCase(),
                        instruction: text,
                        symbol: labels[0],
                        location: line ? this.source(line.file) : undefined,
                        line: line?.line,
                    };
                }),
            };
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1010, (e as Error).message);
        }
    }

    /* n instructions that end where `addr` begins: disassemble from a bit
     * before and keep the start that falls in step with it
     */
    private async disassembleBefore(cpu: number, addr: number, n: number): Promise<[number, string, string][]> {
        const arch = this.cpu(cpu).arch;
        const maxLen = arch === '68000' ? 10 : 4;
        const align = arch === '68000' ? 2 : 1;
        const known = this.table(cpu);
        let best: [number, string, string][] = [];
        for (let tries = 0; tries < 6; tries++) {
            let start = addr - n * (arch === '68000' ? 4 : 3) - tries * align;
            if (arch === '68000') {
                start &= ~1;
            }
            /* a known instruction start (a source line) nearby is a better start */
            for (let a = start; a > start - 16 && tries === 0; a--) {
                if (known.lineAt(a) && a >= 0) {
                    start = a;
                    break;
                }
            }
            if (start < 0) {
                start = 0;
            }
            const lines = await this.conn.disasm(cpu, start, Math.min(256, Math.ceil((addr - start) / align) + 1));
            const at = lines.findIndex((l) => l[0] === addr);
            if (at >= 0) {
                best = lines.slice(0, at);
                break;
            }
            const before = lines.filter((l) => l[0] < addr);
            if (before.length > best.length) {
                best = before;
            }
        }
        best = best.slice(-n);
        /* Not enough: blanks before */
        const pad: [number, string, string][] = [];
        const first = best.length ? best[0][0] : addr;
        for (let i = n - best.length; i > 0; i--) {
            pad.push([Math.max(0, first - i * (maxLen > 4 ? 2 : 1)), '', '??']);
        }
        return [...pad, ...best];
    }

    /* ---- The extension's own requests ---- */

    protected async customRequest(command: string, response: DebugProtocol.Response, args: any): Promise<void> {
        try {
            switch (command) {
            case 'esp32emu.screen': {
                const s = await this.conn.screen();
                response.body = { width: s.width, height: s.height,
                                  data: Buffer.from(s.pixels.buffer, s.pixels.byteOffset, s.pixels.byteLength)
                                      .toString('base64'),
                                  machine: this.hello?.machine };
                break;
            }
            case 'esp32emu.type':
                await this.conn.type(String(args?.text ?? ''));
                break;
            case 'esp32emu.reset':
                await this.conn.request('reset');
                break;
            case 'esp32emu.frames':
                this.setRunning();
                this.sendEvent(new ContinuedEvent(1, true));
                await this.conn.request(`frames ${Number(args?.frames) || 1}`);
                break;
            default:
                super.customRequest(command, response, args);
                return;
            }
            this.sendResponse(response);
        } catch (e) {
            this.sendErrorResponse(response, 1011, (e as Error).message);
        }
    }
}
