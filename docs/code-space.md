# Code Space — Agentic Coding Workspace

Code Space is the part of Codoptic that feels most like a coding assistant. It is a reviewable, repo-aware agent that inspects your code, drafts a plan, proposes patches, and runs the project's real validation commands — with the user holding the gate at every meaningful step.

The workspace is exposed at `/code-space`, and from the main editor the **Mode switch** in the top bar moves between:

- **Diagram Editor** — paste or type DSL, render it live, inspect nodes and edges, and export PNG, SVG, or JSON.
- **Code Space** — the agentic coding workspace described in this document.
- **Single Layer** — analyze a repository and generate one architecture layer.
- **Multi Layer** — analyze a repository and generate layered diagrams.
- **App Planner** — describe what you want, answer follow-up questions, and generate a diagram plan.

## The Loop

Every Code Space task follows the same structured loop:

1. Pick or create a project.
2. Open or start a session.
3. Choose an agent mode (Ask / Plan / Code).
4. Ask the agent to inspect the repo, reason about the task, and prepare a plan.
5. Review any proposed file changes before they are applied.
6. Run validation and check the outcome in the bottom panel.

## Sessions And Runs

Code Space separates a long-lived **session** from a specific **run**:

- A **session** is the conversational container. It stores the title, message history, plan, TODOs, tool calls, review state, and verification results.
- A **run** is one execution of the agent against that session. Runs can be started, cancelled, retried, and tracked independently.

This split lets you keep a persistent discussion while preserving a clean record of each agent attempt.

## Agent Modes

| Mode | Behavior |
| --- | --- |
| **Ask** | Read-only analysis and explanation. The agent inspects the repo and answers without changing any files. |
| **Plan** | Deeper analysis that produces an editable markdown plan before any implementation work begins. |
| **Code** | Default implementation mode. The agent analyzes the repo, drafts a plan, and moves toward changes with review and validation steps. |

The mode selector in the agent panel mirrors this directly, so you choose how far the workspace should go before it starts proposing edits.

## What Happens During A Run

The runtime is intentionally structured rather than monolithic. In broad terms, a run does the following:

- Collects project context from the selected repository and the open tabs.
- Loads bounded durable project memories from `/memories/` when they exist.
- Detects useful validation commands from the project stack.
- Automatically delegates complex Code-mode runs to a small set of isolated read-only subagents.
- Streams assistant output back into the UI as the run progresses.
- Builds a visible plan and TODO list so the work can be tracked step by step.
- Emits tool calls and patch proposals into the agent panel.
- Marks the run complete once the validation phase finishes.

The current runtime is conservative by design. It creates a visible plan, surfaces the relevant files and commands, and keeps patch application approval-gated so the user stays in control of repository changes.

## Review And Validation

The right-hand agent panel is where the review loop lives:

- Proposed file changes appear as diffs that can be accepted or rejected.
- Tool calls are listed with their status so you can see what the agent is doing.
- The plan and TODO sections show progress in plain language.
- Verification results appear after the agent finishes, including the commands it used to check the repo.

The bottom panel complements that by collecting output, problems, debug events, and terminal activity in one place.

### Trust Gates

Two gates make the loop trustworthy:

- **Clarification gate.** Genuinely ambiguous requests trigger multiple-choice clarifying questions (each with a rationale and labeled options) before any plan or code is written.
- **Pre-validation diff gate.** Before validation runs, the agent surfaces the full aggregated diff of every change (a real `git diff` when the repo is git-connected, otherwise a change-ledger diff). You confirm to run the project's detected validation commands, or cancel to revert.

## Knowledge Graph

On the first Plan run for a project, Code Space builds a code knowledge graph (an offline AST/import-graph pipeline under [`tools/graphify/`](../tools/graphify)) and caches it in `.codoptic-cache/knowledge-graph/`. The graph is reused on later runs to bias context selection toward the repository's central modules ("god nodes").

A **Knowledge graph** link above the chat opens an interactive vis.js map of the codebase. An optional Foundry semantic pass can annotate central files, but the code graph always works offline.

## Automatic Delegation

Complex Code-mode tasks now get an explicit delegation phase after context sufficiency is assessed and before the parent coding loop edits files. The runtime can spawn up to three isolated subagents for independent repo exploration, documentation/convention reading, and critique or validation-risk review.

These automatic subagents are read-only. They share the workspace root and event stream, but they run with fresh context windows and cannot recursively spawn more subagents. Their findings are injected back into the parent agent's prompt, surfaced in the run feed, and reconciled before the supervisor can mark the run verified. The existing test-writer subagent still runs later in validation and is limited to `.agent/tests/<runId>/`.

## Project Memories

Durable project memory lives in `/memories/`, separate from derived caches such as `.codoptic-cache/knowledge-graph/`. Recommended files are:

- `memories/user-preferences.md`
- `memories/project-context.md`
- `memories/research-notes.md`
- `memories/decisions.md`

At run start, Code Space loads a bounded, relevant subset of these files and cites their paths in the prompt. Agents can list and read memories with safe tools. Memory updates are proposed through `propose_memory_update`; the runtime records the proposal but does not silently write memory files.

## Why It Feels Different

Instead of hiding all reasoning inside a single chat response, Codoptic makes the workflow explicit:

- repo inspection is visible
- plans are visible
- tool usage is visible
- patch review is visible
- validation is visible

That visibility is the whole point of the agentic experience: you can trust the agent more because you can see what it is doing and intervene at the right time.

## Internals

For the runtime, supervisor, and AI pipeline that drive Code Space, see [docs/architecture.md](architecture.md). For provider-specific behavior and retry semantics, see [docs/providers.md](providers.md).
