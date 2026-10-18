/*
 * Symbols and source lines of one CPU's program: labels by name and by
 * address, source lines by address and addresses by source line.
 */
import * as path from 'path';

export interface SourceLine {
    file: string;           /* absolute, normalised */
    line: number;           /* 1-based */
}

interface LineEntry extends SourceLine {
    addr: number;
    size: number;           /* bytes of code (0: unknown) */
}

/* File names as keys: case-insensitive where the file system usually is */
export function fileKey(file: string): string {
    const p = path.normalize(file);
    return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

export class SymbolTable {
    private labels = new Map<string, number>();
    private labelsLower = new Map<string, number>();
    private byAddr = new Map<number, string[]>();
    private sortedLabels: { addr: number; name: string }[] | undefined;
    private lines: LineEntry[] = [];
    private sortedLines: LineEntry[] | undefined;
    private byFile = new Map<string, Map<number, number[]>>();
    readonly files = new Set<string>();

    get size(): number {
        return this.labels.size + this.lines.length;
    }

    addLabel(name: string, addr: number): void {
        if (!name) {
            return;
        }
        this.labels.set(name, addr);
        this.labelsLower.set(name.toLowerCase(), addr);
        const names = this.byAddr.get(addr);
        if (names) {
            if (!names.includes(name)) {
                names.push(name);
            }
        } else {
            this.byAddr.set(addr, [name]);
        }
        this.sortedLabels = undefined;
    }

    addLine(file: string, line: number, addr: number, size = 0): void {
        const entry: LineEntry = { file: path.normalize(file), line, addr, size };
        this.lines.push(entry);
        this.sortedLines = undefined;
        const key = fileKey(file);
        this.files.add(entry.file);
        let lines = this.byFile.get(key);
        if (!lines) {
            lines = new Map();
            this.byFile.set(key, lines);
        }
        const addrs = lines.get(line);
        if (addrs) {
            if (!addrs.includes(addr)) {
                addrs.push(addr);
            }
        } else {
            lines.set(line, [addr]);
        }
    }

    /* Everything of another table, addresses moved by offset */
    merge(other: SymbolTable, offset = 0): void {
        for (const [name, addr] of other.labels) {
            this.addLabel(name, addr + offset);
        }
        for (const l of other.lines) {
            this.addLine(l.file, l.line, l.addr + offset, l.size);
        }
    }

    label(name: string): number | undefined {
        return this.labels.get(name) ?? this.labelsLower.get(name.toLowerCase());
    }

    labelsAt(addr: number): string[] {
        return this.byAddr.get(addr) ?? [];
    }

    /* The label at or before addr: "loop+3" (within maxOffset) */
    nearestLabel(addr: number, maxOffset = 0x400): { name: string; offset: number } | undefined {
        if (!this.sortedLabels) {
            this.sortedLabels = [...this.byAddr.entries()]
                .map(([a, names]) => ({ addr: a, name: names[0] }))
                .sort((x, y) => x.addr - y.addr);
        }
        const list = this.sortedLabels;
        let lo = 0;
        let hi = list.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].addr <= addr) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best < 0 || addr - list[best].addr > maxOffset) {
            return undefined;
        }
        return { name: list[best].name, offset: addr - list[best].addr };
    }

    /* Labels whose names start with a prefix (completions) */
    labelNames(): string[] {
        return [...this.labels.keys()];
    }

    /* The source line of the code at addr: an exact start, or inside a
     * line whose size is known
     */
    lineAt(addr: number): SourceLine | undefined {
        if (!this.sortedLines) {
            this.sortedLines = [...this.lines].sort((a, b) => a.addr - b.addr || b.size - a.size);
        }
        const list = this.sortedLines;
        let lo = 0;
        let hi = list.length - 1;
        let best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].addr <= addr) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        /* The first entry at that address (several lines may share it: a
         * C line and its assembler line; prefer the one listed first)
         */
        while (best > 0 && list[best - 1].addr === list[best].addr) {
            best--;
        }
        if (best < 0) {
            return undefined;
        }
        const e = list[best];
        if (e.addr === addr || (e.size > 0 && addr < e.addr + e.size)) {
            return { file: e.file, line: e.line };
        }
        return undefined;
    }

    /* The addresses of a source line, or of the next line with code
     * (within 50 lines): where a breakpoint on it goes
     */
    addrsForLine(file: string, line: number): { line: number; addrs: number[] } | undefined {
        const lines = this.byFile.get(fileKey(file));
        if (!lines) {
            return undefined;
        }
        for (let l = line; l < line + 50; l++) {
            const addrs = lines.get(l);
            if (addrs && addrs.length) {
                return { line: l, addrs: [...addrs] };
            }
        }
        return undefined;
    }

    hasFile(file: string): boolean {
        return this.byFile.has(fileKey(file));
    }
}
