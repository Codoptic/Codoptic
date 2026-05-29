/**
 * Recursive-descent parser for the Codoptic DSL.
 *
 * Top-level statements:
 *   - Comment (passes through to AST so the formatter can preserve them)
 *   - GroupDecl: Name [props]? { statements } | Name { statements }
 *   - NodeDecl:  Name [props]?
 *   - EdgeDecl:  Source <op> Target (: label)? ([props])?
 *
 * Edge ops: >  <  <>  --  =>
 *
 * Disambiguation between NodeDecl and EdgeDecl:
 *   After parsing the first Name, if the next non-whitespace token is an
 *   edge operator (>, <, <>, --, =>), it's an edge. If it's `[` or `{` or
 *   newline, it's a node/group.
 */

import { lex, type Token } from './lexer';
import type { Diagnostic } from '../ir/types';
import {
  type Program,
  type Statement,
  type NodeDecl,
  type GroupDecl,
  type EdgeDecl,
  type PropList,
  type PropValue,
  type SrcSpan,
  spanOf,
} from './ast';

class ParseError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

class Parser {
  private idx = 0;
  public diagnostics: Diagnostic[] = [];

  constructor(private tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[this.idx + offset] ?? this.tokens[this.tokens.length - 1]!;
  }

  private consume(): Token {
    const t = this.tokens[this.idx]!;
    this.idx++;
    return t;
  }

  private match(...kinds: Token['kind'][]): boolean {
    return kinds.includes(this.peek().kind);
  }

  private skipNewlines(): void {
    while (this.peek().kind === 'NEWLINE') this.idx++;
  }

  /** Find the next non-NEWLINE token after the current head without advancing. */
  private peekSignificant(skip = 0): Token {
    let n = this.idx + skip;
    while (this.tokens[n] && this.tokens[n]!.kind === 'NEWLINE') n++;
    return this.tokens[n] ?? this.tokens[this.tokens.length - 1]!;
  }

  parse(): Program {
    const statements: Statement[] = [];

    while (this.peek().kind !== 'EOF') {
      const t = this.peek();
      if (t.kind === 'NEWLINE') {
        this.idx++;
        continue;
      }
      if (t.kind === 'COMMENT') {
        statements.push({
          type: 'comment',
          text: t.value,
          span: spanOf(t),
        });
        this.idx++;
        continue;
      }
      if (t.kind === 'RBRACE') {
        // Stray closing brace at top level
        this.diagnostics.push({
          message: 'Unexpected }',
          line: t.line,
          column: t.col,
          length: t.length,
          severity: 'error',
        });
        this.idx++;
        continue;
      }

      try {
        const stmt = this.parseStatement();
        if (stmt) statements.push(stmt);
      } catch (err) {
        if (err instanceof ParseError) {
          this.diagnostics.push(err.diagnostic);
          this.recoverToNextStatement();
        } else {
          throw err;
        }
      }
    }

    return { statements };
  }

  private recoverToNextStatement(): void {
    while (this.peek().kind !== 'NEWLINE' && this.peek().kind !== 'EOF') {
      this.idx++;
    }
  }

  private parseStatement(): Statement | null {
    const first = this.peek();
    if (first.kind !== 'IDENT') {
      throw new ParseError({
        message: `Expected identifier, got "${first.value || first.kind}"`,
        line: first.line,
        column: first.col,
        length: first.length,
        severity: 'error',
      });
    }

    // Look ahead past the identifier to determine declaration vs edge.
    let j = this.idx + 1;
    while (this.tokens[j] && this.tokens[j]!.kind === 'NEWLINE') j++;
    const next = this.tokens[j];

    if (next && (next.kind === 'ARROW_FWD' || next.kind === 'ARROW_BWD' ||
                 next.kind === 'ARROW_BI' || next.kind === 'EDGE_DASH' ||
                 next.kind === 'EDGE_FAT')) {
      return this.parseEdge();
    }

    // Otherwise it's a node or group declaration.
    return this.parseDeclaration();
  }

  private parseDeclaration(): NodeDecl | GroupDecl {
    const nameTok = this.consume();
    const name = nameTok.value;
    const nameSpan = spanOf(nameTok);

    let props: PropList | null = null;
    if (this.peek().kind === 'LBRACKET') {
      props = this.parsePropList();
    }

    // Optional: { ... } body makes it a group
    if (this.peek().kind === 'LBRACE') {
      const open = this.consume();
      const body: Statement[] = [];
      while (this.peek().kind !== 'RBRACE' && this.peek().kind !== 'EOF') {
        const t = this.peek();
        if (t.kind === 'NEWLINE') {
          this.idx++;
          continue;
        }
        if (t.kind === 'COMMENT') {
          body.push({ type: 'comment', text: t.value, span: spanOf(t) });
          this.idx++;
          continue;
        }
        try {
          const stmt = this.parseStatement();
          if (stmt) body.push(stmt);
        } catch (err) {
          if (err instanceof ParseError) {
            this.diagnostics.push(err.diagnostic);
            this.recoverToNextStatement();
          } else throw err;
        }
      }
      if (this.peek().kind === 'RBRACE') {
        this.consume();
      } else {
        this.diagnostics.push({
          message: 'Unclosed group (missing })',
          line: open.line,
          column: open.col,
          length: open.length,
          severity: 'error',
        });
      }
      return { type: 'group', name, nameSpan, props, body };
    }

    return { type: 'node', name, nameSpan, props };
  }

  private parseEdge(): EdgeDecl {
    const src = this.consume(); // IDENT
    const sourceSpan = spanOf(src);

    const opTok = this.consume();
    let op: EdgeDecl['op'];
    switch (opTok.kind) {
      case 'ARROW_FWD':
        op = '>';
        break;
      case 'ARROW_BWD':
        op = '<';
        break;
      case 'ARROW_BI':
        op = '<>';
        break;
      case 'EDGE_DASH':
        op = '--';
        break;
      case 'EDGE_FAT':
        op = '=>';
        break;
      default:
        throw new ParseError({
          message: `Expected edge operator, got "${opTok.value}"`,
          line: opTok.line,
          column: opTok.col,
          length: opTok.length,
          severity: 'error',
        });
    }

    if (this.peek().kind !== 'IDENT') {
      const t = this.peek();
      throw new ParseError({
        message: 'Expected target identifier after edge operator',
        line: t.line,
        column: t.col,
        length: t.length,
        severity: 'error',
      });
    }
    const tgt = this.consume();

    let label: string | null = null;
    if (this.peek().kind === 'COLON') {
      this.consume();
      // Label is the rest of the line until newline / [ / comment
      if (this.peek().kind === 'IDENT') {
        const labelTok = this.consume();
        label = labelTok.value;
      }
    }

    let props: PropList | null = null;
    if (this.peek().kind === 'LBRACKET') {
      props = this.parsePropList();
    }

    return {
      type: 'edge',
      source: src.value,
      target: tgt.value,
      sourceSpan,
      targetSpan: spanOf(tgt),
      op,
      opSpan: spanOf(opTok),
      label,
      props,
    };
  }

  private parsePropList(): PropList {
    const open = this.consume(); // [
    const entries: PropList['entries'] = [];

    while (this.peek().kind !== 'RBRACKET' && this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'NEWLINE' || this.peek().kind === 'COMMA') {
        this.idx++;
        continue;
      }
      if (this.peek().kind === 'COMMENT') {
        this.idx++;
        continue;
      }

      if (this.peek().kind !== 'IDENT') {
        const t = this.peek();
        this.diagnostics.push({
          message: `Expected property name, got "${t.value || t.kind}"`,
          line: t.line,
          column: t.col,
          length: t.length,
          severity: 'error',
        });
        this.idx++;
        continue;
      }
      const keyTok = this.consume();
      const key = keyTok.value.trim();

      if (this.peek().kind !== 'COLON') {
        // Treat as boolean flag
        entries.push({
          key,
          value: true,
          span: spanOf(keyTok),
        });
        continue;
      }
      this.consume(); // :

      if (this.peek().kind !== 'IDENT') {
        const t = this.peek();
        this.diagnostics.push({
          message: `Expected value for "${key}"`,
          line: t.line,
          column: t.col,
          length: t.length,
          severity: 'error',
        });
        continue;
      }
      const valTok = this.consume();
      entries.push({
        key,
        value: parseValue(valTok.value),
        span: { line: keyTok.line, col: keyTok.col, length: valTok.col + valTok.length - keyTok.col },
      });
    }

    let closeSpan: SrcSpan;
    if (this.peek().kind === 'RBRACKET') {
      const c = this.consume();
      closeSpan = spanOf(c);
    } else {
      this.diagnostics.push({
        message: 'Unclosed property list (missing ])',
        line: open.line,
        column: open.col,
        length: open.length,
        severity: 'error',
      });
      closeSpan = spanOf(open);
    }

    return {
      span: { line: open.line, col: open.col, length: closeSpan.col + closeSpan.length - open.col },
      entries,
    };
  }
}

function parseValue(raw: string): PropValue {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(s)) return n;
  // Strip surrounding quotes if present
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function parse(source: string): { program: Program; diagnostics: Diagnostic[] } {
  const tokens = lex(source);
  const parser = new Parser(tokens);
  const program = parser.parse();
  return { program, diagnostics: parser.diagnostics };
}
