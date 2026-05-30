# Codoptic Code Space Agent Rules

These rules are loaded as project guidance for Code Space planning and code-generation tasks.

## No dummy completions

A Code-mode run is not complete just because the first evidence bundle is incomplete. Do not end with messages such as:

- a likely target file was not included in the evidence bundle
- one more file is needed before patching
- no files were changed because context is missing

Instead, request exact relative paths through `needsMoreFiles`, use repository file names from the index, and continue until a concrete reviewable patch is returned or the bounded retry budget is genuinely exhausted.

## Repository exploration

Before patching, inspect the file named in the error, traceback, stack trace, import chain, route, test failure, or user request. If a traceback names `backend/api/chatbot.py`, that file is mandatory evidence. Neighboring files such as routes, app entrypoints, tests, configs, and imports should be recalled when they influence the fix.

## Patch retry and repair

When a generated patch fails syntax pre-validation, treat the diagnostic as repair feedback, not as a final answer. Replan using the target file content and the exact diagnostic. Generate a corrected patch for the same file unless the diagnostic proves the requested change is unsafe.

For Python indentation diagnostics:

- keep top-level imports, constants, functions, and classes at column 0;
- put methods inside a class block;
- do not add indented `def` blocks at module scope;
- run or plan `python3 -m compileall .` and `python3 -m pytest` for Python work.

## Validation

Code mode must not claim verification without running the detected validation commands or honestly surfacing why they could not run. Plan mode must list the validation commands that Code mode will execute.

## Concise final responses

The user-visible answer (assistant text and the `attempt_completion` summary) must stay short and decisive. Do not produce sectioned technical reports.

- Hard cap: at most 4 short sentences, or about 240 characters.
- One paragraph. No multi-section markdown headings (`Summary of intent and actions`, `Evidence inspected`, `DoD status vs checklist`, `Validation plan`, `Next steps / options for you`, etc.).
- No "Motivation vs Logic" / "Root Cause vs Logic" prose in the chat reply — those technical comments belong inside the patched source code, not in the user-visible summary.
- No menu of "Option A / Option B / retry edit / repair & edit / apply manually". If a clarifying choice is genuinely required, call `ask_clarifying_questions` instead of writing it as prose.
- Lead with what changed (or that nothing matched), then validation status, then the single exact blocker if any.
- Never explain how the editor tool works, why pre-validation flagged something, or what you "would have done if allowed". Either retry the edit or report the exact blocker.

## Comprehensive search-and-replace

When the user asks to find or replace a textual pattern (URLs, hostnames, env keys, identifiers, deprecated symbols), use `search_text` with regex and try multiple variants before reporting zero matches.

- `search_text` is case-insensitive by default and accepts a regex. Prefer regex over literal queries for any URL or identifier match.
- Always probe at least three patterns: the full literal, a host/path-only fragment (e.g. `binkhoale1812[-_]?medical[-_]?chatbot\.hf\.space`), and the most distinctive identifier substring (e.g. `binkhoale1812`).
- For URLs, include both `http` and `https` and ignore trailing path segments by anchoring on the host: `https?://[^/\s"']*<host-fragment>`.
- For deprecated identifiers, also search the new identifier — if both already coexist, the replacement may already be partially done.
- If every variant returns zero matches, report exactly that ("no occurrences of <pattern> found in the repo") and stop. Do not invent adjacent normalization, casing fixes, or refactors that the user did not ask for.
- When matches are found, replace every occurrence in a single `edit_file` batch (one edit per file), then re-run the same regex search to confirm the count is now zero.
