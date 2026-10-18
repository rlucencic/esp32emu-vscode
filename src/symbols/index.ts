/*
 * Symbol files by their contents: cc65 .dbg, sjasmplus .sld, ELF with
 * DWARF, or a label file.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isCa65Dbg, parseCa65Dbg } from './ca65';
import { isElf, parseElf } from './elf';
import { parseLabels } from './labels';
import { isSld, parseSld } from './sld';
import { SymbolTable } from './table';

export { SymbolTable } from './table';

export function loadSymbolFile(file: string, sourceRoot?: string): SymbolTable {
    const bytes = fs.readFileSync(file);
    const base = sourceRoot ?? path.dirname(file);
    if (isElf(bytes)) {
        return parseElf(bytes, base).symbols;
    }
    const text = bytes.toString('latin1');
    if (isCa65Dbg(text)) {
        return parseCa65Dbg(text, base);
    }
    if (isSld(text)) {
        return parseSld(text, base);
    }
    return parseLabels(text);
}

/* Symbol files next to a program, by its name: game.prg -> game.dbg, ... */
export function findSymbolFiles(program: string): string[] {
    const dir = path.dirname(program);
    const stem = path.basename(program, path.extname(program));
    const found: string[] = [];
    for (const ext of ['.dbg', '.sld', '.elf', '.lbl', '.labels', '.sym', '.vs', '.map']) {
        const f = path.join(dir, stem + ext);
        if (fs.existsSync(f) && f !== program) {
            found.push(f);
            if (ext === '.dbg' || ext === '.sld' || ext === '.elf') {
                break;                  /* lines and labels: enough */
            }
        }
    }
    return found;
}
