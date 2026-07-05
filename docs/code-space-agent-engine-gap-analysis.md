# Code Space Coding Agent Engine Gap Analysis

**Date:** 2026-07-05  
**Scope:** Code Space page and runtime only — planning-to-implementation workflow, coding-agent harness, validation, review gates, and roadmap for enterprise-grade agentic coding.

This document is an implementation-readiness audit. It intentionally does **not** change runtime behavior. Its purpose is to lock down the diagnosis and target architecture before we make large engine changes.

---

## 1. Executive Summary

Code Space already has many strong primitives: streamed run events, project context collection, plan artifacts, exact-match patching, checkpoints, validation commands, subagents, browser tools, memories, a coworking ledger, and supervisor reconciliation.

The current weakness is not that Code Space cannot plan. The weakness is that the system does not yet force the implementation run to behave like a real senior coding agent after the plan is produced. The runtime is plan-aware in wording, but not contract-driven enough in execution.

Observed failure pattern:

1. Plan mode produces a comprehensive markdown plan.
2. Code mode receives a broad implementation prompt.
3. The agent makes a small number of edits, often in the easiest visible files.
4. Validation may run, but it is shallow, generic, or poorly targeted.
5. The supervisor can still reach a weak `needs_review` or near-success state without proving the full plan was implemented.
6. The UI shows activity, but the user cannot clearly see which plan requirements were implemented, skipped, blocked, or verified.

Root cause:

> Codoptic has an eventful agent loop, but not yet a sufficiently strict **plan-to-code contract + package execution + evidence mapping + validation repair loop**.

---

## 2. External Research Basis

The following current coding-agent systems and papers were reviewed to benchmark Code Space:

### Claude Code

Claude Code emphasizes that a useful coding agent must inspect a codebase, edit files, run commands, integrate with IDE/CLI/web surfaces, use repository instructions, enforce permissions, support subagents, and preserve context through specialized workflows.

Relevant public references:

- Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
- Claude Code common workflows: https://docs.anthropic.com/en/docs/claude-code/common-workflows
- Claude Code best practices: https://www.anthropic.com/engineering/claude-code-best-practices
- Claude Code subagents: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Claude Code permissions: https://docs.anthropic.com/en/docs/claude-code/iam#permission-management

Important design takeaways:

- Repository instruction files are first-class runtime input, not optional prompt decoration.
- Strong workflows separate exploration, planning, implementation, validation, and review.
- Verification must be explicit: tests, builds, lint, screenshots, command logs, or other pass/fail evidence.
- Subagents should preserve the main context by isolating noisy exploration/test/log work.
- Permission and sandbox models must classify dangerous command classes, not only a few literal shell patterns.

### OpenAI Codex

Codex documentation highlights persistent `AGENTS.md` guidance, sandboxing, subagents, worktrees, rules, hooks, permissions, MCP, local environments, and iterative repair/eval loops.

Relevant public references:

- Codex overview: https://developers.openai.com/codex/overview
- Codex best practices: https://developers.openai.com/codex/learn/best-practices
- Codex AGENTS.md guide: https://developers.openai.com/codex/guides/agents-md
- Codex subagents concept: https://developers.openai.com/codex/concepts/subagents

Important design takeaways:

- `AGENTS.md` discovery creates a predictable instruction chain for every run.
- Coding agents need build/test/lint commands, conventions, constraints, and done criteria in durable project rules.
- Reliability improves when the agent creates or updates tests, runs relevant checks, confirms behavior, and reviews its own diff before completion.
- Worktrees and isolated execution reduce conflicts when parallel or long-running agent work exists.
- An agent improvement loop requires traces, evals, replayable tasks, and regression reports.

### OpenHands and SWE-agent

OpenHands and SWE-agent show that agent performance is heavily shaped by the agent-computer interface: how the agent sees files, searches, edits, runs commands, receives diagnostics, and retries.

Relevant public references:

- OpenHands repository: https://github.com/All-Hands-AI/OpenHands
- OpenHands paper: https://arxiv.org/abs/2407.16741
- SWE-agent repository: https://github.com/SWE-agent/SWE-agent
- SWE-agent paper: https://arxiv.org/abs/2405.15793

Important design takeaways:

- The harness is not just a tool list; it is the agent's operating system.
- Better edit/navigation/test tools produce materially better coding behavior.
- Sandboxed command execution and auditable trajectories are core requirements.
- Benchmarks and replayable eval tasks are required to detect regressions.

---

## 3. Current Codoptic Code Space Strengths

Codoptic is not starting from zero. The repo already contains many useful building blocks.

### 3.1 Runtime structure

The current `POST /api/code-space/agent` route validates the request, guards the project path, creates a server-side `ReadableStream`, runs `AgentRuntime`, and emits server-sent events back to the browser.

Key files:

- `app/api/code-space/agent/route.ts`
- `lib/code-space/runtime/agentRuntime.ts`
- `lib/code-space/runtime/events.ts`
- `lib/code-space/agent/types.ts`

### 3.2 Agent modes

Code Space supports:

- Ask mode
- Plan mode
- Code mode

Plan mode can write markdown plan artifacts. Code mode can consume a build-from-plan prompt and run the tool loop.

Key files:

- `lib/code-space/runtime/planAgentLoop.ts`
- `lib/code-space/runtime/planningEngine.ts`
- `lib/code-space/runtime/codeAgentLoop.ts`
- `lib/code-space/planBuild.ts`

### 3.3 Tooling surface

The tool executor already exposes useful tools:

- `read_file`
- `list_files`
- `search_text`
- `repo_map`
- `dependency_trace`
- `git_status`
- `git_diff`
- `research_web`
- `harness_context`
- `scan_code_quality`
- `run_validation_matrix`
- `read_artifact`
- `grep_artifact`
- `edit_file`
- `create_files`
- `create_directory`
- `run_command`
- PTY terminal tools
- browser tools
- checkpoint restore
- subagent spawning
- `attempt_completion`

Key files:

- `lib/code-space/runtime/toolExecutor.ts`
- `lib/code-space/runtime/toolRegistry.ts`
- `lib/code-space/runtime/terminalRunner.ts`
- `lib/code-space/runtime/browserController.ts`

### 3.4 Validation and repair

The runtime can detect validation commands and run them progressively. It can also invoke a repair loop after failures.

Key files:

- `lib/code-space/runtime/validationRunner.ts`
- `lib/code-space/runtime/repairLoop.ts`
- `lib/code-space/runtime/integrationVerifier.ts`
- `lib/code-space/runtime/supervisor.ts`

### 3.5 Safety and review

The runtime contains:

- path guarding
- permission manager
- terminal policy
- checkpoints
- diff confirmation
- pending validation records
- patch review UI
- supervisor verdicts

Key files:

- `lib/security/pathGuard.ts`
- `lib/code-space/runtime/permissionManager.ts`
- `lib/code-space/runtime/terminalPolicy.ts`
- `lib/code-space/runtime/checkpointManager.ts`
- `components/code-space/InlinePatchReview.tsx`

---

## 4. Why Implementation Is Poor After Planning

### 4.1 The plan is not converted into a strict execution contract

There is a plan artifact and a build-from-plan prompt, but the runtime does not yet treat the plan as a structured execution graph.

Current behavior:

- The plan exists as markdown.
- Code mode receives instructions to read the plan when the prompt includes a plan path.
- `ImplementationContract` extracts bullets/headings from the prompt and plan markdown.
- Coverage evidence is then added broadly.

Critical issue:

`addCoverageEvidence()` currently marks **every non-blocked requirement** as `covered` whenever one evidence item is added. This means one patch or validation result can make the contract look covered even if only a small portion of the plan was implemented.

Impact:

- The agent can under-implement and still appear partly successful.
- The supervisor cannot reliably block missing plan requirements.
- The UI cannot show accurate requirement-by-requirement progress.

Required fix:

Replace broad coverage with explicit requirement mapping:

```text
Plan requirement -> expected files -> implementation evidence -> validation evidence -> status
```

Each requirement must be one of:

- `pending`
- `in_progress`
- `implemented`
- `validated`
- `blocked`
- `out_of_scope`

A run should not claim success until every in-scope requirement is validated or explicitly blocked with evidence.

---

### 4.2 The plan-to-code handoff relies too much on prompt wording

`buildPlanImplementationPrompt()` gives good natural-language instructions, but the runtime should not rely on the model voluntarily following them.

Current behavior:

- The UI stores `planMarkdown` on the session.
- The prompt may include `Build from the approved plan at <path>`.
- `extractBuildPlanPath()` detects the plan path from prompt text.
- `AgentRuntime` reads the plan only if the path is extracted.

Gap:

The active plan should be passed as a first-class runtime field, not inferred from a sentence in the prompt.

Required fix:

Extend the Code Space run payload:

```ts
activePlan?: {
  filePath: string;
  content: string;
  approvedAt?: number;
  sourceSessionId: string;
}
```

Then `AgentRuntime.finishCode()` should create a structured contract from this object automatically.

---

### 4.3 Exact SEARCH/REPLACE is safe but too brittle as the primary edit interface

Exact edit blocks are good for auditability, but enterprise coding agents usually need more robust edit primitives.

Current edit limitations:

- The model must provide exact unique search text.
- Large files, formatting shifts, generated code, and repeated code blocks cause failures.
- Recovery asks the model to retry with smaller search text.
- Repeated failures can lead to very small patches or abandoned implementation.

Required additions:

1. `rewrite_file_safe`
   - Replace a whole file only after the server checks file hash, size, syntax, and diff risk.
   - Useful when repeated exact-match edits fail.

2. `apply_structured_patch`
   - Accept unified patches or typed file operations.
   - Pre-validate paths, hashes, and syntax before writing.

3. `inspect_symbol`
   - Locate exported functions/classes/components/types by symbol name.
   - Return ranges and import/export relationships.

4. `replace_symbol`
   - Replace one function/component/type body by AST range where possible.

5. `update_imports`
   - Deterministically repair import paths and symbol names after moves/renames.

6. `create_or_update_tests`
   - Target test files from source files and generate/edit tests through the same diff pipeline.

This preserves safety while making implementation more reliable.

---

### 4.4 Validation detection is too shallow for real projects

`ValidationRunner.detectValidationCommands()` is useful, but it is not enterprise-grade yet.

Current limitations:

- It finds the first package config from a small fixed path list.
- It does not fully understand workspaces or monorepos.
- It does not build a task-specific validation plan.
- It does not map changed source files to related tests unless changed files are already test files.
- It does not parse diagnostics into file/line/symbol repair targets.
- It does not detect all useful scripts such as `format`, `e2e`, `check`, `test:unit`, `test:integration`, `test:e2e`, `verify`, `ci`, or package-specific commands.

Required fix:

Introduce a validation planner:

```text
Repository discovery -> validation profile -> affected package(s) -> focused checks -> full checks -> parsed diagnostics -> repair routing
```

New runtime object:

```ts
ValidationProfile = {
  packages: PackageProfile[];
  commands: ValidationCommand[];
  sourceToTestMap: SourceTestLink[];
  defaultOrder: ValidationStage[];
  requiredStagesByChangeKind: Record<ChangeKind, ValidationStage[]>;
}
```

Validation should become requirement-aware:

- code-only change -> typecheck + focused tests + lint if available
- UI change -> typecheck + lint + browser preview + screenshot/console check
- package/config change -> install-free dependency check + build
- runtime/tooling change -> unit tests + integration/eval fixture
- docs-only change -> markdown/lint if configured, no false build requirement

---

### 4.5 Repair loop is too command-output-driven, not diagnosis-driven

The current loop gives validation output back to the model and asks it to repair. This is useful but weak.

Enterprise-grade repair needs:

1. Failure classification
   - syntax
   - type mismatch
   - import resolution
   - missing dependency
   - failed assertion
   - snapshot/browser mismatch
   - lint/style
   - timeout/flaky
   - environmental/missing tool

2. Diagnostic extraction
   - file path
   - line/column
   - symbol
   - command
   - stack anchor
   - relevant artifact id

3. Targeted recall
   - read failing range
   - read related imports
   - read related tests
   - read generated diff

4. Bounded repair
   - retry only affected areas
   - stop repeated identical failure fingerprints
   - distinguish agent-caused failures from pre-existing failures

The runtime has some repeated-failure and artifact support, but the repair planner needs structured diagnostic objects rather than plain text.

---

### 4.6 Subagents are mostly advisory, not true package executors

The current subagent system is a good start, but it does not yet behave like a real multi-agent engineering team.

Current behavior:

- Work graph is keyword-triggered.
- Dependencies are empty.
- Most subagent roles are read-only.
- Results are summaries returned to the parent.
- `AgentOrchestrator.run()` is legacy/no-op.
- Parent implementation still performs most actual edits.

Impact:

- Subagents can improve analysis but do not guarantee implementation depth.
- Large plans are not decomposed into enforceable packages.
- There is no per-package acceptance criteria gate.
- The parent can ignore or partially use subagent findings.

Required fix:

Make work graph execution first-class:

```text
Plan -> WorkGraph -> WorkPackages -> Package implementers -> Package validation -> Integration merge -> Supervisor verdict
```

Each work package should have:

- title
- scope
- owner role
- dependencies
- files expected
- acceptance criteria
- validation expectations
- risk level
- allowed tools
- changed files
- evidence
- blockers
- status

Suggested package statuses:

- `queued`
- `ready`
- `running`
- `blocked`
- `implemented`
- `validated`
- `merged`
- `rejected`

For write-heavy package execution, prefer isolated git worktrees or patch branches to avoid conflicts.

---

### 4.7 Permission and sandbox policy is too narrow

The current `terminalPolicy.ts` blocks a few risky command patterns. This is not enough for a local coding agent.

Current risky patterns include examples like:

- `rm -rf`
- `git push`
- package installation commands
- migrations
- `curl | sh`

Enterprise-grade agents need broader policy:

- production deploys
- destructive git operations
- credential egress
- arbitrary network downloads
- shell script execution from remote sources
- filesystem escape attempts
- package manager install or dependency mutation
- database migrations/resets
- cloud CLI operations
- chmod/chown/sudo
- background daemons
- long-running process cleanup

Required fix:

Introduce a command classifier:

```ts
CommandRisk = {
  category: 'read_only' | 'build' | 'test' | 'install' | 'network' | 'deploy' | 'destructive' | 'credential' | 'database' | 'unknown';
  risk: 'safe' | 'medium' | 'high' | 'blocked';
  reason: string;
  approvalRequired: boolean;
}
```

Pair this with:

- worktree sandbox mode
- environment variable redaction
- allowed host/package registry policy
- per-project command allowlist from `AGENTS.md`
- audit events for every blocked/approved command

---

### 4.8 Instruction loading needs a standard project contract

Codoptic has project instruction loading concepts, but the repo itself lacks a standard `AGENTS.md`-style contract.

A strong coding-agent repository should include durable rules for:

- how to install and run the app
- validation commands
- coding conventions
- file boundaries
- security rules
- UI preview expectations
- commit/PR expectations
- what “done” means
- which commands are forbidden without explicit approval

Required fix:

Add a root `AGENTS.md` or Codoptic-native equivalent, and update `InstructionLoader` to discover:

1. global/user-level rules
2. repo-root rules
3. nested directory overrides
4. task-specific memories
5. explicit prompt instructions

Discovery should be deterministic and logged into the run feed.

---

### 4.9 UI streaming is eventful but not transparent enough

The route uses SSE and the provider layer emits text deltas, but the UI mostly sees status/progress events and whole assistant turn text after the provider turn finalizes.

Impact:

- Users feel the agent is “thinking internally in the background.”
- Long planning/implementation loops feel opaque.
- Issue #1 is valid: users need live token-level assistant output plus structured tool and validation events.

Required fix:

Add a first-class event type:

```ts
assistant_text_delta = {
  runId: string;
  messageId: string;
  delta: string;
  channel: 'analysis_visible' | 'summary' | 'answer';
}
```

The UI should show:

- live assistant text
- current tool call draft
- current work package
- requirement coverage changes
- validation running/failing/repairing
- blockers with exact evidence

Do not expose private chain-of-thought. Show concise progress and decisions, not hidden reasoning.

---

### 4.10 There is no strong eval loop proving agent quality

The repo has `scripts/agent-eval`, but the engine needs a richer benchmark harness before major runtime changes.

Required eval categories:

1. Single-file bug fix
2. Multi-file feature
3. UI behavior change
4. Runtime/tooling change
5. Validation failure repair
6. Refactor with import updates
7. Scratch project creation
8. Monorepo/package boundary task
9. Browser evidence required task
10. Security-policy blocked command task
11. Plan-to-code build task from a markdown plan
12. Docs-only change

Each eval should record:

- task prompt
- expected changed files
- forbidden changed files
- expected validation commands
- pass/fail criteria
- runtime events
- tool trajectory
- final diff
- validation artifacts
- requirement coverage
- supervisor verdict

Success should be measured by:

- task completion rate
- validation pass rate
- correct changed-file coverage
- unnecessary edit count
- zero-edit false success count
- repeated edit failure count
- repair success rate
- time/tool budget use
- user-review burden

---

## 5. Target Architecture

### 5.1 New core runtime objects

```ts
PlanContract = {
  id: string;
  planPath: string;
  planHash: string;
  requirements: PlanRequirement[];
  fileManifest: PlannedFileChange[];
  validationExpectations: ValidationExpectation[];
  assumptions: string[];
  nonGoals: string[];
}
```

```ts
PlanRequirement = {
  id: string;
  text: string;
  sourceSection: string;
  priority: 'must' | 'should' | 'could';
  expectedFiles: string[];
  acceptanceCriteria: string[];
  status: 'pending' | 'in_progress' | 'implemented' | 'validated' | 'blocked' | 'out_of_scope';
  evidence: RequirementEvidence[];
}
```

```ts
RequirementEvidence = {
  kind: 'file_read' | 'patch' | 'test' | 'validation' | 'browser' | 'review' | 'blocker';
  path?: string;
  command?: string;
  artifactId?: string;
  summary: string;
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
}
```

```ts
WorkPackage = {
  id: string;
  requirementIds: string[];
  title: string;
  files: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
  allowedTools: string[];
  status: WorkPackageStatus;
  changedFiles: string[];
  validationEvidence: RequirementEvidence[];
}
```

### 5.2 Runtime flow after upgrade

```text
User approves plan
  ↓
Runtime receives activePlan object
  ↓
PlanContract parser extracts requirements, file manifest, validation expectations
  ↓
ValidationProfile detects packages, commands, source-test links
  ↓
WorkGraph planner creates implementation packages
  ↓
Explorer/docs/security/ui/verifier subagents gather evidence
  ↓
Implementer packages apply patches in isolated worktree/ledger
  ↓
Validation planner runs focused checks
  ↓
Repair loop parses diagnostics and patches affected files
  ↓
Integration owner reviews cumulative diff
  ↓
Supervisor verifies every requirement has patch + validation evidence or exact blocker
  ↓
UI shows requirement coverage, changed files, validation artifacts, and final verdict
```

---

## 6. Phased Implementation Roadmap

### Phase 0 — Eval baseline before engine changes

Goal: prove the current failure mode and prevent regressions.

Tasks:

- Expand `scripts/agent-eval` with plan-to-code fixtures.
- Add fixtures for small, medium, large, UI, validation-repair, and scratch-project tasks.
- Record trajectories as JSONL.
- Score requirement coverage, changed-file expectations, validation status, and false-success cases.
- Add a local command such as `npm run eval:agent -- --suite code-space-core`.

Deliverables:

- `scripts/agent-eval/fixtures/code-space/*.json`
- `scripts/agent-eval/reporters/coverage.ts`
- `docs/code-space-agent-evals.md`

Acceptance criteria:

- At least 10 replayable fixtures.
- Current baseline report captures known under-implementation.
- Future PRs can compare before/after metrics.

---

### Phase 1 — Strict plan-to-code contract

Goal: make the plan a machine-checkable source of truth.

Tasks:

- Pass active session plan into runtime payload directly.
- Parse plan markdown into `PlanContract`.
- Replace broad `addCoverageEvidence()` behavior with requirement-specific evidence mapping.
- Add requirement blockers to `Supervisor`.
- Emit `coverage_updated` when each requirement changes status.
- Add UI coverage panel in Code Space.

Files likely touched:

- `lib/code-space/planBuild.ts`
- `components/code-space/CodeSpaceWorkspace.tsx`
- `lib/code-space/runtime/agentRuntime.ts`
- `lib/code-space/runtime/implementationContract.ts`
- `lib/code-space/runtime/supervisor.ts`
- `components/code-space/AgentPanel.tsx`
- `components/code-space/agentRunFeed.ts`

Acceptance criteria:

- One small patch cannot cover all plan requirements.
- Supervisor blocks success when any must-have requirement lacks implementation/validation evidence.
- UI shows each requirement as pending, implemented, validated, or blocked.

---

### Phase 2 — Stronger edit harness / agent-computer interface

Goal: reduce tiny/failed edits and improve multi-file implementation quality.

Tasks:

- Add `rewrite_file_safe` with hash, size, syntax, and diff-risk checks.
- Add AST/symbol inspection for TypeScript/JavaScript and Python.
- Add `replace_symbol` and `update_imports` where possible.
- Add import/call-site repair after file moves or symbol renames.
- Add deterministic formatting hook when project formatter is available.
- Add patch-size/risk classification before writing.

Files likely touched:

- `lib/code-space/runtime/toolExecutor.ts`
- `lib/code-space/runtime/toolRegistry.ts`
- `lib/code-space/agent/editBlocks.ts`
- `lib/code-space/runtime/dependencyTrace.ts`
- new `lib/code-space/runtime/symbolIndex.ts`
- new `lib/code-space/runtime/structuredPatch.ts`

Acceptance criteria:

- Repeated exact-match failures fall back to safe whole-file rewrite only when appropriate.
- Import updates after symbol/file changes are deterministic.
- Multi-file tasks produce the expected number of coherent changes.

---

### Phase 3 — Validation harness upgrade

Goal: make validation task-aware, package-aware, and repair-friendly.

Tasks:

- Detect all package roots and workspaces.
- Build `ValidationProfile` per project.
- Detect scripts beyond `typecheck/lint/test/build`.
- Map changed source files to related tests.
- Parse TypeScript, ESLint, Vitest, Playwright, pytest, Go, and Rust diagnostics.
- Distinguish pre-existing failures from agent-caused failures.
- Require browser evidence for UI-affecting changes.

Files likely touched:

- `lib/code-space/runtime/validationRunner.ts`
- `lib/code-space/runtime/repairLoop.ts`
- `lib/code-space/runtime/integrationVerifier.ts`
- new `lib/code-space/runtime/validationProfile.ts`
- new `lib/code-space/runtime/diagnostics.ts`

Acceptance criteria:

- Validation output references file/line/symbol where possible.
- Repair loop reads the exact failing ranges before editing.
- UI changes cannot be marked verified without browser/screenshot/console evidence.

---

### Phase 4 — Real work graph orchestration

Goal: turn advisory subagents into enforceable implementation packages.

Tasks:

- Make `AgentOrchestrator.run()` non-empty or remove legacy path.
- Add dependency-aware scheduler for work packages.
- Allow implementer package execution in isolated worktree/ledger mode.
- Require package-level acceptance criteria.
- Merge package diffs through integration review.
- Block completion until all required packages are implemented, validated, or blocked.

Files likely touched:

- `lib/code-space/runtime/agentOrchestrator.ts`
- `lib/code-space/runtime/delegationPlanner.ts`
- `lib/code-space/runtime/subagentRunner.ts`
- `lib/code-space/runtime/coworkingRunManager.ts`
- `lib/code-space/runtime/contextLedger.ts`
- `lib/code-space/runtime/supervisor.ts`

Acceptance criteria:

- Large plans become multiple packages with dependencies.
- Each package has evidence and validation state.
- Parent cannot ignore failed package results.

---

### Phase 5 — Permissions, sandbox, and command policy

Goal: make local autonomy safer and more enterprise-credible.

Tasks:

- Replace simple risky regex with a command classifier.
- Add project command allowlist/denylist from `AGENTS.md`.
- Add trusted package registry and network policy.
- Add worktree sandbox for agent edits.
- Add sensitive output redaction for env vars, cookies, tokens, and cloud credentials.
- Add audit events for blocked/approved commands.

Files likely touched:

- `lib/code-space/runtime/terminalPolicy.ts`
- `lib/code-space/runtime/permissionManager.ts`
- `lib/code-space/runtime/toolRegistry.ts`
- `lib/code-space/runtime/terminalRunner.ts`
- new `lib/code-space/runtime/commandClassifier.ts`
- new `lib/code-space/runtime/worktreeSandbox.ts`

Acceptance criteria:

- Risky command categories are correctly classified.
- High-risk commands require approval or are blocked.
- Agent edits can run in an isolated worktree when configured.

---

### Phase 6 — Code Space UX and streaming transparency

Goal: make the implementation loop visible, interruptible, and reviewable.

Tasks:

- Add true assistant text delta events for user-visible progress.
- Add requirement coverage panel.
- Add work package board.
- Add validation artifact viewer with parsed diagnostics.
- Add blocker cards with exact evidence.
- Add “continue from blocked package” action.
- Add compact trace export for debugging.

Files likely touched:

- `components/code-space/CodeSpaceWorkspace.tsx`
- `components/code-space/AgentPanel.tsx`
- `components/code-space/BottomPanel.tsx`
- `components/code-space/agentRunFeed.ts`
- `lib/code-space/agent/types.ts`
- `lib/code-space/runtime/events.ts`

Acceptance criteria:

- Users can see live progress during long model turns.
- Users can inspect which requirement is being implemented.
- Users can see validation and repair attempts without reading raw logs first.

---

### Phase 7 — Continuous agent improvement loop

Goal: make agent quality measurable.

Tasks:

- Add trace capture for every run.
- Add trajectory replay for eval fixtures.
- Add pass/fail report generation.
- Track token/tool budgets, validation outcomes, changed-file quality, and false success.
- Add a CI or local gated command for agent-engine changes.

Files likely touched:

- `scripts/agent-eval/run.ts`
- `scripts/agent-eval/lib/*`
- `docs/code-space-agent-evals.md`
- `package.json`

Acceptance criteria:

- Any engine change can be compared against the baseline.
- Reports show task completion and validation quality, not only runtime success.

---

## 7. Immediate PR Sequence

Recommended next commits after this audit:

1. **Add Code Space agent eval baseline**
   - Add initial plan-to-code fixtures.
   - Record current weak behavior.

2. **Fix implementation contract coverage**
   - Make evidence requirement-specific.
   - Supervisor blocks uncovered must-have requirements.

3. **Pass active plan as structured runtime input**
   - Stop relying on prompt-text plan path extraction.
   - Parse the approved plan into a contract automatically.

4. **Upgrade validation discovery**
   - Workspaces, source-to-test mapping, more scripts, diagnostics parsing.

5. **Add safe whole-file rewrite fallback**
   - Use only after repeated exact-match edit failures.

6. **Add command classifier**
   - Replace narrow terminal risk regex with category-based policy.

7. **Add streaming text delta UI**
   - Resolve Issue #1 transparently.

---

## 8. Success Metrics

The engine should be considered upgraded only when these metrics improve in evals:

- Plan-to-code task completion rate
- Number of requirements validated per task
- False-success rate with incomplete requirements
- Zero-change success attempts
- Validation pass rate
- Repair success rate after first failure
- Expected changed-file recall
- Unnecessary changed-file precision
- Browser evidence completion for UI tasks
- Blocker quality when task cannot be completed

Minimum target for first milestone:

```text
10 baseline tasks
0 successful completions with uncovered must-have requirements
>= 80% correct validation command selection on Node/TS tasks
>= 70% expected file coverage on multi-file tasks
100% blocked risky commands in command-policy fixtures
```

---

## 9. Final Diagnosis

Codoptic’s Code Space is already architecturally promising, but it currently behaves more like a visible coding assistant than a fully governed coding agent. The biggest gap is not UI polish or prompt strength. The biggest gap is enforcement.

To become enterprise-grade, Code Space needs:

1. Plan requirements as machine-checkable contracts.
2. Requirement-specific implementation and validation evidence.
3. A stronger agent-computer interface for edits, symbols, imports, tests, and repair.
4. Package-aware validation and diagnostics.
5. Real work-graph execution, not only advisory subagent summaries.
6. Broader sandbox and permission policy.
7. Live streaming transparency.
8. A regression eval loop.

The next implementation should start with evals and contract enforcement. Without those two foundations, any prompt or tool improvement will be hard to verify and easy to regress.
