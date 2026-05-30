# Architecture

```
                  Monaco DSL editor
                         │
                         v
       lib/dsl/lexer ─► parser ─► compiler ─► IR (lib/ir/types.ts)
                                                 │
                                                 v
                                lib/layout/elk (compound graph)
                                                 │
                                                 v
                              lib/render/svgScene (pure SVG)
                                  │              │
            components/diagram   ─┘              └─► lib/export/{svg,png}
                  (viewport)                          (same scene → guarantee
                                                       PNG-equals-screen)
```

Modules:

- **lib/dsl** — lexer, parser, compiler, formatter.
- **lib/ir** — typed Diagram IR (Group, Node, Edge).
- **lib/layout** — ELK compound-graph wrapper + measure helpers.
- **lib/render** — SVG scene builder, theme palette, arrow markers.
- **lib/icons** — inline Lucide-style SVG icon registry.
- **lib/export** — SVG / PNG export from the same scene as the viewport.
- **lib/state** — Zustand store with undo/redo (zundo temporal middleware)
  and IndexedDB persistence.
- **lib/security** — `pathGuard` blocks scanning sensitive system paths.
- **lib/agent** — repo scanner, classifier, chunker, summarizer, planner,
  DSL compiler, repair, cache, multi-provider router with retry.
- **lib/util/stream** — SSE helpers for the streamed analysis pipeline.
- **app/api/repo/scan** — server-only filesystem walk.
- **app/api/agent/analyze** — streamed staged pipeline (SSE).
- **app/api/agent/validate** — provider credential ping.
- **components/shell, editor, diagram, inspector, agent** — UI.

## Why SVG-first?

The same `buildScene()` function produces the React element tree shown
on screen *and* the SVG serialized into a PNG. There is no `html2canvas`
or screenshotting — the export is the exact same scene with a different
wrapper. This means:

- Group title pills, drop-shadow glows, arrow markers, and small labels
  are all included in the export at the correct bounding box.
- Export at 1x / 2x / 4x scales is a single canvas multiplier; nothing
  reflows.

## Why DSL-as-source-of-truth + side-car overrides?

Manual edits (drag a node, change a color in the inspector) split into two
buckets:

1. **Property edits** that have a DSL representation (color, icon, label,
   direction). These are written back into the Monaco text by a structured
   rewrite ([components/inspector/shared.ts](../components/inspector/shared.ts)).
2. **Spatial edits** (drag position, edge bend points). These go to a
   `overrides` map in Zustand and never touch the DSL — auto-layout
   regenerates positions, overrides win when present.

This lets the DSL stay clean, copy-pasteable, and AI-generatable while
still allowing arbitrary manual tweaks.

## Staged AI pipeline

See [providers.md](./providers.md) for the retry contract.

1. **Validate** — 1-token ping to confirm key + model.
2. **Scan** — `fast-glob` with `.gitignore` + safe defaults.
3. **Classify** — heuristic relevance scoring per diagram type + focus.
4. **Chunk** — token-aware splitting (4 chars ≈ 1 token).
5. **Summarize** — JSON-mode per-file summary, cached by content hash.
6. **Subsystem** — folder clustering (heuristic, no LLM).
7. **Plan** — JSON-schema-validated `DiagramPlan` from the model.
8. **Compile** — `planToDsl()` deterministic.
9. **Validate + Repair** — round-trip through the parser; one repair pass
   if needed.

Progress is streamed over SSE; the animation in
[AnalysisAnimation.tsx](../components/agent/AnalysisAnimation.tsx) reads
those events.

## Code Space coding agent

The live coding agent runs `POST /api/code-space/agent` →
`AgentRuntime.run` ([lib/code-space/runtime/agentRuntime.ts](../lib/code-space/runtime/agentRuntime.ts))
→ `finishAsk` / `finishPlan` / `finishCode`, driven by `PlanAgentLoop` /
`CodeAgentLoop` + `ToolExecutor`. All progress is streamed over SSE
([lib/code-space/agent/types.ts](../lib/code-space/agent/types.ts)); run
phases live in [runState.ts](../lib/code-space/runtime/runState.ts).

Industry-standard behaviors layered on top:

1. **MCQ clarification + ambiguity hard-gate.** `assessPromptAmbiguity`
   ([workflowPolicy.ts](../lib/code-space/runtime/workflowPolicy.ts)) scores
   vague requests; when ambiguous, Plan mode must call
   `ask_clarifying_questions` (rich MCQs with `rationale` + labeled
   `options`) before authoring a plan. Plans must include a **Candidate
   Approaches and Recommendation** section
   ([planningEngine.ts](../lib/code-space/runtime/planningEngine.ts)).
2. **Pre-validation diff confirmation gate.** After edits and before
   validation, `finishCode` emits `diff_confirmation_required` (git diff when
   the repo is git-connected, else a ledger-derived unified diff) and pauses
   in `awaiting_diff_confirmation`. The user confirms via
   `POST /api/code-space/runs/validate`, which resumes the real detected
   validation commands → repair loop → supervisor.
3. **Context engineering.** `ContextGraphEngine` accepts external
   `structuralSignals` (central files/routes, and knowledge-graph hubs) to
   bias file selection; large files are skeletonized rather than truncated.
   Superpowers-style skills ([skills.ts](../lib/code-space/runtime/skills.ts))
   are injected into the workflow kernel as hard-gated disciplines.
4. **Knowledge graph (Graphify-adapted).** On the first Plan run,
   `ensureKnowledgeGraph` builds a code knowledge graph via the offline
   stdlib pipeline [tools/graphify/build_graph.py](../tools/graphify/build_graph.py)
   (detect → AST/regex extract → build → cluster → analyze → report →
   vis.js export), cached under `.codoptic-cache/knowledge-graph/`. It emits
   `knowledge_graph_ready`; subsequent runs reuse the cache to feed
   `structuralSignals` (god nodes / hubs) into context selection. The UI
   shows a **Knowledge graph** link that opens a modal rendering the
   interactive `graph.html` served by
   `app/api/code-space/knowledge-graph/view`. An optional Foundry semantic
   pass (`--semantic`) annotates central files; it is best-effort and never
   required for the offline code graph.
