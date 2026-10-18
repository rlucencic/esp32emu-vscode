/*
 * cc65's debug information (ld65 --dbgfile, version 2): source lines of
 * C and assembler, and the labels.
 *
 *   file  id=0,name="hello.c",size=310,mtime=0x6712ab01,mod=0
 *   line  id=4,file=0,line=12,type=1,span=7+8
 *   seg   id=0,name="CODE",start=0x00080D,size=0x01C2,addrsize=absolute,type=ro
 *   span  id=7,seg=0,start=12,size=3
 *   sym   id=3,name="_main",addrsize=absolute,scope=0,def=5,val=0x81A,seg=0,type=lab
 *
 * Line types: 0 assembler, 1 C (an "external" source), 2 a macro's lines.
 */
import * as path from 'path';
import { SymbolTable } from './table';

type Fields = Map<string, string>;

function fields(text: string): Fields {
    const out: Fields = new Map();
    /* key=value, key="quoted, with commas" */
    const re = /([a-z_]+)=("(?:[^"\\]|\\.)*"|[^,]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        let v = m[2];
        if (v.startsWith('"')) {
            v = v.slice(1, -1).replace(/\\(.)/g, '$1');
        }
        out.set(m[1], v);
    }
    return out;
}

function num(v: string | undefined): number {
    return v === undefined ? NaN : Number(v);
}

export function isCa65Dbg(text: string): boolean {
    return /^version\s+major=2/m.test(text.slice(0, 200));
}

export function parseCa65Dbg(text: string, baseDir: string): SymbolTable {
    const files = new Map<number, string>();
    const segs = new Map<number, number>();
    const spans = new Map<number, { seg: number; start: number; size: number }>();
    const lines: { file: number; line: number; type: number; spans: number[] }[] = [];
    const syms: { name: string; val: number; type: string }[] = [];

    for (const raw of text.split(/\r?\n/)) {
        const tab = raw.indexOf('\t');
        if (tab < 0) {
            continue;
        }
        const kind = raw.slice(0, tab);
        const f = fields(raw.slice(tab + 1));
        const id = num(f.get('id'));
        switch (kind) {
        case 'file':
            files.set(id, f.get('name') ?? '');
            break;
        case 'seg':
            segs.set(id, num(f.get('start')));
            break;
        case 'span':
            spans.set(id, { seg: num(f.get('seg')), start: num(f.get('start')), size: num(f.get('size')) });
            break;
        case 'line': {
            const span = f.get('span');
            if (span) {
                lines.push({
                    file: num(f.get('file')),
                    line: num(f.get('line')),
                    type: f.has('type') ? num(f.get('type')) : 0,
                    spans: span.split('+').map(Number),
                });
            }
            break;
        }
        case 'sym':
            if (f.get('type') === 'lab' || f.get('type') === 'equ') {
                syms.push({ name: f.get('name') ?? '', val: num(f.get('val')), type: f.get('type') ?? '' });
            }
            break;
        default:
            break;
        }
    }

    const table = new SymbolTable();
    for (const s of syms) {
        if (s.type === 'lab' && !Number.isNaN(s.val)) {
            table.addLabel(s.name, s.val);
        }
    }
    /* C lines first: where a C line and its assembler share an address,
     * the C line is the one shown
     */
    const order = (t: number) => (t === 1 ? 0 : t === 0 ? 1 : 2);
    lines.sort((a, b) => order(a.type) - order(b.type));
    for (const l of lines) {
        const name = files.get(l.file);
        if (name === undefined) {
            continue;
        }
        const file = path.isAbsolute(name) ? name : path.join(baseDir, name);
        for (const sid of l.spans) {
            const span = spans.get(sid);
            const start = span ? segs.get(span.seg) : undefined;
            if (span && start !== undefined && span.size > 0) {
                table.addLine(file, l.line, start + span.start, span.size);
            }
        }
    }
    return table;
}
