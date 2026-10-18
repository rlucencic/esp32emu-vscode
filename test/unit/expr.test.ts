import * as assert from 'assert';
import { evaluate, EvalContext, parseNumber } from '../../src/expr';

const memory = new Uint8Array(65536);
memory[0x80] = 0x2A;
memory[0x1000] = 0x34;
memory[0x1001] = 0x12;

function ctx(bigEndian = false): EvalContext {
    const regs: Record<string, number> = { a: 0x10, x: 3, pc: 0x2000, p: 0b10000011 };
    return {
        register: (n) => regs[n.toLowerCase()] ?? (n.toUpperCase() === 'C' ? regs.p & 1 : undefined),
        label: (n) => ({ counter: 0x80, table: 0x1000 } as Record<string, number>)[n],
        read: async (addr, size) => {
            let v = 0;
            for (let i = 0; i < size; i++) {
                v = bigEndian ? v * 256 + memory[addr + i] : v + memory[addr + i] * 2 ** (8 * i);
            }
            return v;
        },
    };
}

describe('expressions', () => {
    it('reads numbers in every base', () => {
        assert.strictEqual(parseNumber('$1F'), 31);
        assert.strictEqual(parseNumber('0x1f'), 31);
        assert.strictEqual(parseNumber('%101'), 5);
        assert.strictEqual(parseNumber('1Fh'), 31);
        assert.strictEqual(parseNumber('31'), 31);
        assert.strictEqual(parseNumber('main'), undefined);
    });

    it('evaluates registers, labels and operators', async () => {
        assert.strictEqual(await evaluate('A + X * 2', ctx()), 0x16);
        assert.strictEqual(await evaluate('(A + X) * 2', ctx()), 0x26);
        assert.strictEqual(await evaluate('counter + 1', ctx()), 0x81);
        assert.strictEqual(await evaluate('pc >> 8 & $FF', ctx()), 0x20);
        assert.strictEqual(await evaluate('~0 & $FF', ctx()), 0xFF);
        assert.strictEqual(await evaluate('-1 + 2', ctx()), 1);
        assert.strictEqual(await evaluate('C', ctx()), 1);
    });

    it('reads memory in the CPU\'s byte order', async () => {
        assert.strictEqual(await evaluate('[counter]', ctx()), 0x2A);
        assert.strictEqual(await evaluate('w[table]', ctx()), 0x1234);
        assert.strictEqual(await evaluate('w[table]', ctx(true)), 0x3412);
        assert.strictEqual(await evaluate('[table + 1] == $12', ctx()), 1);
    });

    it('does conditions', async () => {
        assert.strictEqual(await evaluate('A == $10 && X < 4', ctx()), 1);
        assert.strictEqual(await evaluate('A != $10 || X >= 4', ctx()), 0);
        assert.strictEqual(await evaluate('!A', ctx()), 0);
    });

    it('says what is wrong', async () => {
        await assert.rejects(evaluate('nosuch + 1', ctx()), /no register or label "nosuch"/);
        await assert.rejects(evaluate('1 +', ctx()), /ends too early/);
        await assert.rejects(evaluate('(1', ctx()), /"\)" expected/);
        await assert.rejects(evaluate('1 / 0', ctx()), /division by zero/);
    });
});
