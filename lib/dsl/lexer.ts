/**
 * Codoptic DSL lexer.
 *
 * Grammar (informal):
 *   - Comments: `// ...` to end of line.
 *   - Declarations: `Name [k: v, k: v] { ... }` or `Name [props]`.
 *   - Edges:       `A > B`, `A < B`, `A <> B`, `A -- B`, `A => B`, with optional `: label`.
 *   - Edge operators MUST be surrounded by whitespace so identifiers can
 *     contain `|`, `&`, `(`, `)`, etc. (e.g. `Tables from DOCX | PDF`).
 *
 * The lexer is line-oriented for identifier scanning but produces a single
 * stream of tokens with precise `line` / `col` so Monaco diagnostics work.
 */

export type TokenKind =
  | 'IDENT'
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'COMMA'
  | 'COLON'
  | 'ARROW_FWD' // >
  | 'ARROW_BWD' // <
  | 'ARROW_BI' // <>
  | 'EDGE_DASH' // --
  | 'EDGE_FAT' // =>
  | 'COMMENT'
  | 'NEWLINE'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  value: string;
  line: number; // 1-based
  col: number; // 1-based
  length: number;
}

const EDGE_OPS: Array<{ src: string; kind: TokenKind }> = [
  { src: '<>', kind: 'ARROW_BI' },
  { src: '=>', kind: 'EDGE_FAT' },
  { src: '--', kind: 'EDGE_DASH' },
  { src: '>', kind: 'ARROW_FWD' },
  { src: '<', kind: 'ARROW_BWD' },
];

/** Characters that always terminate an identifier scan. */
const TERMINATORS = new Set(['[', ']', '{', '}', ',', ':', '\n', '\r']);

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? '';
    const lineNo = lineIdx + 1;
    let i = 0;

    while (i < line.length) {
      const ch = line[i]!;

      // Whitespace
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }

      // Comment to end of line
      if (ch === '/' && line[i + 1] === '/') {
        tokens.push({
          kind: 'COMMENT',
          value: line.slice(i),
          line: lineNo,
          col: i + 1,
          length: line.length - i,
        });
        i = line.length;
        break;
      }

      // Single-char structural tokens
      if (ch === '[') {
        tokens.push({ kind: 'LBRACKET', value: '[', line: lineNo, col: i + 1, length: 1 });
        i++;
        continue;
      }
      if (ch === ']') {
        tokens.push({ kind: 'RBRACKET', value: ']', line: lineNo, col: i + 1, length: 1 });
        i++;
        continue;
      }
      if (ch === '{') {
        tokens.push({ kind: 'LBRACE', value: '{', line: lineNo, col: i + 1, length: 1 });
        i++;
        continue;
      }
      if (ch === '}') {
        tokens.push({ kind: 'RBRACE', value: '}', line: lineNo, col: i + 1, length: 1 });
        i++;
        continue;
      }
      if (ch === ',') {
        tokens.push({ kind: 'COMMA', value: ',', line: lineNo, col: i + 1, length: 1 });
        i++;
        continue;
      }
      if (ch === ':') {
        tokens.push({ kind: 'COLON', value: ':', line: lineNo, col: i + 1, length: 1 });
        i++;
        continue;
      }

      // Edge operators — only valid when surrounded by whitespace OR at
      // line start/end. We check that the *previous* char is whitespace OR
      // we're at column 0, AND that the *next* char (after the operator)
      // is whitespace, ] / } / , / : / EOL. Otherwise treat as part of an
      // identifier.
      const prevCh = i === 0 ? ' ' : line[i - 1];
      const opMatch = EDGE_OPS.find((op) => line.startsWith(op.src, i));
      if (opMatch && prevCh === ' ') {
        const after = line[i + opMatch.src.length];
        if (after === undefined || after === ' ' || after === '\t') {
          tokens.push({
            kind: opMatch.kind,
            value: opMatch.src,
            line: lineNo,
            col: i + 1,
            length: opMatch.src.length,
          });
          i += opMatch.src.length;
          continue;
        }
      }

      // Identifier: scan greedy until terminator, structural char, or edge op
      // (which must be preceded by whitespace). We trim trailing whitespace
      // from the captured name.
      const startCol = i;
      let end = i;
      while (end < line.length) {
        const c = line[end]!;
        if (TERMINATORS.has(c)) break;

        // Check for edge operator at this position — only triggers if
        // preceded by whitespace (we've already advanced past any whitespace).
        const prev = end === 0 ? ' ' : line[end - 1];
        if (prev === ' ' || prev === '\t') {
          const op = EDGE_OPS.find((o) => line.startsWith(o.src, end));
          if (op) {
            const nextAfter = line[end + op.src.length];
            if (nextAfter === undefined || nextAfter === ' ' || nextAfter === '\t') {
              break;
            }
          }
        }

        // Comment start terminates identifier.
        if (c === '/' && line[end + 1] === '/') break;

        end++;
      }

      const raw = line.slice(startCol, end);
      const trimmed = raw.replace(/\s+$/, '');
      if (trimmed.length > 0) {
        tokens.push({
          kind: 'IDENT',
          value: trimmed,
          line: lineNo,
          col: startCol + 1,
          length: trimmed.length,
        });
      }
      i = end;
    }

    tokens.push({
      kind: 'NEWLINE',
      value: '\n',
      line: lineNo,
      col: line.length + 1,
      length: 1,
    });
  }

  tokens.push({
    kind: 'EOF',
    value: '',
    line: lines.length,
    col: 1,
    length: 0,
  });

  return tokens;
}
