/*
 * ELF files (m68k-elf-gcc, vasm -Felf, llvm-mos, ...): the symbol table,
 * the source lines from DWARF's .debug_line (versions 2 to 5), and the
 * loadable segments.
 */
import * as path from 'path';
import { SymbolTable } from './table';

export interface ElfSegment {
    addr: number;
    data: Uint8Array;
}

export interface ElfFile {
    entry: number;
    segments: ElfSegment[];
    symbols: SymbolTable;
}

class Reader {
    pos = 0;
    constructor(readonly buf: Buffer, readonly le: boolean) {}

    u8(): number {
        return this.buf[this.pos++];
    }

    u16(): number {
        const v = this.le ? this.buf.readUInt16LE(this.pos) : this.buf.readUInt16BE(this.pos);
        this.pos += 2;
        return v;
    }

    u32(): number {
        const v = this.le ? this.buf.readUInt32LE(this.pos) : this.buf.readUInt32BE(this.pos);
        this.pos += 4;
        return v;
    }

    u64(): number {
        const v = this.le ? this.buf.readBigUInt64LE(this.pos) : this.buf.readBigUInt64BE(this.pos);
        this.pos += 8;
        return Number(v);
    }

    uN(bytes: number): number {
        switch (bytes) {
        case 1: return this.u8();
        case 2: return this.u16();
        case 4: return this.u32();
        default: return this.u64();
        }
    }

    uleb(): number {
        let v = 0;
        let shift = 0;
        for (;;) {
            const b = this.u8();
            v += (b & 0x7F) * 2 ** shift;
            shift += 7;
            if (!(b & 0x80)) {
                return v;
            }
        }
    }

    sleb(): number {
        let v = 0;
        let shift = 0;
        let b: number;
        do {
            b = this.u8();
            v += (b & 0x7F) * 2 ** shift;
            shift += 7;
        } while (b & 0x80);
        if (b & 0x40) {
            v -= 2 ** shift;
        }
        return v;
    }

    cstr(): string {
        const end = this.buf.indexOf(0, this.pos);
        const s = this.buf.toString('utf8', this.pos, end < 0 ? this.buf.length : end);
        this.pos = end < 0 ? this.buf.length : end + 1;
        return s;
    }
}

function cstrAt(buf: Buffer | undefined, offset: number): string {
    if (!buf || offset >= buf.length) {
        return '';
    }
    const end = buf.indexOf(0, offset);
    return buf.toString('utf8', offset, end < 0 ? buf.length : end);
}

export function isElf(bytes: Uint8Array): boolean {
    return bytes.length > 52 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46;
}

interface Section {
    name: string;
    type: number;
    offset: number;
    size: number;
    link: number;
}

export function parseElf(bytes: Uint8Array, baseDir: string): ElfFile {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!isElf(bytes)) {
        throw new Error('not an ELF file');
    }
    const is64 = buf[4] === 2;
    const r = new Reader(buf, buf[5] === 1);
    const word = is64 ? 8 : 4;
    r.pos = 24;
    const entry = r.uN(word);
    const phoff = r.uN(word);
    const shoff = r.uN(word);
    r.pos += 4;                                     /* e_flags */
    r.pos += 2;                                     /* e_ehsize */
    const phentsize = r.u16();
    const phnum = r.u16();
    const shentsize = r.u16();
    const shnum = r.u16();
    const shstrndx = r.u16();

    /* Program headers: PT_LOAD with bytes in the file */
    const segments: ElfSegment[] = [];
    for (let i = 0; i < phnum; i++) {
        r.pos = phoff + i * phentsize;
        const type = r.u32();
        let offset: number, paddr: number, filesz: number;
        if (is64) {
            r.pos += 4;                             /* p_flags */
            offset = r.u64();
            r.pos += 8;                             /* p_vaddr */
            paddr = r.u64();
            filesz = r.u64();
        } else {
            offset = r.u32();
            r.pos += 4;                             /* p_vaddr */
            paddr = r.u32();
            filesz = r.u32();
        }
        if (type === 1 && filesz > 0) {
            segments.push({ addr: paddr, data: new Uint8Array(buf.subarray(offset, offset + filesz)) });
        }
    }

    /* Section headers */
    const sections: Section[] = [];
    const names: number[] = [];
    for (let i = 0; i < shnum; i++) {
        r.pos = shoff + i * shentsize;
        names.push(r.u32());
        const type = r.u32();
        r.pos += word;                              /* sh_flags */
        r.pos += word;                              /* sh_addr */
        const offset = r.uN(word);
        const size = r.uN(word);
        const link = r.u32();
        sections.push({ name: '', type, offset, size, link });
    }
    const shstr = sections[shstrndx];
    for (let i = 0; i < sections.length; i++) {
        sections[i].name = shstr ? cstrAt(buf.subarray(shstr.offset, shstr.offset + shstr.size), names[i]) : '';
    }
    const data = (name: string) => {
        const s = sections.find((x) => x.name === name);
        return s ? buf.subarray(s.offset, s.offset + s.size) : undefined;
    };

    const table = new SymbolTable();
    /* Symbols: functions, objects and plain labels that are defined */
    const symtab = sections.find((s) => s.type === 2);
    if (symtab) {
        const strtab = sections[symtab.link];
        const strs = strtab ? buf.subarray(strtab.offset, strtab.offset + strtab.size) : undefined;
        const entsize = is64 ? 24 : 16;
        for (let off = symtab.offset; off + entsize <= symtab.offset + symtab.size; off += entsize) {
            r.pos = off;
            let name: number, value: number, info: number, shndx: number;
            if (is64) {
                name = r.u32();
                info = r.u8();
                r.u8();
                shndx = r.u16();
                value = r.u64();
            } else {
                name = r.u32();
                value = r.u32();
                r.u32();                            /* st_size */
                info = r.u8();
                r.u8();
                shndx = r.u16();
            }
            const type = info & 15;
            if (shndx !== 0 && (type === 0 || type === 1 || type === 2)) {
                const s = cstrAt(strs, name);
                if (s && !s.startsWith('$') && !s.startsWith('.L')) {
                    table.addLabel(s, value);
                }
            }
        }
    }

    const line = data('.debug_line');
    if (line) {
        parseDebugLine(line, r.le, data('.debug_line_str'), data('.debug_str'), baseDir, table);
    }
    return { entry, segments, symbols: table };
}

/* ---- DWARF .debug_line ---- */

const DW_FORM_block = 0x09, DW_FORM_data1 = 0x0b, DW_FORM_data2 = 0x05, DW_FORM_data4 = 0x06,
    DW_FORM_data8 = 0x07, DW_FORM_data16 = 0x1e, DW_FORM_string = 0x08, DW_FORM_strp = 0x0e,
    DW_FORM_line_strp = 0x1f, DW_FORM_udata = 0x0f, DW_FORM_strx = 0x1a, DW_FORM_strx1 = 0x25,
    DW_FORM_strx2 = 0x26, DW_FORM_strx4 = 0x28;

function parseDebugLine(buf: Buffer, le: boolean, lineStr: Buffer | undefined, str: Buffer | undefined,
                        baseDir: string, table: SymbolTable): void {
    const r = new Reader(buf, le);
    while (r.pos + 4 < buf.length) {
        let unitLength = r.u32();
        let offsetSize = 4;
        if (unitLength === 0xFFFFFFFF) {
            unitLength = r.u64();
            offsetSize = 8;
        }
        const unitEnd = r.pos + unitLength;
        const version = r.u16();
        if (version < 2 || version > 5) {
            r.pos = unitEnd;
            continue;
        }
        let addressSize = 4;
        if (version >= 5) {
            addressSize = r.u8();
            r.u8();                                 /* segment selector size */
        }
        const headerLength = r.uN(offsetSize);
        const programStart = r.pos + headerLength;
        const minInst = r.u8();
        if (version >= 4) {
            r.u8();                                 /* maximum operations per instruction */
        }
        r.u8();                                     /* default_is_stmt */
        const lineBase = (r.u8() << 24) >> 24;
        const lineRange = r.u8();
        const opcodeBase = r.u8();
        const opLengths = [0];
        for (let i = 1; i < opcodeBase; i++) {
            opLengths.push(r.u8());
        }

        const dirs: string[] = [];
        const files: { name: string; dir: number }[] = [];
        const form = (f: number): string | number => {
            switch (f) {
            case DW_FORM_string: return r.cstr();
            case DW_FORM_line_strp: return cstrAt(lineStr, r.uN(offsetSize));
            case DW_FORM_strp: return cstrAt(str, r.uN(offsetSize));
            case DW_FORM_udata: return r.uleb();
            case DW_FORM_data1: return r.u8();
            case DW_FORM_data2: return r.u16();
            case DW_FORM_data4: return r.u32();
            case DW_FORM_data8: return r.u64();
            case DW_FORM_data16: r.pos += 16; return 0;
            case DW_FORM_block: { const n = r.uleb(); r.pos += n; return 0; }
            case DW_FORM_strx: case DW_FORM_strx1: case DW_FORM_strx2: case DW_FORM_strx4:
                /* (an index into .debug_str_offsets: not followed) */
                if (f === DW_FORM_strx) { r.uleb(); } else { r.pos += f === DW_FORM_strx1 ? 1 : f === DW_FORM_strx2 ? 2 : 4; }
                return '';
            default: throw new Error(`DWARF form ${f}`);
            }
        };
        try {
            if (version >= 5) {
                const entries = (): { name: string; dir: number }[] => {
                    const fmtCount = r.u8();
                    const fmts: [number, number][] = [];
                    for (let i = 0; i < fmtCount; i++) {
                        fmts.push([r.uleb(), r.uleb()]);
                    }
                    const count = r.uleb();
                    const out: { name: string; dir: number }[] = [];
                    for (let i = 0; i < count; i++) {
                        let name = '';
                        let dir = 0;
                        for (const [content, f] of fmts) {
                            const v = form(f);
                            if (content === 1) {
                                name = String(v);
                            } else if (content === 2) {
                                dir = Number(v);
                            }
                        }
                        out.push({ name, dir });
                    }
                    return out;
                };
                dirs.push(...entries().map((e) => e.name));
                files.push(...entries());
            } else {
                dirs.push('');                      /* 0: the compilation directory */
                for (let s = r.cstr(); s; s = r.cstr()) {
                    dirs.push(s);
                }
                files.push({ name: '', dir: 0 });   /* (1-based) */
                for (let s = r.cstr(); s; s = r.cstr()) {
                    const dir = r.uleb();
                    r.uleb();
                    r.uleb();
                    files.push({ name: s, dir });
                }
            }
        } catch {
            r.pos = unitEnd;
            continue;
        }
        const filePath = (i: number): string | undefined => {
            const f = files[i];
            if (!f || !f.name) {
                return undefined;
            }
            if (path.isAbsolute(f.name)) {
                return f.name;
            }
            const dir = dirs[f.dir] ?? '';
            const compDir = version >= 5 ? dirs[0] ?? '' : '';
            const full = path.join(path.isAbsolute(dir) ? dir : path.join(compDir || baseDir, dir), f.name);
            return path.isAbsolute(full) ? full : path.join(baseDir, full);
        };

        /* The line program */
        r.pos = programStart;
        let addr = 0, file = 1, ln = 1, isStmt = true;
        let rows: { addr: number; file: number; line: number }[] = [];
        const emit = () => {
            if (isStmt) {
                rows.push({ addr, file, line: ln });
            }
        };
        const endSequence = () => {
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const next = i + 1 < rows.length ? rows[i + 1].addr : addr;
                const f = filePath(row.file);
                if (f && row.line > 0) {
                    table.addLine(f, row.line, row.addr, Math.max(0, next - row.addr));
                }
            }
            rows = [];
            addr = 0;
            file = 1;
            ln = 1;
            isStmt = true;
        };
        while (r.pos < unitEnd) {
            const op = r.u8();
            if (op >= opcodeBase) {
                const adj = op - opcodeBase;
                addr += Math.floor(adj / lineRange) * minInst;
                ln += lineBase + (adj % lineRange);
                emit();
            } else if (op === 0) {
                const len = r.uleb();
                const end = r.pos + len;
                const sub = r.u8();
                if (sub === 1) {
                    endSequence();
                } else if (sub === 2) {
                    addr = r.uN(len - 1 === 8 ? 8 : len - 1 === 2 ? 2 : len - 1 === 1 ? 1 : addressSize === 8 ? 8 : 4);
                }
                r.pos = end;
            } else {
                switch (op) {
                case 1: emit(); break;
                case 2: addr += r.uleb() * minInst; break;
                case 3: ln += r.sleb(); break;
                case 4: file = r.uleb(); break;
                case 5: r.uleb(); break;
                case 6: isStmt = !isStmt; break;
                case 7: break;
                case 8: addr += Math.floor((255 - opcodeBase) / lineRange) * minInst; break;
                case 9: addr += r.u16(); break;
                case 10: case 11: break;
                case 12: r.uleb(); break;
                default:
                    for (let i = 0; i < opLengths[op]; i++) {
                        r.uleb();
                    }
                }
            }
        }
        r.pos = unitEnd;
    }
}
