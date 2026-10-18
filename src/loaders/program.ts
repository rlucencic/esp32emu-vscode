/*
 * Programs to load straight into memory, by format: what goes where, and
 * where it starts.
 */
import * as path from 'path';
import { isElf, parseElf } from '../symbols/elf';

export interface Segment {
    addr: number;
    data: Uint8Array;
}

export interface Program {
    format: string;
    segments: Segment[];
    entry?: number;
    /* A Commodore BASIC program (loaded at the start of BASIC): RUN it */
    basic?: { start: number; end: number };
    notes: string[];
}

export type Format = 'auto' | 'raw' | 'prg' | 'xex' | 'tap' | 'amsdos' | 'msx' | 'elf';

export function detectFormat(file: string, bytes: Uint8Array): Exclude<Format, 'auto'> {
    const ext = path.extname(file).toLowerCase();
    if (isElf(bytes)) {
        return 'elf';
    }
    if (ext === '.prg' || ext === '.p00') {
        return 'prg';
    }
    if (ext === '.xex' || ext === '.com' || ext === '.exe' || ext === '.obx') {
        if (bytes[0] === 0xFF && bytes[1] === 0xFF) {
            return 'xex';
        }
    }
    if (ext === '.tap' && !(bytes[0] === 0x5A && bytes[1] === 0x58)) {      /* (not a TZX) */
        return 'tap';
    }
    if (bytes.length >= 128 && amsdosChecksumOk(bytes)) {
        return 'amsdos';
    }
    if (bytes[0] === 0xFE && bytes.length >= 7 && ext !== '.prg') {
        return 'msx';
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFF) {
        return 'xex';
    }
    return 'raw';
}

function word(b: Uint8Array, at: number): number {
    return b[at] | (b[at + 1] << 8);
}

/* A BASIC stub's SYS address: "10 SYS 2061" (token $9E) */
function basicSys(b: Uint8Array, at: number): number | undefined {
    /* line link (2), line number (2), then tokens */
    let i = at + 4;
    const end = Math.min(b.length, at + 80);
    while (i < end && b[i] !== 0x9E && b[i] !== 0) {
        i++;
    }
    if (b[i] !== 0x9E) {
        return undefined;
    }
    i++;
    while (i < end && (b[i] === 0x20 || b[i] === 0x28)) {
        i++;
    }
    let digits = '';
    while (i < end && b[i] >= 0x30 && b[i] <= 0x39) {
        digits += String.fromCharCode(b[i++]);
    }
    return digits ? parseInt(digits, 10) : undefined;
}

function prg(b: Uint8Array): Program {
    if (b.length < 3) {
        throw new Error('a PRG needs a load address and some bytes');
    }
    const addr = word(b, 0);
    const data = b.subarray(2);
    const p: Program = { format: 'prg', segments: [{ addr, data }], entry: addr, notes: [] };
    /* BASIC starts at $0801 (C64), $1C01 (C128), $1001 (VIC-20, Plus/4) */
    if (addr === 0x0801 || addr === 0x1C01 || addr === 0x1001 || addr === 0x0401) {
        p.basic = { start: addr, end: addr + data.length };
        const sys = basicSys(b, 2);
        p.entry = sys;
        p.notes.push(sys !== undefined ? `BASIC program (SYS ${sys})` : 'BASIC program');
    }
    return p;
}

/* Atari DOS binary: $FFFF, then start-end blocks; RUNAD ($02E0) is where it
 * starts. INITAD ($02E2) routines would run during the load: not done here
 */
function xex(b: Uint8Array): Program {
    const p: Program = { format: 'xex', segments: [], notes: [] };
    let i = 0;
    let init: number | undefined;
    while (i + 4 <= b.length) {
        if (b[i] === 0xFF && b[i + 1] === 0xFF) {
            i += 2;
            continue;
        }
        const start = word(b, i);
        const end = word(b, i + 2);
        i += 4;
        if (end < start || i + (end - start + 1) > b.length) {
            throw new Error(`a broken segment at offset ${i - 4}`);
        }
        const data = b.subarray(i, i + end - start + 1);
        i += end - start + 1;
        /* RUNAD and INITAD are taken out, not written */
        const runad = start <= 0x02E0 && end >= 0x02E1 ? word(data, 0x02E0 - start) : undefined;
        const initad = start <= 0x02E2 && end >= 0x02E3 ? word(data, 0x02E2 - start) : undefined;
        if (runad !== undefined) {
            p.entry = runad;
        }
        if (initad !== undefined) {
            init = initad;
        }
        if (start >= 0x02E0 && end <= 0x02E3) {
            continue;
        }
        p.segments.push({ addr: start, data });
    }
    if (init !== undefined) {
        p.notes.push(`INITAD $${init.toString(16).toUpperCase()} isn't run (only RUNAD)`);
        if (p.entry === undefined) {
            p.entry = init;
        }
    }
    if (p.entry === undefined && p.segments.length) {
        p.entry = p.segments[0].addr;
    }
    return p;
}

/* ZX Spectrum .tap: the CODE blocks (a header of type 3, then its data) */
function tap(b: Uint8Array): Program {
    const p: Program = { format: 'tap', segments: [], notes: [] };
    let i = 0;
    let pending: number | undefined;
    while (i + 2 <= b.length) {
        const len = word(b, i);
        const block = b.subarray(i + 2, i + 2 + len);
        i += 2 + len;
        if (block.length < 2) {
            continue;
        }
        if (block[0] === 0x00 && block.length >= 18) {
            pending = block[1] === 3 ? word(block, 14) : undefined;
            if (block[1] === 0) {
                p.notes.push('a BASIC block (left out: load it from the tape)');
            }
        } else if (block[0] === 0xFF && pending !== undefined) {
            p.segments.push({ addr: pending, data: block.subarray(1, block.length - 1) });
            pending = undefined;
        }
    }
    if (!p.segments.length) {
        throw new Error('no CODE blocks in the tape');
    }
    p.entry = p.segments[0].addr;
    return p;
}

function amsdosChecksumOk(b: Uint8Array): boolean {
    let sum = 0;
    for (let i = 0; i < 67; i++) {
        sum += b[i];
    }
    return sum !== 0 && (sum & 0xFFFF) === word(b, 67);
}

/* Amstrad CPC AMSDOS file: a 128-byte header */
function amsdos(b: Uint8Array): Program {
    if (!amsdosChecksumOk(b)) {
        throw new Error('no AMSDOS header');
    }
    const load = word(b, 21);
    const length = word(b, 24);
    const exec = word(b, 26);
    const p: Program = { format: 'amsdos', segments: [{ addr: load, data: b.subarray(128, 128 + length) }],
                         entry: exec, notes: [] };
    if (b[18] !== 2) {
        p.notes.push(`file type ${b[18]} (not binary)`);
    }
    return p;
}

/* MSX BLOAD: $FE, start, end, exec */
function msx(b: Uint8Array): Program {
    const start = word(b, 1);
    const end = word(b, 3);
    const exec = word(b, 5);
    return { format: 'msx', segments: [{ addr: start, data: b.subarray(7, 7 + end - start + 1) }],
             entry: exec, notes: [] };
}

export function parseProgram(file: string, bytes: Uint8Array, format: Format = 'auto',
                             loadAddress?: number): Program {
    let f = format === 'auto' ? detectFormat(file, bytes) : format;
    /* A load address given: raw bytes, unless the file says what it is */
    if (format === 'auto' && loadAddress !== undefined && (f === 'msx' || f === 'amsdos')) {
        f = 'raw';
    }
    switch (f) {
    case 'prg': return prg(bytes);
    case 'xex': return xex(bytes);
    case 'tap': return tap(bytes);
    case 'amsdos': return amsdos(bytes);
    case 'msx': return msx(bytes);
    case 'elf': {
        const e = parseElf(bytes, path.dirname(file));
        return { format: 'elf', segments: e.segments, entry: e.entry, notes: [] };
    }
    default:
        if (loadAddress === undefined) {
            throw new Error(`${path.basename(file)}: a raw program needs a loadAddress`);
        }
        return { format: 'raw', segments: [{ addr: loadAddress, data: bytes }], entry: loadAddress, notes: [] };
    }
}
