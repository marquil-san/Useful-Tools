// ── Types ──────────────────────────────────────────────────────────────────

export type PyValue = number | string | boolean | null | PyValue[] | PyDict | PyFunction;
export type PyDict = { __type: "dict"; entries: Map<string, PyValue> };
export type PyFunction = {
  __type: "fn";
  name: string;
  params: string[];
  defaults: PyValue[];
  body: string[];
  closure: PyEnv;
};
export type PyEnv = Map<string, PyValue>;
export type InputFn = (prompt: string) => Promise<string>;
export type OutputFn = (line: string) => void;

// ── Control-flow signals ───────────────────────────────────────────────────

class BreakSignal {}
class ContinueSignal {}
class ReturnSignal { constructor(public value: PyValue) {} }

export class PythonError extends Error {
  constructor(kind: string, msg: string) {
    super(`\x1b[31m${kind}: ${msg}\x1b[0m`);
  }
}

/** Returned (not thrown) by feed() when a top-level input() is encountered */
export class InputRequest {
  constructor(public prompt: string) {}
}

// ── Block parser ───────────────────────────────────────────────────────────

interface SimpleBlock { type: "simple"; line: string }
interface CompoundBlock { type: "compound"; clauses: { header: string; body: string[] }[] }
type Block = SimpleBlock | CompoundBlock;

function indent(line: string): number {
  const m = line.match(/^( +)/);
  return m ? m[1].length : 0;
}

function isCompoundHeader(s: string): boolean {
  return /^(def |class |if |for |while |try:|with |async )/.test(s);
}

function isContinuation(s: string): boolean {
  return /^(elif |else:|except[: ]|except$|finally:)/.test(s);
}

/** Parse a flat list of indented lines into a structured block list.
 *  Properly groups if/elif/else and try/except/finally. */
function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) { i++; continue; }

    const baseIndent = indent(raw);

    if (isCompoundHeader(trimmed)) {
      const clauses: { header: string; body: string[] }[] = [{ header: trimmed, body: [] }];
      i++;

      while (i < lines.length) {
        const nextRaw = lines[i];
        const nextTrimmed = nextRaw.trim();
        if (!nextTrimmed) { i++; continue; }
        const nextIndent = indent(nextRaw);

        if (nextIndent > baseIndent) {
          clauses[clauses.length - 1].body.push(nextRaw);
          i++;
        } else if (nextIndent === baseIndent && isContinuation(nextTrimmed)) {
          clauses.push({ header: nextTrimmed, body: [] });
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "compound", clauses });
    } else {
      blocks.push({ type: "simple", line: trimmed });
      i++;
    }
  }
  return blocks;
}

// ── Main interpreter ───────────────────────────────────────────────────────

export class PythonInterpreter {
  env: PyEnv = new Map();

  // ── REPL state ────────────────────────────────────────────────────────
  private pendingLines: string[] = [];
  private pendingIndent = 0;
  private interrupted = false;

  needsMore(): boolean { return this.pendingLines.length > 0; }
  currentPrompt(): string { return this.pendingLines.length > 0 ? "... " : ">>> "; }

  interrupt(): void {
    this.interrupted = true;
    this.pendingLines = [];
    this.pendingIndent = 0;
  }

  reset(): void {
    this.pendingLines = [];
    this.pendingIndent = 0;
    this.interrupted = false;
  }

  // ── REPL: synchronous feed ────────────────────────────────────────────

  feed(line: string): string[] | InputRequest {
    const stripped = line.trimEnd();

    if (this.pendingLines.length > 0) {
      if (stripped === "" && this.pendingIndent > 0) {
        const block = [...this.pendingLines];
        this.pendingLines = [];
        this.pendingIndent = 0;
        return this.runBlocksSync(parseBlocks(block));
      }
      this.pendingLines.push(stripped);
      const d = indent(stripped);
      if (d > 0) this.pendingIndent = d;
      return [];
    }

    if (stripped && isCompoundHeader(stripped.trim())) {
      this.pendingLines = [stripped];
      this.pendingIndent = 0;
      return [];
    }

    return this.runSingleSync(stripped.trim());
  }

  private runSingleSync(line: string): string[] | InputRequest {
    if (!line || line.startsWith("#")) return [];
    try {
      const r = this.execStmtSync(line, this.env);
      if (r instanceof InputRequest) return r;
      return this.formatResult(r);
    } catch (e: any) {
      if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) return [];
      return [e.message ?? String(e)];
    }
  }

  private runBlocksSync(blocks: Block[]): string[] | InputRequest {
    const out: string[] = [];
    for (const block of blocks) {
      try {
        const r = this.execBlockSync(block, this.env);
        if (r instanceof InputRequest) return r;
        out.push(...r);
      } catch (e: any) {
        if (e instanceof BreakSignal || e instanceof ContinueSignal) continue;
        if (e instanceof ReturnSignal) continue;
        out.push(e.message ?? String(e));
      }
    }
    return out;
  }

  private execBlockSync(block: Block, env: PyEnv): string[] | InputRequest {
    if (block.type === "simple") {
      const r = this.execStmtSync(block.line, env);
      if (r instanceof InputRequest) return r;
      return this.formatResult(r);
    }
    return this.execCompoundSync(block, env);
  }

  private execCompoundSync(block: CompoundBlock, env: PyEnv): string[] | InputRequest {
    const out: string[] = [];
    const { clauses } = block;
    const header = clauses[0].header;

    // ── def ──────────────────────────────────────────────────────────────
    if (header.startsWith("def ")) {
      const m = header.match(/^def\s+(\w+)\s*\(([^)]*)\)\s*:/);
      if (!m) throw new PythonError("SyntaxError", `invalid def: ${header}`);
      const name = m[1];
      const rawParams = m[2] ? m[2].split(",").map(p => p.trim()).filter(Boolean) : [];
      const params: string[] = [];
      const defaults: PyValue[] = [];
      for (const rp of rawParams) {
        const eq = rp.indexOf("=");
        if (eq >= 0) {
          params.push(rp.slice(0, eq).trim());
          defaults.push(this.evalExpr(rp.slice(eq + 1).trim(), env));
        } else {
          params.push(rp);
        }
      }
      const fn: PyFunction = { __type: "fn", name, params, defaults, body: clauses[0].body, closure: new Map(env) };
      env.set(name, fn);
      return [];
    }

    // ── class ─────────────────────────────────────────────────────────
    if (header.startsWith("class ")) return [];

    // ── for ───────────────────────────────────────────────────────────
    if (header.startsWith("for ")) {
      const m = header.match(/^for\s+(.+?)\s+in\s+(.+)\s*:/);
      if (!m) throw new PythonError("SyntaxError", `invalid for: ${header}`);
      const varPart = m[1].trim();
      const iterable = this.toIterable(this.evalExpr(m[2].trim(), env));
      const body = clauses[0].body;
      let iterations = 0;
      outer: for (const item of iterable) {
        if (++iterations > 10000) { out.push("\x1b[31mRuntimeError: max iterations exceeded\x1b[0m"); break; }
        this.assignTarget(varPart, item, env);
        const bodyBlocks = parseBlocks(body);
        try {
          for (const b of bodyBlocks) {
            const r = this.execBlockSync(b, env);
            if (r instanceof InputRequest) return r;
            out.push(...r);
          }
        } catch (e: any) {
          if (e instanceof BreakSignal) break outer;
          if (e instanceof ContinueSignal) continue;
          throw e;
        }
      }
      return out;
    }

    // ── while ─────────────────────────────────────────────────────────
    if (header.startsWith("while ")) {
      const cond = header.replace(/^while\s+/, "").replace(/:$/, "").trim();
      const body = clauses[0].body;
      let iterations = 0;
      outer: while (this.isTruthy(this.evalExpr(cond, env))) {
        if (++iterations > 10000) { out.push("\x1b[31mRuntimeError: max iterations exceeded\x1b[0m"); break; }
        const bodyBlocks = parseBlocks(body);
        try {
          for (const b of bodyBlocks) {
            const r = this.execBlockSync(b, env);
            if (r instanceof InputRequest) return r;
            out.push(...r);
          }
        } catch (e: any) {
          if (e instanceof BreakSignal) break outer;
          if (e instanceof ContinueSignal) continue;
          throw e;
        }
      }
      return out;
    }

    // ── if/elif/else ──────────────────────────────────────────────────
    if (header.startsWith("if ")) {
      for (const clause of clauses) {
        let run = false;
        if (clause.header === "else:") {
          run = true;
        } else {
          const cond = clause.header.replace(/^(if|elif)\s+/, "").replace(/:$/, "").trim();
          run = this.isTruthy(this.evalExpr(cond, env));
        }
        if (run) {
          const bodyBlocks = parseBlocks(clause.body);
          for (const b of bodyBlocks) {
            const r = this.execBlockSync(b, env);
            if (r instanceof InputRequest) return r;
            out.push(...r);
          }
          break;
        }
      }
      return out;
    }

    // ── try/except/finally ────────────────────────────────────────────
    if (header.startsWith("try:") || header === "try:") {
      const tryClause = clauses.find(c => c.header === "try:");
      const exceptClause = clauses.find(c => /^except/.test(c.header));
      const finallyClause = clauses.find(c => c.header === "finally:");
      try {
        if (tryClause) {
          for (const b of parseBlocks(tryClause.body)) {
            const r = this.execBlockSync(b, env);
            if (r instanceof InputRequest) return r;
            out.push(...r);
          }
        }
      } catch (e: any) {
        if (exceptClause) {
          // bind exception variable if "except X as e:"
          const excM = exceptClause.header.match(/^except\s+\w+\s+as\s+(\w+)\s*:/);
          if (excM) env.set(excM[1], e.message ?? String(e));
          for (const b of parseBlocks(exceptClause.body)) {
            const r = this.execBlockSync(b, env);
            if (r instanceof InputRequest) return r;
            out.push(...r);
          }
        }
      } finally {
        if (finallyClause) {
          for (const b of parseBlocks(finallyClause.body)) {
            const r = this.execBlockSync(b, env);
            if (r instanceof InputRequest) return r;
            out.push(...r);
          }
        }
      }
      return out;
    }

    // ── with ──────────────────────────────────────────────────────────
    if (header.startsWith("with ")) {
      for (const b of parseBlocks(clauses[0].body)) {
        const r = this.execBlockSync(b, env);
        if (r instanceof InputRequest) return r;
        out.push(...r);
      }
      return out;
    }

    return out;
  }

  // ── Script mode: async execution ──────────────────────────────────────

  async runScript(code: string, onOutput: OutputFn, onInput: InputFn): Promise<void> {
    this.interrupted = false;
    const lines = code.split("\n");
    const blocks = parseBlocks(lines);
    for (const block of blocks) {
      if (this.interrupted) break;
      await this.execBlockAsync(block, this.env, onOutput, onInput);
    }
  }

  private async execBlockAsync(block: Block, env: PyEnv, onOutput: OutputFn, onInput: InputFn): Promise<void> {
    if (block.type === "simple") {
      await this.execStmtAsync(block.line, env, onOutput, onInput);
      return;
    }
    await this.execCompoundAsync(block, env, onOutput, onInput);
  }

  private async execCompoundAsync(block: CompoundBlock, env: PyEnv, onOutput: OutputFn, onInput: InputFn): Promise<void> {
    const { clauses } = block;
    const header = clauses[0].header;

    if (header.startsWith("def ")) {
      this.execCompoundSync(block, env); // def is always sync
      return;
    }
    if (header.startsWith("class ")) return;

    if (header.startsWith("for ")) {
      const m = header.match(/^for\s+(.+?)\s+in\s+(.+)\s*:/);
      if (!m) throw new PythonError("SyntaxError", `invalid for: ${header}`);
      const varPart = m[1].trim();
      const iterable = this.toIterable(this.evalExpr(m[2].trim(), env));
      const body = clauses[0].body;
      let iterations = 0;
      outer: for (const item of iterable) {
        if (this.interrupted) break;
        if (++iterations > 10000) { onOutput("\x1b[31mRuntimeError: max iterations exceeded\x1b[0m"); break; }
        this.assignTarget(varPart, item, env);
        try {
          for (const b of parseBlocks(body)) {
            await this.execBlockAsync(b, env, onOutput, onInput);
          }
        } catch (e: any) {
          if (e instanceof BreakSignal) break outer;
          if (e instanceof ContinueSignal) continue;
          throw e;
        }
      }
      return;
    }

    if (header.startsWith("while ")) {
      const cond = header.replace(/^while\s+/, "").replace(/:$/, "").trim();
      const body = clauses[0].body;
      let iterations = 0;
      outer: while (this.isTruthy(this.evalExpr(cond, env))) {
        if (this.interrupted) break;
        if (++iterations > 10000) { onOutput("\x1b[31mRuntimeError: max iterations exceeded\x1b[0m"); break; }
        try {
          for (const b of parseBlocks(body)) {
            await this.execBlockAsync(b, env, onOutput, onInput);
          }
        } catch (e: any) {
          if (e instanceof BreakSignal) break outer;
          if (e instanceof ContinueSignal) continue;
          throw e;
        }
      }
      return;
    }

    if (header.startsWith("if ")) {
      for (const clause of clauses) {
        let run = false;
        if (clause.header === "else:") {
          run = true;
        } else {
          const cond = clause.header.replace(/^(if|elif)\s+/, "").replace(/:$/, "").trim();
          run = this.isTruthy(this.evalExpr(cond, env));
        }
        if (run) {
          for (const b of parseBlocks(clause.body)) {
            await this.execBlockAsync(b, env, onOutput, onInput);
          }
          break;
        }
      }
      return;
    }

    if (header.startsWith("try:") || header === "try:") {
      const tryClause = clauses.find(c => c.header === "try:");
      const exceptClause = clauses.find(c => /^except/.test(c.header));
      const finallyClause = clauses.find(c => c.header === "finally:");
      try {
        if (tryClause) {
          for (const b of parseBlocks(tryClause.body)) {
            await this.execBlockAsync(b, env, onOutput, onInput);
          }
        }
      } catch (e: any) {
        if (exceptClause) {
          const excM = exceptClause.header.match(/^except\s+\w+\s+as\s+(\w+)\s*:/);
          if (excM) env.set(excM[1], e.message ?? String(e));
          for (const b of parseBlocks(exceptClause.body)) {
            await this.execBlockAsync(b, env, onOutput, onInput);
          }
        }
      } finally {
        if (finallyClause) {
          for (const b of parseBlocks(finallyClause.body)) {
            await this.execBlockAsync(b, env, onOutput, onInput);
          }
        }
      }
      return;
    }

    if (header.startsWith("with ")) {
      for (const b of parseBlocks(clauses[0].body)) {
        await this.execBlockAsync(b, env, onOutput, onInput);
      }
      return;
    }
  }

  // ── Statement executors ───────────────────────────────────────────────

  private execStmtSync(stmt: string, env: PyEnv): any {
    stmt = stmt.trim();
    if (!stmt || stmt.startsWith("#")) return null;

    if (stmt === "pass") return null;
    if (stmt === "break") throw new BreakSignal();
    if (stmt === "continue") throw new ContinueSignal();

    if (stmt === "return" || stmt.startsWith("return ") || stmt.startsWith("return\t")) {
      const val = stmt === "return" ? null : this.evalExpr(stmt.slice(7).trim(), env);
      throw new ReturnSignal(val);
    }

    if (stmt.startsWith("del ")) { env.delete(stmt.slice(4).trim()); return null; }
    if (stmt.startsWith("global ") || stmt.startsWith("nonlocal ")) return null;

    if (stmt.startsWith("raise")) {
      const msg = stmt.slice(5).trim();
      throw new PythonError("RuntimeError", msg || "exception raised");
    }

    if (stmt.startsWith("assert ")) {
      const expr = stmt.slice(7).trim();
      if (!this.isTruthy(this.evalExpr(expr, env)))
        throw new PythonError("AssertionError", "");
      return null;
    }

    if (stmt === "exit()" || stmt === "quit()") {
      const r: any = ["\x1b[33mSession active — use Ctrl+C to interrupt.\x1b[0m"];
      r.__flat = true; return r;
    }

    if (stmt === "help()" || stmt === "help") return this.helpText();

    // augmented assignment
    const augM = stmt.match(/^(.+?)\s*(\+=|-=|\*=|\/=|\/\/=|\*\*=|%=|&=|\|=|\^=)\s*(.+)$/);
    if (augM) {
      const [, lhs, op, rhsExpr] = augM;
      const rhs = this.evalExpr(rhsExpr, env);
      this.applyAugAssign(lhs.trim(), op, rhs, env);
      return null;
    }

    // index/subscript assignment: a[k] = v
    const idxAssignM = this.matchIndexAssign(stmt);
    if (idxAssignM) {
      const { obj, idx, val } = idxAssignM;
      const container = env.get(obj);
      const idxVal = this.evalExpr(idx, env);
      const valVal = this.evalExpr(val, env);
      if (Array.isArray(container)) container[idxVal as number] = valVal;
      else if (container && (container as PyDict).__type === "dict")
        (container as PyDict).entries.set(this.pyStr(idxVal), valVal);
      return null;
    }

    // plain / tuple assignment
    const assignM = this.matchAssign(stmt);
    if (assignM) {
      const { lhs, rhs } = assignM;
      const val = this.evalExprOrInput(rhs, env);
      if (val instanceof InputRequest) return val; // propagate to REPL
      this.assignTarget(lhs, val, env);
      return null;
    }

    // print / input special forms
    if (stmt.startsWith("print(")) return this.execPrint(stmt, env);
    if (stmt.startsWith("input(")) {
      const inner = stmt.slice(6, stmt.length - 1).trim();
      const prompt = inner ? this.pyStr(this.evalExpr(inner, env)) : "";
      return new InputRequest(prompt);
    }

    // expression
    const val = this.evalExpr(stmt, env);
    if (val === null || val === undefined) return null;
    return val;
  }

  private async execStmtAsync(stmt: string, env: PyEnv, onOutput: OutputFn, onInput: InputFn): Promise<void> {
    stmt = stmt.trim();
    if (!stmt || stmt.startsWith("#")) return;

    if (stmt === "pass") return;
    if (stmt === "break") throw new BreakSignal();
    if (stmt === "continue") throw new ContinueSignal();

    if (stmt === "return" || stmt.startsWith("return ") || stmt.startsWith("return\t")) {
      const valExpr = stmt === "return" ? null : stmt.slice(7).trim();
      let val: PyValue = null;
      if (valExpr) {
        if (valExpr.includes("input(")) {
          val = await this.resolveInputExpr(valExpr, env, onInput);
        } else {
          val = this.evalExpr(valExpr, env);
        }
      }
      throw new ReturnSignal(val);
    }

    if (stmt.startsWith("del ")) { env.delete(stmt.slice(4).trim()); return; }
    if (stmt.startsWith("global ") || stmt.startsWith("nonlocal ")) return;

    if (stmt.startsWith("raise")) {
      const msg = stmt.slice(5).trim();
      throw new PythonError("RuntimeError", msg || "exception raised");
    }

    if (stmt.startsWith("assert ")) {
      const expr = stmt.slice(7).trim();
      if (!this.isTruthy(this.evalExpr(expr, env)))
        throw new PythonError("AssertionError", "");
      return;
    }

    if (stmt === "exit()" || stmt === "quit()") {
      onOutput("\x1b[33mSession active — use Ctrl+C to interrupt.\x1b[0m");
      return;
    }
    if (stmt === "help()" || stmt === "help") {
      this.helpText().__flat && (this.helpText() as any).forEach((l: string) => onOutput(l));
      return;
    }

    // print
    if (stmt.startsWith("print(")) {
      const r = this.execPrint(stmt, env);
      if (r) {
        if ((r as any).__flat) (r as string[]).forEach(l => onOutput(l));
        else onOutput(this.pyStr(r as PyValue));
      }
      return;
    }

    // standalone input()
    if (/^input\s*\(/.test(stmt)) {
      const inner = stmt.slice(stmt.indexOf("(") + 1, stmt.length - 1).trim();
      const prompt = inner ? this.pyStr(this.evalExpr(inner, env)) : "";
      await onInput(prompt); // discard result
      return;
    }

    // augmented assignment
    const augM = stmt.match(/^(.+?)\s*(\+=|-=|\*=|\/=|\/\/=|\*\*=|%=|&=|\|=|\^=)\s*(.+)$/);
    if (augM) {
      const [, lhs, op, rhsExpr] = augM;
      const rhs = rhsExpr.includes("input(")
        ? await this.resolveInputExpr(rhsExpr, env, onInput)
        : this.evalExpr(rhsExpr, env);
      this.applyAugAssign(lhs.trim(), op, rhs, env);
      return;
    }

    // index assign
    const idxAssignM = this.matchIndexAssign(stmt);
    if (idxAssignM) {
      const { obj, idx, val } = idxAssignM;
      const container = env.get(obj);
      const idxVal = this.evalExpr(idx, env);
      const valVal = val.includes("input(")
        ? await this.resolveInputExpr(val, env, onInput)
        : this.evalExpr(val, env);
      if (Array.isArray(container)) container[idxVal as number] = valVal;
      else if (container && (container as PyDict).__type === "dict")
        (container as PyDict).entries.set(this.pyStr(idxVal), valVal);
      return;
    }

    // plain / tuple assignment (handles x = input(...) and x = int(input(...)))
    const assignM = this.matchAssign(stmt);
    if (assignM) {
      const { lhs, rhs } = assignM;
      const val = rhs.includes("input(")
        ? await this.resolveInputExpr(rhs, env, onInput)
        : this.evalExpr(rhs, env);
      this.assignTarget(lhs, val, env);
      return;
    }

    // expression (function calls with side effects, etc.)
    const result = this.evalExpr(stmt, env);
    if (result !== null && result !== undefined) {
      if ((result as any).__flat) (result as string[]).forEach(l => onOutput(l));
      else onOutput(this.repr(result as PyValue));
    }
  }

  /** Resolves an expression that contains input() calls by awaiting them */
  private async resolveInputExpr(expr: string, env: PyEnv, onInput: InputFn): Promise<PyValue> {
    // Replace input(...) in the expression with a placeholder, evaluate, substitute
    // We support: input("p"), int(input("p")), float(input("p")), str(input("p"))
    const inputRx = /input\(([^)]*)\)/g;
    let resolved = expr;
    let m;
    const placeholders: Record<string, PyValue> = {};
    let idx = 0;

    // Reset regex
    inputRx.lastIndex = 0;
    const matches: { full: string; inner: string }[] = [];
    while ((m = inputRx.exec(expr)) !== null) {
      matches.push({ full: m[0], inner: m[1] });
    }

    for (const { full, inner } of matches) {
      const promptStr = inner.trim() ? this.pyStr(this.evalExpr(inner.trim(), env)) : "";
      const userInput = await onInput(promptStr);
      const ph = `__inp${idx++}__`;
      env.set(ph, userInput);
      resolved = resolved.replace(full, ph);
      placeholders[ph] = userInput;
    }

    const result = this.evalExpr(resolved, env);
    // clean up placeholders
    for (const ph of Object.keys(placeholders)) env.delete(ph);
    return result;
  }

  // ── Expression evaluation ─────────────────────────────────────────────

  evalExpr(expr: string, env: PyEnv): PyValue {
    expr = expr.trim();
    if (!expr) return null;

    // Literals
    if (expr === "True") return true;
    if (expr === "False") return false;
    if (expr === "None") return null;
    if (expr === "...") return null;

    // Numbers
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(expr)) return parseFloat(expr);

    // Strings
    const strVal = this.parseString(expr);
    if (strVal !== undefined) return strVal;

    // f-strings
    if (/^f["']/.test(expr)) return this.evalFString(expr, env);

    // List
    if (expr.startsWith("[") && expr.endsWith("]")) return this.evalList(expr, env);

    // Dict / Set
    if (expr.startsWith("{") && expr.endsWith("}")) return this.evalDictOrSet(expr, env);

    // Tuple / grouped expression
    if (expr.startsWith("(") && expr.endsWith(")")) {
      const inner = expr.slice(1, -1).trim();
      if (!inner) return [];
      const parts = this.splitArgs(inner);
      if (parts.length > 1) return parts.map(p => this.evalExpr(p, env));
      return this.evalExpr(inner, env);
    }

    // Ternary: x if cond else y
    {
      const ternM = this.splitTernary(expr);
      if (ternM) {
        return this.isTruthy(this.evalExpr(ternM.cond, env))
          ? this.evalExpr(ternM.t, env)
          : this.evalExpr(ternM.f, env);
      }
    }

    // Boolean operators
    const orParts = this.splitByKeyword(expr, "or");
    if (orParts.length > 1) {
      for (const p of orParts) {
        const v = this.evalExpr(p, env);
        if (this.isTruthy(v)) return v;
      }
      return this.evalExpr(orParts[orParts.length - 1], env);
    }

    const andParts = this.splitByKeyword(expr, "and");
    if (andParts.length > 1) {
      let last: PyValue = true;
      for (const p of andParts) {
        last = this.evalExpr(p, env);
        if (!this.isTruthy(last)) return last;
      }
      return last;
    }

    if (/^not\s+/.test(expr)) return !this.isTruthy(this.evalExpr(expr.slice(4).trim(), env));

    // Comparisons
    const cmpResult = this.evalComparison(expr, env);
    if (cmpResult !== undefined) return cmpResult;

    // Arithmetic
    const arithResult = this.evalArithmetic(expr, env);
    if (arithResult !== undefined) return arithResult;

    // Unary minus
    if (expr.startsWith("-")) {
      const inner = expr.slice(1).trim();
      return -(this.evalExpr(inner, env) as number);
    }

    // Method call: obj.method(args)
    const methM = this.matchMethodCall(expr);
    if (methM) {
      const obj = this.evalExpr(methM.obj, env);
      const args = methM.argsRaw ? this.splitArgs(methM.argsRaw).map(a => this.evalExpr(a.trim(), env)) : [];
      return this.callMethod(obj, methM.method, args, env);
    }

    // Attribute access: obj.attr
    const attrM = this.matchAttr(expr);
    if (attrM) {
      const obj = this.evalExpr(attrM.obj, env);
      return this.getAttr(obj, attrM.attr);
    }

    // Subscript: obj[key] or obj[a:b] or obj[a:b:c]
    const subM = this.matchSubscript(expr);
    if (subM) return this.evalSubscript(subM.obj, subM.key, env);

    // Function call: name(args)
    const callM = this.matchCall(expr);
    if (callM) {
      const { fn: fnExpr, argsRaw } = callM;
      const args = argsRaw ? this.splitArgs(argsRaw).map(a => this.evalExpr(a.trim(), env)) : [];
      return this.callFn(fnExpr, args, env);
    }

    // Variable
    if (/^[a-zA-Z_]\w*$/.test(expr)) {
      if (env.has(expr)) return env.get(expr)!;
      throw new PythonError("NameError", `name '${expr}' is not defined`);
    }

    throw new PythonError("SyntaxError", `invalid syntax near: ${expr}`);
  }

  private evalExprOrInput(expr: string, env: PyEnv): PyValue | InputRequest {
    if (expr.trim().startsWith("input(")) {
      const inner = expr.trim().slice(6, expr.trim().length - 1).trim();
      const prompt = inner ? this.pyStr(this.evalExpr(inner, env)) : "";
      return new InputRequest(prompt);
    }
    return this.evalExpr(expr, env);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private matchAssign(stmt: string): { lhs: string; rhs: string } | null {
    // Find the first unparenthesized `=` that is not ==, !=, <=, >=, :=
    let depth = 0;
    let inStr = false;
    let strChar = "";
    for (let i = 0; i < stmt.length; i++) {
      const ch = stmt[i];
      if (inStr) {
        if (ch === strChar && stmt[i - 1] !== "\\") inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; strChar = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
      if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
      if (depth === 0 && ch === "=") {
        const prev = stmt[i - 1];
        const next = stmt[i + 1];
        if (next === "=" || prev === "!" || prev === "<" || prev === ">" || prev === "=" || prev === "+" || prev === "-" || prev === "*" || prev === "/" || prev === "%" || prev === "&" || prev === "|" || prev === "^") continue;
        const lhs = stmt.slice(0, i).trim();
        const rhs = stmt.slice(i + 1).trim();
        if (/^[a-zA-Z_]\w*(\s*,\s*[a-zA-Z_]\w*)*$/.test(lhs) ||
          /^\*?[a-zA-Z_]\w*$/.test(lhs)) {
          return { lhs, rhs };
        }
        return null;
      }
    }
    return null;
  }

  private matchIndexAssign(stmt: string): { obj: string; idx: string; val: string } | null {
    const m = stmt.match(/^([a-zA-Z_]\w*)\[(.+)\]\s*=\s*(.+)$/);
    if (!m || stmt.includes("==")) return null;
    return { obj: m[1], idx: m[2], val: m[3] };
  }

  private matchMethodCall(expr: string): { obj: string; method: string; argsRaw: string } | null {
    // Find last .method(...) at depth 0
    let depth = 0;
    let inStr = false; let strChar = "";
    for (let i = expr.length - 1; i >= 0; i--) {
      const ch = expr[i];
      if (inStr) {
        if (ch === strChar) inStr = false;
        continue;
      }
      if (ch === ")" || ch === "]") depth++;
      else if (ch === "(" || ch === "[") depth--;
      if (depth === 0 && ch === "(") {
        // find matching )
        const closeIdx = this.findClose(expr, i);
        if (closeIdx !== expr.length - 1) continue;
        // check for .method
        const before = expr.slice(0, i);
        const dotIdx = before.lastIndexOf(".");
        if (dotIdx < 0) return null;
        const method = before.slice(dotIdx + 1).trim();
        if (!/^\w+$/.test(method)) return null;
        const obj = before.slice(0, dotIdx).trim();
        const argsRaw = expr.slice(i + 1, closeIdx);
        return { obj, method, argsRaw };
      }
    }
    return null;
  }

  private matchAttr(expr: string): { obj: string; attr: string } | null {
    const m = expr.match(/^(.+)\.([a-zA-Z_]\w*)$/);
    if (!m) return null;
    return { obj: m[1], attr: m[2] };
  }

  private matchSubscript(expr: string): { obj: string; key: string } | null {
    if (!expr.endsWith("]")) return null;
    const open = this.findOpenBracket(expr);
    if (open < 0) return null;
    return { obj: expr.slice(0, open), key: expr.slice(open + 1, expr.length - 1) };
  }

  private matchCall(expr: string): { fn: string; argsRaw: string } | null {
    if (!expr.endsWith(")")) return null;
    const open = this.findOpenParen(expr);
    if (open < 0) return null;
    return { fn: expr.slice(0, open).trim(), argsRaw: expr.slice(open + 1, expr.length - 1) };
  }

  private findClose(expr: string, open: number): number {
    let depth = 0;
    for (let i = open; i < expr.length; i++) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")") { depth--; if (depth === 0) return i; }
    }
    return expr.length - 1;
  }

  private findOpenBracket(expr: string): number {
    let depth = 0;
    for (let i = expr.length - 1; i >= 0; i--) {
      if (expr[i] === "]") depth++;
      else if (expr[i] === "[") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  private findOpenParen(expr: string): number {
    let depth = 0;
    for (let i = expr.length - 1; i >= 0; i--) {
      if (expr[i] === ")") depth++;
      else if (expr[i] === "(") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  private evalSubscript(objExpr: string, keyExpr: string, env: PyEnv): PyValue {
    const obj = this.evalExpr(objExpr, env);
    if (keyExpr.includes(":")) {
      const parts = keyExpr.split(":").map(p => p.trim());
      const a = parts[0] ? this.evalExpr(parts[0], env) as number : undefined;
      const b = parts[1] ? this.evalExpr(parts[1], env) as number : undefined;
      const c = parts[2] ? this.evalExpr(parts[2], env) as number : undefined;
      if (Array.isArray(obj)) return this.sliceList(obj, a, b, c);
      if (typeof obj === "string") return (obj as string).slice(a, b);
      return null;
    }
    const idx = this.evalExpr(keyExpr, env);
    if (Array.isArray(obj)) {
      const i = idx as number;
      return i < 0 ? obj[obj.length + i] : obj[i];
    }
    if (typeof obj === "string") {
      const i = idx as number;
      return i < 0 ? (obj as string)[(obj as string).length + i] : (obj as string)[i] ?? null;
    }
    if (obj && (obj as PyDict).__type === "dict")
      return (obj as PyDict).entries.get(this.pyStr(idx)) ?? null;
    return null;
  }

  private sliceList(arr: PyValue[], a?: number, b?: number, c?: number): PyValue[] {
    const len = arr.length;
    const step = c ?? 1;
    const start = a !== undefined ? (a < 0 ? Math.max(0, len + a) : Math.min(a, len)) : (step > 0 ? 0 : len - 1);
    const stop = b !== undefined ? (b < 0 ? Math.max(-1, len + b) : Math.min(b, len)) : (step > 0 ? len : -1);
    const result: PyValue[] = [];
    if (step > 0) { for (let i = start; i < stop; i += step) result.push(arr[i]); }
    else { for (let i = start; i > stop; i += step) result.push(arr[i]); }
    return result;
  }

  private evalList(expr: string, env: PyEnv): PyValue {
    const inner = expr.slice(1, -1).trim();
    if (!inner) return [];
    // list comprehension
    const compM = inner.match(/^(.+?)\s+for\s+(\w[\w,\s]*)\s+in\s+(.+?)(?:\s+if\s+(.+))?$/);
    if (compM) {
      const [, exprPart, varPart, iterExpr, condExpr] = compM;
      const iterable = this.toIterable(this.evalExpr(iterExpr, env));
      const result: PyValue[] = [];
      for (const item of iterable) {
        const localEnv = new Map(env);
        this.assignTarget(varPart.trim(), item, localEnv);
        if (condExpr && !this.isTruthy(this.evalExpr(condExpr, localEnv))) continue;
        result.push(this.evalExpr(exprPart, localEnv));
      }
      return result;
    }
    return this.splitArgs(inner).map(a => this.evalExpr(a.trim(), env));
  }

  private evalDictOrSet(expr: string, env: PyEnv): PyValue {
    const inner = expr.slice(1, -1).trim();
    if (!inner) return { __type: "dict", entries: new Map() };
    const pairs = this.splitArgs(inner);
    const d: PyDict = { __type: "dict", entries: new Map() };
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx < 0) continue;
      const k = this.evalExpr(pair.slice(0, colonIdx).trim(), env);
      const v = this.evalExpr(pair.slice(colonIdx + 1).trim(), env);
      d.entries.set(this.pyStr(k), v as PyValue);
    }
    return d;
  }

  private evalFString(expr: string, env: PyEnv): string {
    const q = expr[1];
    const raw = expr.slice(2, -1);
    let result = "";
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "{" && raw[i + 1] !== "{") {
        let depth = 1; let j = i + 1;
        while (j < raw.length && depth > 0) {
          if (raw[j] === "{") depth++;
          else if (raw[j] === "}") depth--;
          if (depth > 0) j++;
          else break;
        }
        const innerExpr = raw.slice(i + 1, j);
        const fmtIdx = innerExpr.indexOf(":");
        const evalPart = fmtIdx >= 0 ? innerExpr.slice(0, fmtIdx) : innerExpr;
        try {
          const val = this.evalExpr(evalPart.trim(), env);
          result += this.pyStr(val);
        } catch {
          result += `{${innerExpr}}`;
        }
        i = j + 1;
      } else if (raw[i] === "{" && raw[i + 1] === "{") {
        result += "{"; i += 2;
      } else if (raw[i] === "}" && raw[i + 1] === "}") {
        result += "}"; i += 2;
      } else {
        result += raw[i++];
      }
    }
    return result.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }

  private parseString(expr: string): string | undefined {
    // triple-quoted
    if (expr.startsWith('"""') && expr.endsWith('"""')) return expr.slice(3, -3);
    if (expr.startsWith("'''") && expr.endsWith("'''")) return expr.slice(3, -3);
    // single-quoted
    const q = expr[0];
    if ((q === '"' || q === "'") && expr.endsWith(q) && expr.length >= 2) {
      // make sure no unescaped quote in the middle
      let i = 1;
      while (i < expr.length - 1) {
        if (expr[i] === q && expr[i - 1] !== "\\") return undefined; // embedded quote
        i++;
      }
      return expr.slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
    }
    return undefined;
  }

  private splitTernary(expr: string): { t: string; cond: string; f: string } | null {
    // x if condition else y  — split at outermost "if" and "else"
    const tokens = this.tokenizeForTernary(expr);
    if (!tokens) return null;
    return tokens;
  }

  private tokenizeForTernary(expr: string): { t: string; cond: string; f: string } | null {
    // Find " if " and " else " at depth 0
    let depth = 0; let inStr = false; let strCh = "";
    const ifPositions: number[] = [];
    const elsePositions: number[] = [];
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inStr) { if (ch === strCh && expr[i - 1] !== "\\") inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (depth === 0) {
        if (expr.slice(i).match(/^if\s/) && (i === 0 || expr[i - 1] === " ")) ifPositions.push(i);
        if (expr.slice(i).match(/^else\s/) && (i === 0 || expr[i - 1] === " ")) elsePositions.push(i);
      }
    }
    if (ifPositions.length === 0 || elsePositions.length === 0) return null;
    const ifIdx = ifPositions[0];
    const elseIdx = elsePositions[elsePositions.length - 1];
    if (ifIdx === 0 || elseIdx <= ifIdx) return null;
    const t = expr.slice(0, ifIdx).trim();
    const cond = expr.slice(ifIdx + 3, elseIdx).trim();
    const f = expr.slice(elseIdx + 5).trim();
    return { t, cond, f };
  }

  private evalComparison(expr: string, env: PyEnv): boolean | undefined {
    const ops = [" is not ", " not in ", " is ", " in ", "==", "!=", "<=", ">=", "<", ">"];
    for (const op of ops) {
      const idx = this.findOpAtDepth0(expr, op);
      if (idx < 0) continue;
      const left = this.evalExpr(expr.slice(0, idx).trim(), env);
      const right = this.evalExpr(expr.slice(idx + op.length).trim(), env);
      switch (op.trim()) {
        case "==": return this.pyEqual(left, right);
        case "!=": return !this.pyEqual(left, right);
        case "<=": return (left as number) <= (right as number);
        case ">=": return (left as number) >= (right as number);
        case "<": return (left as number) < (right as number);
        case ">": return (left as number) > (right as number);
        case "in": return this.pyIn(left, right);
        case "not in": return !this.pyIn(left, right);
        case "is": return left === right;
        case "is not": return left !== right;
      }
    }
    return undefined;
  }

  private evalArithmetic(expr: string, env: PyEnv): PyValue | undefined {
    // Ordered by precedence (lowest first for right-to-left scanning)
    const opGroups = [["+", "-"], ["*", "/", "//", "%"], ["**"]];
    for (const group of opGroups) {
      for (const op of group) {
        const idx = this.findOpAtDepth0(expr, op);
        if (idx <= 0) continue;
        // skip if preceded by operator char (unary)
        const prev = expr[idx - 1];
        if ((op === "+" || op === "-") && "+-*/(%[,=".includes(prev)) continue;
        const leftExpr = expr.slice(0, idx).trim();
        const rightExpr = expr.slice(idx + op.length).trim();
        if (!leftExpr || !rightExpr) continue;
        const left = this.evalExpr(leftExpr, env);
        const right = this.evalExpr(rightExpr, env);
        if (op === "+") {
          if (typeof left === "string") return left + this.pyStr(right);
          if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
          return (left as number) + (right as number);
        }
        if (op === "-") return (left as number) - (right as number);
        if (op === "*") {
          if (typeof left === "string" && typeof right === "number") return (left as string).repeat(right);
          if (Array.isArray(left) && typeof right === "number") return Array.from({ length: right }, () => [...left as PyValue[]]).flat() as PyValue[];
          return (left as number) * (right as number);
        }
        if (op === "/") return (left as number) / (right as number);
        if (op === "//") return Math.floor((left as number) / (right as number));
        if (op === "%") {
          if (typeof left === "string") return this.pyStrFormat(left as string, right, env);
          return (left as number) % (right as number);
        }
        if (op === "**") return Math.pow(left as number, right as number);
      }
    }
    return undefined;
  }

  private findOpAtDepth0(expr: string, op: string): number {
    let depth = 0; let inStr = false; let strCh = "";
    const pad = op.trim() !== op; // operator has spaces
    // Scan right-to-left for +/-, left-to-right for ** to handle precedence
    const scan = (op === "**") ? "ltr" : "rtl";
    const len = expr.length;
    const step = scan === "rtl" ? -1 : 1;
    const start = scan === "rtl" ? len - op.length : 0;
    const end = scan === "rtl" ? 0 : len - op.length + 1;

    for (let i = start; scan === "rtl" ? i >= end : i < end; i += step) {
      const ch = expr[i];
      if (!inStr) {
        if (ch === '"' || ch === "'") { inStr = true; strCh = ch; }
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (depth === 0 && expr.slice(i, i + op.length) === op) {
          return i;
        }
      } else {
        if (ch === strCh && expr[i - 1] !== "\\") inStr = false;
      }
    }
    return -1;
  }

  private pyStrFormat(fmt: string, args: PyValue, env: PyEnv): string {
    let i = 0;
    const argArr = Array.isArray(args) ? args : [args];
    return fmt.replace(/%[sdiouxXeEfgG%]/g, (spec) => {
      if (spec === "%%") return "%";
      const a = argArr[i++];
      if (spec === "%s") return this.pyStr(a);
      if (spec === "%d" || spec === "%i") return String(Math.trunc(a as number));
      if (spec === "%f") return (a as number).toFixed(6);
      return this.pyStr(a);
    });
  }

  private splitByKeyword(expr: string, kw: string): string[] {
    const pattern = new RegExp(`\\s+${kw}\\s+`);
    const parts: string[] = [];
    let depth = 0; let inStr = false; let strCh = "";
    let last = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (inStr) { if (ch === strCh && expr[i - 1] !== "\\") inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (depth === 0) {
        const sub = expr.slice(i);
        const m = sub.match(new RegExp(`^\\s+${kw}\\s+`));
        if (m && i > 0) {
          parts.push(expr.slice(last, i).trim());
          last = i + m[0].length;
          i = last - 1;
        }
      }
    }
    parts.push(expr.slice(last).trim());
    return parts.length > 1 ? parts.filter(Boolean) : [expr];
  }

  // ── Function calling ───────────────────────────────────────────────────

  private callFn(fnExpr: string, args: PyValue[], env: PyEnv): PyValue {
    // Builtins
    const r = this.callBuiltin(fnExpr, args, env);
    if (r !== undefined) return r;

    // User-defined
    const fn = env.get(fnExpr);
    if (fn && typeof fn === "object" && (fn as PyFunction).__type === "fn")
      return this.callFunction(fn as PyFunction, args);

    throw new PythonError("NameError", `name '${fnExpr}' is not defined`);
  }

  private callBuiltin(name: string, args: PyValue[], env: PyEnv): PyValue | undefined {
    switch (name) {
      case "int": return Math.trunc(typeof args[0] === "string" ? parseInt(args[0]) : args[0] as number);
      case "float": return typeof args[0] === "string" ? parseFloat(args[0]) : args[0] as number;
      case "str": return this.pyStr(args[0]);
      case "bool": return this.isTruthy(args[0]);
      case "abs": return Math.abs(args[0] as number);
      case "round": return args[1] !== undefined ? parseFloat((args[0] as number).toFixed(args[1] as number)) : Math.round(args[0] as number);
      case "len": return this.pyLen(args[0]);
      case "type": return `<class '${this.pyType(args[0])}'>`;
      case "repr": return this.repr(args[0]);
      case "range": {
        const [a, b, s] = args as number[];
        const start = b !== undefined ? a : 0;
        const stop = b !== undefined ? b : a;
        const step = s !== undefined ? s : 1;
        const result: number[] = [];
        for (let i = start; step > 0 ? i < stop : i > stop; i += step) result.push(i);
        return result;
      }
      case "list": {
        if (args[0] === null || args[0] === undefined) return [];
        if (Array.isArray(args[0])) return [...args[0]];
        if (typeof args[0] === "string") return [...(args[0] as string)] as PyValue[];
        if ((args[0] as PyDict).__type === "dict") return [...(args[0] as PyDict).entries.keys()];
        return [];
      }
      case "tuple": return Array.isArray(args[0]) ? [...args[0]] : args;
      case "dict": {
        if (!args[0]) return { __type: "dict", entries: new Map() };
        if (Array.isArray(args[0])) {
          const d: PyDict = { __type: "dict", entries: new Map() };
          for (const pair of args[0] as PyValue[][]) {
            if (Array.isArray(pair)) d.entries.set(this.pyStr(pair[0]), pair[1]);
          }
          return d;
        }
        return { __type: "dict", entries: new Map() };
      }
      case "set": {
        const items = Array.isArray(args[0]) ? args[0] : [];
        const seen = new Set<string>();
        const result: PyValue[] = [];
        for (const v of items) {
          const k = JSON.stringify(v);
          if (!seen.has(k)) { seen.add(k); result.push(v); }
        }
        return result;
      }
      case "sorted": {
        const arr = Array.isArray(args[0]) ? [...args[0]] : [];
        return arr.sort((a, b) => typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
      }
      case "reversed": return Array.isArray(args[0]) ? [...args[0]].reverse() : [];
      case "enumerate": {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        const start = (args[1] ?? 0) as number;
        return arr.map((v, i) => [i + start, v]) as PyValue[];
      }
      case "zip": {
        const arrs = args.map(a => Array.isArray(a) ? a : []);
        const minLen = Math.min(...arrs.map(a => a.length));
        return Array.from({ length: minLen }, (_, i) => arrs.map(a => a[i])) as PyValue[];
      }
      case "map": {
        if (args.length < 2 || !Array.isArray(args[1])) return [];
        const fn = args[0];
        if (fn && (fn as PyFunction).__type === "fn")
          return (args[1] as PyValue[]).map(v => this.callFunction(fn as PyFunction, [v]));
        return [];
      }
      case "filter": {
        if (args.length < 2 || !Array.isArray(args[1])) return [];
        const fn = args[0];
        if (fn === null) return (args[1] as PyValue[]).filter(v => this.isTruthy(v));
        if (fn && (fn as PyFunction).__type === "fn")
          return (args[1] as PyValue[]).filter(v => this.isTruthy(this.callFunction(fn as PyFunction, [v])));
        return [];
      }
      case "min": return args.length === 1 && Array.isArray(args[0]) ? (args[0] as number[]).reduce((a, b) => a < b ? a : b) : (args as number[]).reduce((a, b) => a < b ? a : b);
      case "max": return args.length === 1 && Array.isArray(args[0]) ? (args[0] as number[]).reduce((a, b) => a > b ? a : b) : (args as number[]).reduce((a, b) => a > b ? a : b);
      case "sum": {
        const arr = Array.isArray(args[0]) ? args[0] as number[] : args as number[];
        return arr.reduce((a: number, b: number) => a + b, (args[1] ?? 0) as number);
      }
      case "print": {
        const r: any = ["\x1b[0m" + args.map(a => this.pyStr(a)).join(" ")];
        r.__flat = true; return r;
      }
      case "input": throw new InputRequest(args[0] !== undefined ? this.pyStr(args[0]) : "");
      case "chr": return String.fromCharCode(args[0] as number);
      case "ord": return (args[0] as string).charCodeAt(0);
      case "hex": return "0x" + (args[0] as number).toString(16);
      case "bin": return "0b" + (args[0] as number).toString(2);
      case "oct": return "0o" + (args[0] as number).toString(8);
      case "pow": return Math.pow(args[0] as number, args[1] as number);
      case "id": return Math.floor(Math.random() * 1e10);
      case "hash": return typeof args[0] === "number" ? args[0] : String(args[0]).split("").reduce((a, c) => a + c.charCodeAt(0), 0);
      case "isinstance": return true;
      case "issubclass": return true;
      case "hasattr": return true;
      case "getattr": {
        const obj = args[0];
        const attr = args[1] as string;
        return this.getAttr(obj, attr) ?? (args[2] ?? null);
      }
      case "all": return Array.isArray(args[0]) ? (args[0] as PyValue[]).every(v => this.isTruthy(v)) : true;
      case "any": return Array.isArray(args[0]) ? (args[0] as PyValue[]).some(v => this.isTruthy(v)) : false;
      case "not": return !this.isTruthy(args[0]);
      case "vars": return { __type: "dict", entries: new Map(env) };
      case "dir": return [];
      case "callable": return args[0] !== null && typeof args[0] === "object" && (args[0] as PyFunction).__type === "fn";
      case "iter": return Array.isArray(args[0]) ? args[0] : [];
      case "next": return null;
      case "open": return null;
      case "format": {
        const val = args[0];
        const spec = args[1] as string ?? "";
        if (spec.endsWith("f")) return (val as number).toFixed(parseInt(spec) || 6);
        if (spec.endsWith("d")) return String(Math.trunc(val as number));
        if (spec.endsWith("s")) return this.pyStr(val);
        return this.pyStr(val);
      }
      case "divmod": return [(args[0] as number) / (args[1] as number) | 0, (args[0] as number) % (args[1] as number)] as PyValue[];
      default: return undefined;
    }
  }

  private callFunction(fn: PyFunction, args: PyValue[]): PyValue {
    const localEnv: PyEnv = new Map(fn.closure);
    fn.params.forEach((p, i) => {
      localEnv.set(p, args[i] !== undefined ? args[i] : (fn.defaults[i - (fn.params.length - fn.defaults.length)] ?? null));
    });
    try {
      const blocks = parseBlocks(fn.body);
      for (const block of blocks) {
        const r = this.execBlockSync(block, localEnv);
        if (r instanceof InputRequest) {
          // Can't await in sync context — return placeholder
          return null;
        }
      }
    } catch (e: any) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return null;
  }

  // ── Method calls ───────────────────────────────────────────────────────

  private callMethod(obj: PyValue, method: string, args: PyValue[], env: PyEnv): PyValue {
    if (Array.isArray(obj)) {
      switch (method) {
        case "append": (obj as PyValue[]).push(args[0]); return null;
        case "extend": if (Array.isArray(args[0])) (obj as PyValue[]).push(...args[0] as PyValue[]); return null;
        case "pop": return args[0] !== undefined ? (obj as PyValue[]).splice(args[0] as number, 1)[0] : (obj as PyValue[]).pop() ?? null;
        case "insert": (obj as PyValue[]).splice(args[0] as number, 0, args[1]); return null;
        case "remove": { const i = (obj as PyValue[]).indexOf(args[0]); if (i >= 0) (obj as PyValue[]).splice(i, 1); return null; }
        case "index": return (obj as PyValue[]).indexOf(args[0]);
        case "count": return (obj as PyValue[]).filter(v => this.pyEqual(v, args[0])).length;
        case "sort": {
          const rev = (args[0] as any)?.reverse ?? false;
          (obj as PyValue[]).sort((a, b) => {
            const r = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
            return rev ? -r : r;
          });
          return null;
        }
        case "reverse": (obj as PyValue[]).reverse(); return null;
        case "copy": return [...(obj as PyValue[])];
        case "clear": (obj as PyValue[]).splice(0); return null;
        case "join": {
          // This is called as obj.join(sep) but in Python sep.join(iterable)
          // Both can occur
          const sep = this.pyStr(args[0]);
          return (obj as string[]).map(v => this.pyStr(v)).join(sep);
        }
      }
    }

    if (typeof obj === "string") {
      const s = obj as string;
      switch (method) {
        case "upper": return s.toUpperCase();
        case "lower": return s.toLowerCase();
        case "strip": return args[0] !== undefined ? s.replace(new RegExp(`^[${this.escapeRegex(this.pyStr(args[0]))}]+|[${this.escapeRegex(this.pyStr(args[0]))}]+$`, "g"), "") : s.trim();
        case "lstrip": return s.trimStart();
        case "rstrip": return s.trimEnd();
        case "split": return args[0] !== undefined ? s.split(this.pyStr(args[0])) as PyValue[] : s.split(/\s+/).filter(Boolean) as PyValue[];
        case "join": return Array.isArray(args[0]) ? (args[0] as string[]).map(v => this.pyStr(v)).join(s) : this.pyStr(args[0]);
        case "replace": return s.replace(new RegExp(this.escapeRegex(this.pyStr(args[0])), "g"), this.pyStr(args[1]));
        case "startswith": return s.startsWith(this.pyStr(args[0]));
        case "endswith": return s.endsWith(this.pyStr(args[0]));
        case "find": return s.indexOf(this.pyStr(args[0]));
        case "rfind": return s.lastIndexOf(this.pyStr(args[0]));
        case "index": { const i = s.indexOf(this.pyStr(args[0])); if (i < 0) throw new PythonError("ValueError", "substring not found"); return i; }
        case "count": return s.split(this.pyStr(args[0])).length - 1;
        case "format": {
          let r = s;
          let i = 0;
          r = r.replace(/\{(\d+)?\}/g, (_, n) => this.pyStr(args[n !== undefined ? parseInt(n) : i++]));
          return r;
        }
        case "isdigit": return /^\d+$/.test(s);
        case "isalpha": return /^[a-zA-Z]+$/.test(s);
        case "isalnum": return /^[a-zA-Z0-9]+$/.test(s);
        case "isspace": return /^\s+$/.test(s);
        case "isupper": return s === s.toUpperCase() && /[a-zA-Z]/.test(s);
        case "islower": return s === s.toLowerCase() && /[a-zA-Z]/.test(s);
        case "title": return s.replace(/\b\w/g, c => c.toUpperCase());
        case "capitalize": return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
        case "center": { const w = args[0] as number; const fill = args[1] !== undefined ? this.pyStr(args[1]) : " "; const pad = w - s.length; const lpad = Math.floor(pad / 2); const rpad = Math.ceil(pad / 2); return fill.repeat(Math.max(0, lpad)) + s + fill.repeat(Math.max(0, rpad)); }
        case "ljust": { const w = args[0] as number; const fill = args[1] !== undefined ? this.pyStr(args[1]) : " "; return s.padEnd(w, fill); }
        case "rjust": { const w = args[0] as number; const fill = args[1] !== undefined ? this.pyStr(args[1]) : " "; return s.padStart(w, fill); }
        case "zfill": return s.padStart(args[0] as number, "0");
        case "encode": return s;
        case "expandtabs": return s.replace(/\t/g, " ".repeat((args[0] ?? 8) as number));
      }
    }

    if (obj && typeof obj === "object" && (obj as PyDict).__type === "dict") {
      const d = (obj as PyDict).entries;
      switch (method) {
        case "keys": return [...d.keys()] as PyValue[];
        case "values": return [...d.values()];
        case "items": return [...d.entries()].map(([k, v]) => [k, v]) as PyValue[];
        case "get": return d.get(this.pyStr(args[0])) ?? (args[1] ?? null);
        case "set": d.set(this.pyStr(args[0]), args[1]); return null;
        case "pop": { const v = d.get(this.pyStr(args[0])); d.delete(this.pyStr(args[0])); return v ?? (args[1] ?? null); }
        case "update": {
          if (args[0] && (args[0] as PyDict).__type === "dict")
            (args[0] as PyDict).entries.forEach((v, k) => d.set(k, v));
          return null;
        }
        case "clear": d.clear(); return null;
        case "copy": return { __type: "dict" as const, entries: new Map(d) };
        case "setdefault": { if (!d.has(this.pyStr(args[0]))) d.set(this.pyStr(args[0]), args[1] ?? null); return d.get(this.pyStr(args[0]))!; }
      }
    }

    throw new PythonError("AttributeError", `'${this.pyType(obj)}' object has no attribute '${method}'`);
  }

  private getAttr(obj: PyValue, attr: string): PyValue {
    if (Array.isArray(obj)) {
      if (attr === "__len__") return obj.length;
      return null;
    }
    if (typeof obj === "string") {
      if (attr === "__len__") return (obj as string).length;
      return null;
    }
    if (obj && (obj as PyDict).__type === "dict") {
      return null;
    }
    return null;
  }

  private assignTarget(target: string, value: PyValue, env: PyEnv): void {
    target = target.trim();
    if (target.includes(",")) {
      const vars = target.split(",").map(v => v.trim()).filter(Boolean);
      const vals = Array.isArray(value) ? value : [value];
      vars.forEach((v, i) => env.set(v, vals[i] ?? null));
    } else {
      env.set(target, value);
    }
  }

  private applyAugAssign(lhs: string, op: string, rhs: PyValue, env: PyEnv): void {
    const cur = env.get(lhs);
    let val: PyValue;
    switch (op) {
      case "+=": val = (typeof cur === "string" && typeof rhs === "string") ? cur + rhs : Array.isArray(cur) && Array.isArray(rhs) ? [...cur, ...rhs] : (cur as number) + (rhs as number); break;
      case "-=": val = (cur as number) - (rhs as number); break;
      case "*=": val = (cur as number) * (rhs as number); break;
      case "/=": val = (cur as number) / (rhs as number); break;
      case "//=": val = Math.floor((cur as number) / (rhs as number)); break;
      case "**=": val = Math.pow(cur as number, rhs as number); break;
      case "%=": val = (cur as number) % (rhs as number); break;
      default: val = cur!;
    }
    env.set(lhs, val);
  }

  private execPrint(stmt: string, env: PyEnv): any {
    const inner = stmt.slice(6, stmt.length - 1).trim();
    if (!inner) { const r: any = [""]; r.__flat = true; return r; }
    const rawArgs = this.splitArgs(inner);
    const positional: PyValue[] = [];
    let sep = " ", end = "\n";
    for (const a of rawArgs) {
      if (/^sep\s*=/.test(a)) { sep = this.pyStr(this.evalExpr(a.slice(a.indexOf("=") + 1).trim(), env)); continue; }
      if (/^end\s*=/.test(a)) { end = this.pyStr(this.evalExpr(a.slice(a.indexOf("=") + 1).trim(), env)); continue; }
      positional.push(this.evalExpr(a.trim(), env));
    }
    const r: any = ["\x1b[0m" + positional.map(v => this.pyStr(v)).join(sep)];
    r.__flat = true;
    return r;
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  toIterable(val: PyValue): PyValue[] {
    if (Array.isArray(val)) return val;
    if (typeof val === "string") return [...(val as string)] as PyValue[];
    if (val && (val as PyDict).__type === "dict") return [...(val as PyDict).entries.keys()];
    throw new PythonError("TypeError", `'${this.pyType(val)}' is not iterable`);
  }

  isTruthy(val: PyValue): boolean {
    if (val === null || val === false || val === 0 || val === "") return false;
    if (Array.isArray(val) && val.length === 0) return false;
    if (val && typeof val === "object" && (val as PyDict).__type === "dict" && (val as PyDict).entries.size === 0) return false;
    return true;
  }

  pyStr(val: PyValue): string {
    if (val === null) return "None";
    if (val === true) return "True";
    if (val === false) return "False";
    if (typeof val === "number") return String(val);
    if (typeof val === "string") return val;
    if (Array.isArray(val)) return `[${val.map(v => this.repr(v)).join(", ")}]`;
    if (val && (val as PyDict).__type === "dict") {
      const e = [...(val as PyDict).entries.entries()].map(([k, v]) => `${this.repr(k as PyValue)}: ${this.repr(v)}`);
      return `{${e.join(", ")}}`;
    }
    if (val && (val as PyFunction).__type === "fn") return `<function ${(val as PyFunction).name}>`;
    return String(val);
  }

  repr(val: PyValue): string {
    if (val === null) return "\x1b[35mNone\x1b[0m";
    if (val === true) return "\x1b[35mTrue\x1b[0m";
    if (val === false) return "\x1b[35mFalse\x1b[0m";
    if (typeof val === "number") return `\x1b[33m${val}\x1b[0m`;
    if (typeof val === "string") return `\x1b[32m'${val}'\x1b[0m`;
    if (Array.isArray(val)) return `\x1b[36m[${val.map(v => this.repr(v)).join(", ")}]\x1b[0m`;
    if (val && (val as PyDict).__type === "dict") {
      const e = [...(val as PyDict).entries.entries()].map(([k, v]) => `\x1b[32m'${k}'\x1b[0m: ${this.repr(v)}`);
      return `\x1b[36m{${e.join(", ")}}\x1b[0m`;
    }
    if (val && (val as PyFunction).__type === "fn") return `\x1b[90m<function ${(val as PyFunction).name}>\x1b[0m`;
    return String(val);
  }

  private pyLen(val: PyValue): number {
    if (typeof val === "string") return (val as string).length;
    if (Array.isArray(val)) return val.length;
    if (val && (val as PyDict).__type === "dict") return (val as PyDict).entries.size;
    throw new PythonError("TypeError", `object of type '${this.pyType(val)}' has no len()`);
  }

  private pyType(val: PyValue): string {
    if (val === null) return "NoneType";
    if (typeof val === "boolean") return "bool";
    if (typeof val === "number") return Number.isInteger(val as number) ? "int" : "float";
    if (typeof val === "string") return "str";
    if (Array.isArray(val)) return "list";
    if (val && (val as PyDict).__type === "dict") return "dict";
    if (val && (val as PyFunction).__type === "fn") return "function";
    return "object";
  }

  private pyEqual(a: PyValue, b: PyValue): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => this.pyEqual(v, b[i]));
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private pyIn(item: PyValue, container: PyValue): boolean {
    if (Array.isArray(container)) return container.some(v => this.pyEqual(v, item));
    if (typeof container === "string") return (container as string).includes(this.pyStr(item));
    if (container && (container as PyDict).__type === "dict")
      return (container as PyDict).entries.has(this.pyStr(item));
    return false;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  splitArgs(raw: string): string[] {
    const args: string[] = [];
    let depth = 0; let inStr = false; let strCh = ""; let cur = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        cur += ch;
        if (ch === strCh && raw[i - 1] !== "\\") inStr = false;
      } else if (ch === '"' || ch === "'") {
        inStr = true; strCh = ch; cur += ch;
      } else if (ch === "(" || ch === "[" || ch === "{") { depth++; cur += ch; }
      else if (ch === ")" || ch === "]" || ch === "}") { depth--; cur += ch; }
      else if (ch === "," && depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        cur = "";
      } else { cur += ch; }
    }
    if (cur.trim()) args.push(cur.trim());
    return args;
  }

  private formatResult(r: any): string[] {
    if (r === null || r === undefined) return [];
    if ((r as any).__flat) return r as string[];
    return [this.repr(r as PyValue)];
  }

  private helpText(): any {
    const lines = [
      "\x1b[1;36mPython 3.11 — Simulated Interpreter\x1b[0m",
      "\x1b[90m────────────────────────────────────\x1b[0m",
      "  Variables, arithmetic, strings, lists, dicts, tuples",
      "  for / while loops  •  if / elif / else",
      "  def functions  •  recursion  •  closures",
      "  input()  •  print(sep=, end=)  •  f-strings",
      "  range()  •  enumerate()  •  zip()  •  map()  •  filter()",
      "  int()  •  float()  •  str()  •  len()  •  type()  •  abs()",
      "  min()  •  max()  •  sum()  •  sorted()  •  reversed()",
      "  list()  •  dict()  •  any()  •  all()",
      "  .append() .pop() .keys() .values() .items() .split() .join()",
      "  list comprehensions  •  tuple unpacking  •  slicing",
      "\x1b[90mCtrl+C to interrupt  •  Ctrl+L to clear\x1b[0m",
    ];
    const r: any = lines;
    r.__flat = true;
    return r;
  }
}
