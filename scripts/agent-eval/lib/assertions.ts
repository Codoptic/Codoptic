/**
 * Definition-of-Done assertion helpers for the agent eval harness.
 * Each helper inspects a RunResult (collected SSE events + text) and returns a
 * boolean plus a human-readable detail string.
 */
import type { RunResult, CollectedEvent } from './sse';

export interface CheckOutcome {
  ok: boolean;
  detail: string;
}

export function clarifyingQuestions(result: RunResult): CollectedEvent['questions'] extends infer _ ? Array<Record<string, unknown>> : never {
  const event = result.events.find((event) => event.type === 'clarifying_questions_created');
  return (event?.questions as Array<Record<string, unknown>>) ?? [];
}

export function asksClarifyingQuestions(result: RunResult, min = 2): CheckOutcome {
  const questions = clarifyingQuestions(result);
  const withChoices = questions.filter((q) => {
    const choices = (q.choices as unknown[]) ?? (q.options as unknown[]) ?? [];
    return Array.isArray(choices) && choices.length >= 2;
  });
  return {
    ok: questions.length >= min && withChoices.length >= min,
    detail: `${questions.length} clarifying question(s), ${withChoices.length} with >=2 choices (need >=${min} MCQ)`,
  };
}

export function questionsHaveRationale(result: RunResult): CheckOutcome {
  const questions = clarifyingQuestions(result);
  if (!questions.length) return { ok: false, detail: 'no clarifying questions emitted' };
  const withRationale = questions.filter((q) => typeof q.rationale === 'string' && (q.rationale as string).trim().length > 0);
  return {
    ok: withRationale.length === questions.length,
    detail: `${withRationale.length}/${questions.length} questions carry a rationale`,
  };
}

export function planContent(result: RunResult): string | undefined {
  const event = result.events.find((event) => event.type === 'plan_markdown_created');
  return event && typeof event.content === 'string' ? (event.content as string) : undefined;
}

export function planHasSections(result: RunResult, sections: string[]): CheckOutcome {
  const content = planContent(result);
  if (!content) return { ok: false, detail: 'no plan_markdown_created event' };
  const lower = content.toLowerCase();
  const missing = sections.filter((section) => !lower.includes(section.toLowerCase()));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing sections: ${missing.join(', ')}` : `all ${sections.length} required sections present`,
  };
}

const REAL_VALIDATION = /\b(npm|pnpm|yarn|bun|node|python3|go|cargo|tsc|vitest|pytest|jest)\b/;

export function ranRealValidation(result: RunResult): CheckOutcome {
  const validations = result.events.filter((event) => event.type === 'validation_result');
  const real = validations.filter((event) => {
    const command = String(event.command ?? '');
    const status = String(event.status ?? '');
    return REAL_VALIDATION.test(command) && status !== 'skipped';
  });
  return {
    ok: real.length > 0,
    detail: `${real.length}/${validations.length} validation result(s) ran a real command (non-skipped)`,
  };
}

export function diffGateBeforeValidation(result: RunResult): CheckOutcome {
  const gateIndex = result.events.findIndex((event) => event.type === 'diff_confirmation_required');
  const firstValidation = result.events.findIndex((event) => event.type === 'validation_result');
  if (gateIndex === -1) return { ok: false, detail: 'no diff_confirmation_required event emitted' };
  if (firstValidation === -1) return { ok: true, detail: 'diff gate emitted; no validation ran before confirmation (correct)' };
  return {
    ok: gateIndex < firstValidation,
    detail: gateIndex < firstValidation ? 'diff gate preceded validation' : 'validation ran before the diff gate (gap)',
  };
}

export function diffGateCarriesDiff(result: RunResult): CheckOutcome {
  const event = result.events.find((event) => event.type === 'diff_confirmation_required');
  if (!event) return { ok: false, detail: 'no diff_confirmation_required event' };
  const diff = String(event.unifiedDiff ?? event.diff ?? '');
  const files = (event.files as unknown[]) ?? [];
  return {
    ok: diff.length > 0 || (Array.isArray(files) && files.length > 0),
    detail: diff.length ? `aggregated diff is ${diff.length} chars` : `${Array.isArray(files) ? files.length : 0} changed file entries`,
  };
}

export function producedFileChanges(result: RunResult): CheckOutcome {
  const applied = result.events.filter((event) => event.type === 'file_applied');
  const proposed = result.events.filter((event) => event.type === 'diff_proposed');
  return {
    ok: applied.length + proposed.length > 0,
    detail: `${applied.length} applied, ${proposed.length} proposed file change(s)`,
  };
}

export function noVerifiedWithoutChanges(result: RunResult): CheckOutcome {
  const done = result.events.find((event) => event.type === 'agent_done');
  const verdict = result.events.find((event) => event.type === 'supervisor_verdict');
  const filesChanged = (done?.filesChanged as unknown[]) ?? [];
  const verified = verdict?.status === 'verified';
  if (!verified) return { ok: true, detail: 'run not marked verified (n/a)' };
  return {
    ok: Array.isArray(filesChanged) && filesChanged.length > 0,
    detail: verified ? `verified with ${Array.isArray(filesChanged) ? filesChanged.length : 0} changed file(s)` : 'not verified',
  };
}

export function knowledgeGraphReady(result: RunResult): CheckOutcome {
  const event = result.events.find(
    (event) => event.type === 'knowledge_graph_ready' || (event.type === 'structured_event' && (event.event as { type?: string })?.type === 'knowledge_graph.ready'),
  );
  return { ok: Boolean(event), detail: event ? 'knowledge_graph_ready emitted' : 'no knowledge graph event' };
}

export function noAgentError(result: RunResult): CheckOutcome {
  const error = result.events.find((event) => event.type === 'agent_error');
  return { ok: !error, detail: error ? `agent_error: ${String(error.message).slice(0, 160)}` : 'no agent_error' };
}

export function noStructuredEvent(result: RunResult, type: string): CheckOutcome {
  const hit = result.events.some((event) => event.type === 'structured_event' && (event.event as { type?: string })?.type === type);
  return { ok: !hit, detail: hit ? `unexpected ${type}` : `no ${type}` };
}

export function usedTool(result: RunResult, name: string): CheckOutcome {
  const hit = result.events.some((event) => event.type === 'tool_start' && event.tool === name);
  return { ok: hit, detail: hit ? `used ${name}` : `did not call ${name}` };
}

export function citedMemoryPath(result: RunResult): CheckOutcome {
  const text = `${result.text ?? ''} ${JSON.stringify(result.events)}`;
  const ok = /memories\/[\w./-]+\.(md|txt|json)/i.test(text);
  return { ok, detail: ok ? 'cited a memories/ path' : 'did not cite memories/*' };
}

export function failFastValidation(result: RunResult): CheckOutcome {
  const validations = result.events.filter((event) => event.type === 'validation_result');
  const syntaxFail = validations.find((event) => /syntax|compileall/i.test(String(event.command ?? '')) && event.status === 'failed');
  if (!syntaxFail) return { ok: true, detail: 'no syntax failure (n/a)' };
  const later = validations.filter((event) => /e2e|build/i.test(String(event.command ?? '')));
  return { ok: later.length === 0, detail: later.length ? 'ran e2e/build after syntax fail' : 'stopped after syntax fail' };
}

export function noDiskWrites(result: RunResult): CheckOutcome {
  const writes = result.events.filter((event) => event.type === 'file_applied' || event.type === 'diff_proposed');
  return { ok: writes.length === 0, detail: writes.length ? `${writes.length} write event(s)` : 'no disk writes' };
}
