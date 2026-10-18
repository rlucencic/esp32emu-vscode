/*
 * Label files of the usual assemblers, a label per line:
 *
 *   al C:0801 .start                VICE (ca65 -Ln, ld65 -Ln, 64tass --vice-labels)
 *   start = $0801                   64tass, ACME, z88dk .map, KickAssembler .sym (".label start=$0801")
 *   start equ 0801h / start: equ $0801
 *   $0801 start / 0801 start        NoICE-style
 */
import { SymbolTable } from './table';

function value(text: string): number {
    const t = text.trim();
    if (t.startsWith('$')) {
        return parseInt(t.slice(1), 16);
    }
    if (/^0x/i.test(t)) {
        return parseInt(t.slice(2), 16);
    }
    if (/^[0-9a-f]+h$/i.test(t)) {
        return parseInt(t.slice(0, -1), 16);
    }
    if (t.startsWith('%')) {
        return parseInt(t.slice(1), 2);
    }
    return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
}

const NAME = '[A-Za-z_.@][\\w.@$?]*';
const VALUE = '\\$[0-9a-fA-F]+|0x[0-9a-fA-F]+|[0-9][0-9a-fA-F]*h|%[01]+|\\d+';
const VICE = /^al\s+(?:[A-Za-z]:)?([0-9a-fA-F]+)\s+\.?(\S+)/;
const ASSIGN = new RegExp(`^(?:\\.label\\s+|\\.const\\s+)?(${NAME}):?\\s*(?:=|\\.?equ\\b|\\.?set\\b)\\s*(${VALUE})\\b`, 'i');
const ADDR_FIRST = new RegExp(`^(?:[A-Za-z]:)?(\\$?[0-9a-fA-F]{3,8})\\s+\\.?(${NAME})\\s*$`);

export function parseLabels(text: string): SymbolTable {
    const table = new SymbolTable();
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';') || line.startsWith('//')) {
            continue;
        }
        let m = VICE.exec(line);
        if (m) {
            table.addLabel(m[2], parseInt(m[1], 16));
            continue;
        }
        m = ASSIGN.exec(line);
        if (m) {
            const v = value(m[2]);
            if (!Number.isNaN(v)) {
                table.addLabel(m[1], v);
            }
            continue;
        }
        m = ADDR_FIRST.exec(line);
        if (m) {
            table.addLabel(m[2], parseInt(m[1].replace('$', ''), 16));
        }
    }
    return table;
}
