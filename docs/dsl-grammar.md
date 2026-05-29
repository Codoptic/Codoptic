# Codoptic DSL Grammar

A compact, line-oriented language for describing diagrams. Inspired by
Eraser-style diagram-as-code but implemented entirely in-house.

## Grammar (informal BNF)

```
program       := (statement | comment | blank-line)*
statement     := group-decl | node-decl | edge-decl
comment       := "//" any-text-to-end-of-line
blank-line    := (whitespace)? newline

group-decl    := IDENT (prop-list)? "{" (statement | comment | blank-line)* "}"
node-decl     := IDENT (prop-list)?
edge-decl     := IDENT edge-op IDENT (":" LABEL)? (prop-list)?
edge-op       := ">" | "<" | "<>" | "--" | "=>"

prop-list     := "[" prop ("," prop)* "]"
prop          := IDENT ":" value | IDENT     // bare flag = true
value         := IDENT | number | quoted-string | "true" | "false"

IDENT         := one or more chars that are NOT: [ ] { } > < -- => : , newline
                 — trimmed of trailing whitespace. May contain spaces, |,
                 &, parens, etc.
```

## Identifier rules

Names are greedy: they consume characters until a structural delimiter or
an edge operator surrounded by whitespace. This means **edge operators must
have whitespace on both sides**:

| ✅ Valid                              | ❌ Invalid                |
|--------------------------------------|--------------------------|
| `User > Database`                    | `User>Database`          |
| `Tables from DOCX \| PDF > Normalise` | (operator inside a name) |

## Property keys

Known keys (unknown keys parse but emit `info`-level diagnostics):

| Scope  | Keys                                                                |
|--------|---------------------------------------------------------------------|
| node   | `color`, `icon`, `label`, `width`, `height`, `shape`, `note`, `id`  |
| group  | `color`, `icon`, `label`, `direction`, `collapsed`, `padding`, `note`, `id` |
| edge   | `color`, `style`, `label`                                           |

## Colors

`orange`, `green`, `yellow`, `amber`, `coral`, `teal`, `slate`, `indigo`,
`blue`, `purple`, `lime`, `sky`, `red`, `pink`, `gray`.

A child without an explicit color inherits from the nearest colored ancestor.

## Icons

Inline-SVG (Lucide-style) icons — see [components/inspector/shared.ts](../components/inspector/shared.ts) for the
full list. Unknown icon names fall back to a circle and emit a warning.

## Edge kinds

| DSL    | Meaning                  | Renders as            |
|--------|--------------------------|-----------------------|
| `>`    | forward                  | solid, end arrow      |
| `<`    | backward                 | solid, start arrow    |
| `<>`   | bidirectional            | solid, arrows both ends |
| `--`   | dashed / loosely related | dashed line           |
| `=>`   | thick / primary path     | thicker stroke + arrow |

## Examples

### Tiny flow

```
Frontend [color: sky, icon: monitor] {
  UI [icon: layout]
  Router [icon: git-branch]
}

API [color: indigo, icon: server] {
  Auth [icon: shield]
  Users [icon: list]
}

UI > Router
Router > Auth
Router > Users
```

### Edge with label

```
Schedule Merge > XLSX Patch: write
```

### Bidirectional + dashed

```
Frontend <> Job Storage
Outputs -- Job Storage
```

## Diagnostics

The parser produces structured diagnostics with line/column information.
They flow through to Monaco as squiggly underlines and to the Diagnostics
tab. Severity:

- **error** — would block compilation (rare; the compiler is forgiving)
- **warning** — known property/color/edge has unexpected value
- **info** — unknown property name (still preserved)
