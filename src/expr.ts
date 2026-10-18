/*
 * Expressions for the Watch window, hovers and breakpoint conditions:
 *
 *   numbers     $1F, 0x1F, %1010, 31, 1Fh
 *   names       registers (A, PC, D0), labels (main, _main), flags (C, Z, ...)
 *   memory      [addr] a byte, w[addr] a word, l[addr] a long (the CPU's byte order)
 *   operators   + - * / % << >> & | ^ ~ ! == != < <= > >= && || and ( )
 */

export interface EvalContext {
    /* A register or flag by name (case-insensitive), or undefined */
    register(name: string): number | undefined;
    /* A label's address, or undefined */
    label(name: string): number | undefined;
    read(addr: number, size: 1 | 2 | 4): Promise<number>;
}

type Node =
    | { k: 'num'; v: number }
    | { k: 'name'; v: string }
    | { k: 'mem'; size: 1 | 2 | 4; a: Node }
    | { k: 'un'; op: string; a: Node }
    | { k: 'bin'; op: string; a: Node; b: Node };

export class ExprError extends Error {}

const TOKEN = /\s*(\$[0-9a-fA-F]+|0x[0-9a-fA-F]+|%[01]+|[0-9][0-9a-fA-F]*h\b|\d+|[wl]\[|[A-Za-z_.@][\w.@']*|<<|>>|==|!=|<=|>=|&&|\|\||[-+*/%&|^~!()<>\[\]])/y;

function tokenize(text: string): string[] {
    const out: string[] = [];
    TOKEN.lastIndex = 0;
    let at = 0;
    while (at < text.length) {
        if (/^\s*$/.test(text.slice(at))) {
            break;
        }
        TOKEN.lastIndex = at;
        const m = TOKEN.exec(text);
        if (!m) {
            throw new ExprError(`can't read "${text.slice(at).trim()}"`);
        }
        out.push(m[1]);
        at = TOKEN.lastIndex;
    }
    return out;
}

export function parseNumber(t: string): number | undefined {
    if (/^\$[0-9a-f]+$/i.test(t)) {
        return parseInt(t.slice(1), 16);
    }
    if (/^0x[0-9a-f]+$/i.test(t)) {
        return parseInt(t.slice(2), 16);
    }
    if (/^%[01]+$/.test(t)) {
        return parseInt(t.slice(1), 2);
    }
    if (/^[0-9][0-9a-f]*h$/i.test(t)) {
        return parseInt(t.slice(0, -1), 16);
    }
    if (/^\d+$/.test(t)) {
        return parseInt(t, 10);
    }
    return undefined;
}

const LEVELS: string[][] = [
    ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'],
    ['*', '/', '%'],
];

class Parser {
    private i = 0;
    constructor(private t: string[]) {}

    parse(): Node {
        const n = this.level(0);
        if (this.i < this.t.length) {
            throw new ExprError(`unexpected "${this.t[this.i]}"`);
        }
        return n;
    }

    private peek(): string | undefined {
        return this.t[this.i];
    }

    private take(s?: string): string {
        const v = this.t[this.i];
        if (v === undefined || (s !== undefined && v !== s)) {
            throw new ExprError(s ? `"${s}" expected` : 'the expression ends too early');
        }
        this.i++;
        return v;
    }

    private level(l: number): Node {
        if (l === LEVELS.length) {
            return this.unary();
        }
        let a = this.level(l + 1);
        while (LEVELS[l].includes(this.peek() ?? '')) {
            const op = this.take();
            a = { k: 'bin', op, a, b: this.level(l + 1) };
        }
        return a;
    }

    private unary(): Node {
        const t = this.peek();
        if (t === '-' || t === '~' || t === '!' || t === '+') {
            this.take();
            return { k: 'un', op: t, a: this.unary() };
        }
        return this.primary();
    }

    private primary(): Node {
        const t = this.take();
        if (t === '(') {
            const n = this.level(0);
            this.take(')');
            return n;
        }
        if (t === '[' || t === 'w[' || t === 'l[') {
            const a = this.level(0);
            this.take(']');
            return { k: 'mem', size: t === '[' ? 1 : t === 'w[' ? 2 : 4, a };
        }
        const v = parseNumber(t);
        if (v !== undefined) {
            return { k: 'num', v };
        }
        if (/^[A-Za-z_.@]/.test(t)) {
            return { k: 'name', v: t };
        }
        throw new ExprError(`unexpected "${t}"`);
    }
}

export function parseExpr(text: string): Node {
    return new Parser(tokenize(text)).parse();
}

async function evalNode(n: Node, ctx: EvalContext): Promise<number> {
    switch (n.k) {
    case 'num':
        return n.v;
    case 'name': {
        const r = ctx.register(n.v);
        if (r !== undefined) {
            return r;
        }
        const l = ctx.label(n.v);
        if (l !== undefined) {
            return l;
        }
        throw new ExprError(`no register or label "${n.v}"`);
    }
    case 'mem':
        return ctx.read(await evalNode(n.a, ctx), n.size);
    case 'un': {
        const a = await evalNode(n.a, ctx);
        switch (n.op) {
        case '-': return -a;
        case '~': return ~a >>> 0;
        case '!': return a ? 0 : 1;
        default: return a;
        }
    }
    case 'bin': {
        const a = await evalNode(n.a, ctx);
        if (n.op === '&&' && !a) {
            return 0;
        }
        if (n.op === '||' && a) {
            return 1;
        }
        const b = await evalNode(n.b, ctx);
        switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': if (b === 0) { throw new ExprError('division by zero'); } return Math.trunc(a / b);
        case '%': if (b === 0) { throw new ExprError('division by zero'); } return a % b;
        case '<<': return (a << b) >>> 0;
        case '>>': return a >>> b;
        case '&': return (a & b) >>> 0;
        case '|': return (a | b) >>> 0;
        case '^': return (a ^ b) >>> 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '&&': case '||': return b ? 1 : 0;
        default: throw new ExprError(`operator ${n.op}`);
        }
    }
    }
}

export async function evaluate(text: string, ctx: EvalContext): Promise<number> {
    return evalNode(parseExpr(text), ctx);
}

/* Does the expression read memory or name only a label (for hovers: a
 * label shows its address and what's there)
 */
export function isPlainName(text: string): boolean {
    return /^[A-Za-z_.@][\w.@']*$/.test(text.trim());
}
