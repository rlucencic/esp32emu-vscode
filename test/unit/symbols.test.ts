import * as assert from 'assert';
import * as path from 'path';
import { loadSymbolFile, findSymbolFiles } from '../../src/symbols';
import { parseElf } from '../../src/symbols/elf';
import * as fs from 'fs';

const fixtures = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');
const f = (name: string) => path.join(fixtures, name);

describe('symbols', () => {
    it('reads ld65 debug info: lines and labels', () => {
        const t = loadSymbolFile(f('hello.dbg'));
        assert.strictEqual(t.label('start'), 0x2000);
        assert.strictEqual(t.label('bump'), 0x2010);
        assert.strictEqual(t.label('counter'), undefined, 'an equate is not a label');
        assert.deepStrictEqual(t.lineAt(0x2004), { file: f('hello.s'), line: 7 });
        assert.deepStrictEqual(t.lineAt(0x2005), { file: f('hello.s'), line: 7 }, 'inside the instruction');
        assert.strictEqual(t.lineAt(0x200B), undefined, 'the padding is no code');
        assert.deepStrictEqual(t.addrsForLine(f('hello.s'), 11), { line: 11, addrs: [0x2010] });
        assert.deepStrictEqual(t.addrsForLine(f('hello.s'), 9), { line: 11, addrs: [0x2010] },
            'a line without code: the next one with code');
        assert.deepStrictEqual(t.nearestLabel(0x2012), { name: 'bump', offset: 2 });
    });

    it('reads sjasmplus SLD', () => {
        const t = loadSymbolFile(f('hello.sld'));
        assert.strictEqual(t.label('start'), 0x8000);
        assert.strictEqual(t.label('sub'), 0x8008);
        assert.deepStrictEqual(t.lineAt(0x8005), { file: f('hello.asm'), line: 5 });
        assert.deepStrictEqual(t.addrsForLine(f('hello.asm'), 7), { line: 7, addrs: [0x8008] });
    });

    it('reads label files of many assemblers', () => {
        const t = loadSymbolFile(f('hello.lbl'));
        assert.strictEqual(t.label('basic'), 0x0801);
        assert.strictEqual(t.label('main'), 0x080D);
        assert.strictEqual(t.label('screen'), 0x0400);
        assert.strictEqual(t.label('border'), 0xD020);
        assert.strictEqual(t.label('colour'), 0xD021);
        assert.strictEqual(t.label('sprite'), 0x2000);
        assert.strictEqual(t.label('table'), 0xC000);
        assert.strictEqual(t.label('loop2'), 4096);
        assert.strictEqual(t.label('MAIN'), 0x080D, 'any case');
    });

    for (const v of ['2', '4', '5']) {
        it(`reads ELF with DWARF ${v} line tables`, () => {
            const t = loadSymbolFile(f(`dwarf${v}-32.o`));
            assert.strictEqual(t.label('main'), 0);
            assert.strictEqual(t.label('bump'), 0x30);
            const line = t.lineAt(0x33);
            assert.ok(line, 'a line for $33');
            assert.strictEqual(path.basename(line.file), 'dwarf.c');
            assert.strictEqual(line.line, 5);
            const bp = t.addrsForLine(line.file, 11);
            assert.deepStrictEqual(bp?.addrs, [0x20]);
        });
    }

    it('finds the symbol files next to a program', () => {
        assert.deepStrictEqual(findSymbolFiles(f('hello.xex')), [f('hello.dbg')]);
    });

    it('reads ELF segments', () => {
        const e = parseElf(new Uint8Array(fs.readFileSync(f('dwarf5-32.o'))), fixtures);
        assert.strictEqual(e.segments.length, 0, 'an object file has no segments');
    });
});
