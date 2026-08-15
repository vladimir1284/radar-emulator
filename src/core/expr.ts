// Evaluador de expresiones seguro para condiciones de blocks (expression,
// latch.set/reset, state_machine.when, axis.enable/reference/inhibit_*).
// Deliberadamente NO usa eval()/Function(): la configuracion se escribe a
// mano (esquema.md) pero sigue siendo entrada externa al proceso.
//
// Gramatica (precedencia de menor a mayor):
//   or := and ('or' and)*
//   and := not ('and' not)*
//   not := 'not' not | cmp
//   cmp := atom (('>'|'>='|'<'|'<='|'=='|'!=') atom)?
//   atom := number | 'rising' '(' ident ')' | ident | '(' or ')'
//   ident := [a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+

export type CmpOp = ">" | ">=" | "<" | "<=" | "==" | "!=";

export type ExprNode =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "rising"; name: string }
  | { kind: "not"; arg: ExprNode }
  | { kind: "cmp"; op: CmpOp; left: ExprNode; right: ExprNode }
  | { kind: "and" | "or"; args: ExprNode[] };

export class ExprSyntaxError extends Error {}

interface Token {
  type: "ident" | "num" | "op" | "lparen" | "rparen" | "eof";
  text: string;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/;
const OPS = ["==", "!=", ">=", "<=", ">", "<"] as const;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", text: c });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", text: c });
      i += 1;
      continue;
    }
    const twoChar = src.slice(i, i + 2);
    if (twoChar === "==" || twoChar === "!=" || twoChar === ">=" || twoChar === "<=") {
      tokens.push({ type: "op", text: twoChar });
      i += 2;
      continue;
    }
    if (c === ">" || c === "<") {
      tokens.push({ type: "op", text: c });
      i += 1;
      continue;
    }
    const numMatch = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (numMatch) {
      tokens.push({ type: "num", text: numMatch[0] });
      i += numMatch[0].length;
      continue;
    }
    const identMatch = /^[a-zA-Z_][a-zA-Z0-9_.]*/.exec(src.slice(i));
    if (identMatch) {
      tokens.push({ type: "ident", text: identMatch[0] });
      i += identMatch[0].length;
      continue;
    }
    throw new ExprSyntaxError(`caracter inesperado "${c}" en posicion ${i} de "${src}"`);
  }
  tokens.push({ type: "eof", text: "" });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectIdentLike(text: string): boolean {
    return this.peek().type === "ident" && this.peek().text === text;
  }

  parse(): ExprNode {
    const node = this.parseOr();
    if (this.peek().type !== "eof") {
      throw new ExprSyntaxError(`token sobrante "${this.peek().text}" en "${this.source}"`);
    }
    return node;
  }

  private parseOr(): ExprNode {
    const args = [this.parseAnd()];
    while (this.expectIdentLike("or")) {
      this.next();
      args.push(this.parseAnd());
    }
    return args.length === 1 ? args[0]! : { kind: "or", args };
  }

  private parseAnd(): ExprNode {
    const args = [this.parseNot()];
    while (this.expectIdentLike("and")) {
      this.next();
      args.push(this.parseNot());
    }
    return args.length === 1 ? args[0]! : { kind: "and", args };
  }

  private parseNot(): ExprNode {
    if (this.expectIdentLike("not")) {
      this.next();
      return { kind: "not", arg: this.parseNot() };
    }
    return this.parseCmp();
  }

  private parseCmp(): ExprNode {
    const left = this.parseAtom();
    const tok = this.peek();
    if (tok.type === "op" && (OPS as readonly string[]).includes(tok.text)) {
      this.next();
      const right = this.parseAtom();
      return { kind: "cmp", op: tok.text as CmpOp, left, right };
    }
    return left;
  }

  private parseAtom(): ExprNode {
    const tok = this.peek();
    if (tok.type === "num") {
      this.next();
      return { kind: "num", value: Number(tok.text) };
    }
    if (tok.type === "lparen") {
      this.next();
      const inner = this.parseOr();
      if (this.peek().type !== "rparen") {
        throw new ExprSyntaxError(`falta ")" en "${this.source}"`);
      }
      this.next();
      return inner;
    }
    if (tok.type === "ident" && tok.text === "rising") {
      this.next();
      if (this.peek().type !== "lparen") {
        throw new ExprSyntaxError(`falta "(" tras "rising" en "${this.source}"`);
      }
      this.next();
      const arg = this.next();
      if (arg.type !== "ident" || !IDENT_RE.test(arg.text)) {
        throw new ExprSyntaxError(`rising() espera un identificador de señal en "${this.source}"`);
      }
      if (this.peek().type !== "rparen") {
        throw new ExprSyntaxError(`falta ")" tras rising(${arg.text} en "${this.source}"`);
      }
      this.next();
      return { kind: "rising", name: arg.text };
    }
    if (tok.type === "ident" && IDENT_RE.test(tok.text)) {
      this.next();
      return { kind: "ident", name: tok.text };
    }
    throw new ExprSyntaxError(`token inesperado "${tok.text}" en "${this.source}"`);
  }
}

export function compileExpr(source: string): ExprNode {
  const tokens = tokenize(source);
  return new Parser(tokens, source).parse();
}

export function collectIdentifiers(node: ExprNode, out: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case "num":
      break;
    case "ident":
    case "rising":
      out.add(node.name);
      break;
    case "not":
      collectIdentifiers(node.arg, out);
      break;
    case "cmp":
      collectIdentifiers(node.left, out);
      collectIdentifiers(node.right, out);
      break;
    case "and":
    case "or":
      for (const arg of node.args) collectIdentifiers(arg, out);
      break;
  }
  return out;
}

export interface ExprContext {
  current(id: string): boolean | number;
  previous(id: string): boolean | number;
}

function truthy(v: boolean | number): boolean {
  return typeof v === "boolean" ? v : v !== 0;
}

export function evaluateExpr(node: ExprNode, ctx: ExprContext): boolean | number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "ident":
      return ctx.current(node.name);
    case "rising":
      return !truthy(ctx.previous(node.name)) && truthy(ctx.current(node.name));
    case "not":
      return !truthy(evaluateExpr(node.arg, ctx));
    case "cmp": {
      const l = evaluateExpr(node.left, ctx) as number;
      const r = evaluateExpr(node.right, ctx) as number;
      switch (node.op) {
        case ">":
          return l > r;
        case ">=":
          return l >= r;
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case "==":
          return l === r;
        case "!=":
          return l !== r;
      }
      break;
    }
    case "and":
      return node.args.every((a) => truthy(evaluateExpr(a, ctx)));
    case "or":
      return node.args.some((a) => truthy(evaluateExpr(a, ctx)));
  }
}
