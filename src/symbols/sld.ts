/*
 * sjasmplus's source level debugging data (--sld), version 1:
 *
 *   |SLD.data.version|1
 *   main.asm|12||0|-1|32768|F|start
 *   main.asm|13||0|-1|32768|T|
 *   main.asm|20||0|-1|23296|D|buffer
 *
 * Fields: source file, line, definition file, definition line, page,
 * value, type, data. T: an instruction at value; F, L, D: a label (data)
 * with that value. Lines may carry a column ("13:5").
 */
import * as path from 'path';
import { SymbolTable } from './table';

export function isSld(text: string): boolean {
    return text.startsWith('|SLD.data.version|');
}

export function parseSld(text: string, baseDir: string): SymbolTable {
    const table = new SymbolTable();
    for (const raw of text.split(/\r?\n/)) {
        if (!raw || raw.startsWith('|')) {
            continue;
        }
        const f = raw.split('|');
        if (f.length < 7) {
            continue;
        }
        const value = Number(f[5]);
        if (Number.isNaN(value)) {
            continue;
        }
        const type = f[6];
        if (type === 'T') {
            const line = parseInt(f[1], 10);
            if (f[0] && line > 0) {
                const file = path.isAbsolute(f[0]) ? f[0] : path.join(baseDir, f[0]);
                table.addLine(file, line, value & 0xFFFF);
            }
        } else if ((type === 'F' || type === 'L' || type === 'D') && f[7]) {
            table.addLabel(f[7], value & 0xFFFF);
        }
    }
    return table;
}
