import { compile } from '../../dsl/compiler';
import { chatWithRetry, type ProviderSession, type RetryListener } from '../providers';
import { ELK_EDGE_LIMIT, ELK_COMPLEXITY_LIMIT, diagramComplexity } from '../../layout/constants';

const REPAIR_SYSTEM = `You are a DSL repairer. Given an invalid Codoptic DSL with diagnostics, return ONLY a corrected DSL — no fences, no prose. Preserve the original structure and intent. Do not add or remove nodes/groups except as needed to fix errors.

FORBIDDEN in names and labels:
- Never use "/" (slash) or "," (comma) — replace path separators (e.g. "api/v1/users") with spaces or hyphens ("api v1 users").
- Never use "{" or "}" inside a name — they are group-block delimiters.
- "--" is the dashed-edge operator, NOT a comment or annotation. Use "// text" for all comments; never "--" for descriptions.
- Attribute blocks [color: X, icon: Y] must follow the name with exactly one space, never appended after a "{...}" group block.

COMPLEXITY ERRORS — if the diagnostic mentions "too many edges", "Invalid array length", "ELK layout failed", "cannot safely process", or "complexity too high":
- The diagram has too many cross-group edges for the layout engine. Do NOT just fix syntax — you MUST reduce complexity.
- Complexity is measured as: (cross-group edges) × (1 + max nesting depth). Intra-group edges do not count.
- Remove low-value or purely informational edges (observability links, redundant dashed lines, edges that duplicate group membership).
- Consolidate multiple parallel edges between the same pair of nodes into a single labeled edge.
- Aggressive strategy: if > 100 cross-group edges, consider flattening the group hierarchy or moving some groups to separate diagrams.
- Preserve the most important data-flow and dependency edges; keep all nodes and groups intact; only remove edges.`;

// Re-export from the single source of truth so the rest of this file can
// reference stable local names while the values are actually defined in
// lib/layout/constants.ts (keeps grep-ability without duplication).
const REPAIR_EDGE_LIMIT       = ELK_EDGE_LIMIT;
const REPAIR_COMPLEXITY_LIMIT = ELK_COMPLEXITY_LIMIT;

export async function tryRepair(
  session: ProviderSession,
  dsl: string,
  opts: { maxAttempts?: number; signal?: AbortSignal; onRetry?: RetryListener } = {},
): Promise<{ dsl: string; attempts: number; errors: number }> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let current = dsl;
  for (let i = 0; i < maxAttempts; i++) {
    const diagram = compile(current);
    const syntaxErrors = diagram.diagnostics.filter((d) => d.severity === 'error');

    // Build the list of problems to hand to the LLM.
    // Include both syntax errors and any complexity/render errors.
    const problems: string[] = syntaxErrors.map(
      (e) => `- line ${e.line}:${e.column}: ${e.message}`,
    );

    if (diagram.edges.length > REPAIR_EDGE_LIMIT) {
      problems.push(
        `- render error: diagram has ${diagram.edges.length} edges — ELK layout cannot safely process more than ${REPAIR_EDGE_LIMIT}. ` +
          `Remove redundant or low-value edges to bring total below ${REPAIR_EDGE_LIMIT}.`,
      );
    }

    // Cross-group edge density crashes ELK's network-simplex even when the raw
    // edge count looks acceptable. The accurate metric is:
    //   crossGroupEdges × (1 + maxNestingDepth)
    const { score: complexity, crossGroupEdges, maxDepth } = diagramComplexity(diagram);
    if (complexity > REPAIR_COMPLEXITY_LIMIT) {
      problems.push(
        `- render error: diagram complexity too high (${crossGroupEdges} cross-group edges × nesting depth ${maxDepth + 1} = ${complexity}) — ` +
          `ELK layout cannot safely render this; the canvas shows an error banner instead. ` +
          `Consolidate parallel edges and remove low-value cross-group connections until the complexity score < ${REPAIR_COMPLEXITY_LIMIT}.`,
      );
    }

    if (problems.length === 0) return { dsl: current, attempts: i, errors: 0 };

    const messages = [
      { role: 'system' as const, content: REPAIR_SYSTEM },
      {
        role: 'user' as const,
        content: `Diagnostics:\n${problems.join('\n')}\n\nDSL:\n${current}`,
      },
    ];
    current = await chatWithRetry(session, messages, {
      signal: opts.signal,
      onRetry: opts.onRetry,
    });
    current = stripFences(current);
  }
  const final = compile(current);
  const finalEdgeTooMany = final.edges.length > REPAIR_EDGE_LIMIT ? 1 : 0;
  const { score: finalComplexity } = diagramComplexity(final);
  const finalComplexityTooHigh = finalComplexity > REPAIR_COMPLEXITY_LIMIT ? 1 : 0;
  return {
    dsl: current,
    attempts: maxAttempts,
    errors:
      final.diagnostics.filter((d) => d.severity === 'error').length +
      finalEdgeTooMany +
      finalComplexityTooHigh,
  };
}

function stripFences(s: string): string {
  return s.replace(/^```[a-zA-Z]*\n/m, '').replace(/```\s*$/m, '').trim();
}
