import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { detectFormat, parseProgram } from '../../src/loaders/program';

const fixtures = path.join(__dirname, '..', '..', '..', 'test', 'fixtures');

function bytes(...parts: (number[] | Uint8Array | string)[]): Uint8Array {
    const out: number[] = [];
    for (const p of parts) {
        if (typeof p === 'string') {
            out.push(...Buffer.from(p, 'latin1'));
        } else {
            out.push(...p);
        }
    }
    return new Uint8Array(out);
}

describe('programs', () => {
    it('loads an Atari XEX with RUNAD', () => {
        const p = parseProgram(path.join(fixtures, 'hello.xex'), new Uint8Array(fs.readFileSync(path.join(fixtures, 'hello.xex'))));
        assert.strictEqual(p.format, 'xex');
        assert.strictEqual(p.entry, 0x2000);
        assert.strictEqual(p.segments.length, 1, 'RUNAD is not written');
        assert.strictEqual(p.segments[0].addr, 0x2000);
        assert.strictEqual(p.segments[0].data.length, 0x18);
    });

    it('finds the SYS of a C64 BASIC stub', () => {
        /* 10 SYS2061 */
        const prg = bytes([0x01, 0x08, 0x0B, 0x08, 0x0A, 0x00, 0x9E], '2061', [0, 0, 0, 0xA9, 0x00, 0x60]);
        const p = parseProgram('game.prg', prg);
        assert.strictEqual(p.format, 'prg');
        assert.strictEqual(p.entry, 2061);
        assert.deepStrictEqual(p.basic, { start: 0x0801, end: 0x0801 + prg.length - 2 });
    });

    it('loads a machine code PRG at its address', () => {
        const p = parseProgram('code.prg', bytes([0x00, 0xC0, 0xEA, 0x60]));
        assert.strictEqual(p.entry, 0xC000);
        assert.strictEqual(p.basic, undefined);
    });

    it('loads the CODE blocks of a Spectrum TAP', () => {
        const header = [0x00, 0x03, ...Buffer.from('code      '), 0x03, 0x00, 0x00, 0x80, 0x00, 0x80];
        const hsum = header.reduce((a, b) => a ^ b, 0);
        const data = [0xFF, 0x3E, 0x01, 0xC9];
        const dsum = data.reduce((a, b) => a ^ b, 0);
        const tap = bytes([header.length + 1, 0], header, [hsum], [data.length + 1, 0], data, [dsum]);
        assert.strictEqual(detectFormat('x.tap', tap), 'tap');
        const p = parseProgram('x.tap', tap);
        assert.strictEqual(p.entry, 0x8000);
        assert.deepStrictEqual([...p.segments[0].data], [0x3E, 0x01, 0xC9]);
    });

    it('loads an AMSDOS binary', () => {
        const h = new Uint8Array(128);
        h.set(Buffer.from('GAME    BIN'), 1);
        h[18] = 2;
        h[21] = 0x00; h[22] = 0x40;     /* load $4000 */
        h[24] = 3; h[25] = 0;           /* 3 bytes */
        h[26] = 0x00; h[27] = 0x40;     /* exec $4000 */
        let sum = 0;
        for (let i = 0; i < 67; i++) {
            sum += h[i];
        }
        h[67] = sum & 0xFF;
        h[68] = sum >> 8;
        const file = bytes(h, [0x3E, 0x01, 0xC9]);
        assert.strictEqual(detectFormat('game.bin', file), 'amsdos');
        const p = parseProgram('game.bin', file);
        assert.strictEqual(p.segments[0].addr, 0x4000);
        assert.strictEqual(p.entry, 0x4000);
        assert.strictEqual(p.segments[0].data.length, 3);
    });

    it('loads an MSX BLOAD file', () => {
        const file = bytes([0xFE, 0x00, 0xC0, 0x02, 0xC0, 0x01, 0xC0, 0x00, 0x3E, 0xC9]);
        const p = parseProgram('game.bin', file);
        assert.strictEqual(p.format, 'msx');
        assert.strictEqual(p.segments[0].addr, 0xC000);
        assert.strictEqual(p.entry, 0xC001);
    });

    it('takes raw bytes at the load address given', () => {
        const p = parseProgram('code.bin', bytes([0xFE, 0x01]), 'auto', 0x9000);
        assert.strictEqual(p.format, 'raw');
        assert.strictEqual(p.entry, 0x9000);
        assert.throws(() => parseProgram('code.bin', bytes([1, 2, 3])), /needs a loadAddress/);
    });
});
