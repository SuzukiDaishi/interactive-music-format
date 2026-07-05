/**
 * Cue condition expression compiler.
 *
 * Compiles a small infix expression language to Cue VM bytecode
 * (docs/03_cue_vm_spec.md). Example:
 *
 *   intensity >= 0.7 && section != 'Battle_High'
 *
 * Identifiers resolve to RTPC names or to the built-in specials
 * `section, beats, bar, playing, rand, rate, time`.
 * String literals resolve to a section id, or to an enum RTPC variant index.
 */

import type { IamProject } from './model.js';

const OP = {
  PUSH: 0x01,
  RTPC: 0x02,
  SPECIAL: 0x03,
  ADD: 0x10,
  SUB: 0x11,
  MUL: 0x12,
  DIV: 0x13,
  NEG: 0x14,
  LT: 0x20,
  LE: 0x21,
  GT: 0x22,
  GE: 0x23,
  EQ: 0x24,
  NE: 0x25,
  AND: 0x30,
  OR: 0x31,
  NOT: 0x32,
} as const;

const SPECIALS: Record<string, number> = {
  section: 0,
  beats: 1,
  bar: 2,
  playing: 3,
  rand: 4,
  rate: 5,
  time: 6,
};

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'str'; value: string }
  | { kind: 'op'; value: string };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const two = ['&&', '||', '<=', '>=', '==', '!='];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (two.includes(src.slice(i, i + 2))) {
      tokens.push({ kind: 'op', value: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ('+-*/!<>()'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError(`Unterminated string at ${i}`);
      tokens.push({ kind: 'str', value: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) throw new ExprError(`Bad number at ${i}`);
      tokens.push({ kind: 'num', value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ kind: 'ident', value: m[0] });
      i += m[0].length;
      continue;
    }
    throw new ExprError(`Unexpected character '${c}' at ${i}`);
  }
  return tokens;
}

class Emitter {
  bytes: number[] = [];

  op(code: number) {
    this.bytes.push(code);
  }

  pushF32(v: number) {
    this.bytes.push(OP.PUSH);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes.push(...b);
  }

  rtpc(id: number) {
    this.bytes.push(OP.RTPC);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, id, true);
    this.bytes.push(...b);
  }

  special(id: number) {
    this.bytes.push(OP.SPECIAL, id);
  }
}

class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private project: IamProject,
    private out: Emitter,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos++];
    if (!t) throw new ExprError('Unexpected end of expression');
    return t;
  }

  private eatOp(value: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'op' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse() {
    this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new ExprError(`Unexpected token after expression`);
    }
  }

  private parseOr() {
    this.parseAnd();
    while (this.eatOp('||')) {
      this.parseAnd();
      this.out.op(OP.OR);
    }
  }

  private parseAnd() {
    this.parseCmp();
    while (this.eatOp('&&')) {
      this.parseCmp();
      this.out.op(OP.AND);
    }
  }

  private parseCmp() {
    this.parseAdd();
    const map: Record<string, number> = {
      '<': OP.LT,
      '<=': OP.LE,
      '>': OP.GT,
      '>=': OP.GE,
      '==': OP.EQ,
      '!=': OP.NE,
    };
    const t = this.peek();
    if (t && t.kind === 'op' && map[t.value] !== undefined) {
      this.pos++;
      this.parseAdd();
      this.out.op(map[t.value]);
    }
  }

  private parseAdd() {
    this.parseMul();
    for (;;) {
      if (this.eatOp('+')) {
        this.parseMul();
        this.out.op(OP.ADD);
      } else if (this.eatOp('-')) {
        this.parseMul();
        this.out.op(OP.SUB);
      } else {
        break;
      }
    }
  }

  private parseMul() {
    this.parseUnary();
    for (;;) {
      if (this.eatOp('*')) {
        this.parseUnary();
        this.out.op(OP.MUL);
      } else if (this.eatOp('/')) {
        this.parseUnary();
        this.out.op(OP.DIV);
      } else {
        break;
      }
    }
  }

  private parseUnary() {
    if (this.eatOp('!')) {
      this.parseUnary();
      this.out.op(OP.NOT);
      return;
    }
    if (this.eatOp('-')) {
      this.parseUnary();
      this.out.op(OP.NEG);
      return;
    }
    this.parsePrimary();
  }

  private parsePrimary() {
    const t = this.next();
    if (t.kind === 'num') {
      this.out.pushF32(t.value);
      return;
    }
    if (t.kind === 'str') {
      this.out.pushF32(this.resolveString(t.value));
      return;
    }
    if (t.kind === 'ident') {
      this.resolveIdent(t.value);
      return;
    }
    if (t.kind === 'op' && t.value === '(') {
      this.parseOr();
      if (!this.eatOp(')')) throw new ExprError(`Missing ')'`);
      return;
    }
    throw new ExprError(`Unexpected token '${'value' in t ? t.value : '?'}'`);
  }

  private resolveIdent(name: string) {
    if (name === 'true') {
      this.out.pushF32(1);
      return;
    }
    if (name === 'false') {
      this.out.pushF32(0);
      return;
    }
    const rtpc = this.project.rtpcs.find((r) => r.name === name);
    if (rtpc) {
      this.out.rtpc(rtpc.id);
      return;
    }
    if (name in SPECIALS) {
      this.out.special(SPECIALS[name]);
      return;
    }
    throw new ExprError(`Unknown identifier '${name}' (not an RTPC or built-in)`);
  }

  private resolveString(value: string): number {
    const section = this.project.sections.find((s) => s.name === value);
    if (section) return section.id;
    for (const r of this.project.rtpcs) {
      if (r.type === 'enum' && r.variants) {
        const idx = r.variants.indexOf(value);
        if (idx >= 0) return idx;
      }
    }
    throw new ExprError(
      `String '${value}' is neither a section name nor an enum RTPC variant`,
    );
  }
}

/**
 * Compiles an expression to Cue VM bytecode. Empty/whitespace-only source
 * compiles to an empty program, which the VM treats as "always true".
 */
export function compileExpression(source: string, project: IamProject): Uint8Array {
  const trimmed = source.trim();
  if (!trimmed) return new Uint8Array(0);
  const tokens = tokenize(trimmed);
  const out = new Emitter();
  new Parser(tokens, project, out).parse();
  if (out.bytes.length > 0xffff) {
    throw new ExprError('Expression bytecode too long');
  }
  return new Uint8Array(out.bytes);
}

/**
 * Compiles a numeric value expression (v3 dynamic action parameters, e.g. a
 * gain computed from an RTPC). Same language and bytecode as conditions —
 * the engine reads the top-of-stack value as a number instead of a boolean.
 * Empty source is rejected: a value expression must produce a value.
 */
export function compileValueExpression(source: string, project: IamProject): Uint8Array {
  if (!source.trim()) throw new ExprError('Value expression must not be empty');
  return compileExpression(source, project);
}

/** Validates an expression, returning an error message or null. */
export function checkExpression(source: string, project: IamProject): string | null {
  try {
    compileExpression(source, project);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
