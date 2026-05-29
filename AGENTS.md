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
