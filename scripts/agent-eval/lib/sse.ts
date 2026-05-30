/**
 * SSE client for the Code Space agent endpoint.
 *
 * Drives POST /api/code-space/agent and decodes the `data: {json}` event stream
 * the runtime emits (see lib/code-space/runtime/events.ts encodeSseEvent).
 */

export interface AgentRequestBody {
  sessionId: string;
  projectRoot: string;
  projectName: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
  model: string;
  providerId: 'foundry' | 'openai' | 'anthropic' | 'gemini' | 'grok' | 'local';
  apiKey: string;
  endpoint?: string;
  openTabs?: string[];
  mode?: 'ask' | 'plan' | 'code';
  toolBudget?: number;
  autonomy?: string;
  attachments?: Array<{ kind: 'file' | 'folder'; relativePath: string; displayName?: string }>;
}

export interface ResumeValidationBody {
  runId: string;
  projectRoot: string;
  projectName: string;
  model: string;
  providerId: 'foundry' | 'openai' | 'anthropic' | 'gemini' | 'grok' | 'local';
  apiKey: string;
  endpoint?: string;
  toolBudget?: number;
  decision?: 'confirm' | 'cancel';
}

export interface CollectedEvent {
  type: string;
  [key: string]: unknown;
}

export interface RunResult {
  events: CollectedEvent[];
  /** Concatenated text_delta payloads (the assistant's visible answer). */
  text: string;
  /** Structured runtime events unwrapped from { type: 'structured_event', event }. */
  structured: Array<{ type: string; payload?: Record<string, unknown> }>;
  rawLines: number;
}

export interface RunOptions {
  baseUrl: string;
  timeoutMs?: number;
  onEvent?: (event: CollectedEvent) => void;
  /**
   * When the run pauses at the pre-validation diff gate, automatically confirm and resume
   * validation (simulating the user clicking "Confirm & validate"). Defaults to true.
   */
  confirmDiff?: boolean;
}

interface Sink {
  events: CollectedEvent[];
  structured: RunResult['structured'];
  text: string;
  rawLines: number;
}

async function streamPost(url: string, body: unknown, sink: Sink, options: RunOptions): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 240_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${url} returned ${res.status}: ${detail.slice(0, 500)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        sink.rawLines += 1;
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        let event: CollectedEvent;
        try {
          event = JSON.parse(json) as CollectedEvent;
        } catch {
          continue;
        }
        sink.events.push(event);
        options.onEvent?.(event);
        if (event.type === 'text_delta' && typeof event.delta === 'string') sink.text += event.delta;
        if (event.type === 'structured_event' && event.event && typeof event.event === 'object') {
          const inner = event.event as { type?: string; payload?: Record<string, unknown> };
          if (inner.type) sink.structured.push({ type: inner.type, payload: inner.payload });
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAgent(body: AgentRequestBody, options: RunOptions): Promise<RunResult> {
  const sink: Sink = { events: [], structured: [], text: '', rawLines: 0 };
  await streamPost(`${options.baseUrl}/api/code-space/agent`, body, sink, options);

  const gate = sink.events.find((event) => event.type === 'diff_confirmation_required');
  if (gate && options.confirmDiff !== false) {
    options.onEvent?.({ type: 'harness_confirm_diff', runId: String(gate.runId) });
    await streamPost(
      `${options.baseUrl}/api/code-space/runs/validate`,
      {
        runId: gate.runId,
        projectRoot: body.projectRoot,
        projectName: body.projectName,
        model: body.model,
        providerId: body.providerId,
        apiKey: body.apiKey,
        endpoint: body.endpoint,
        toolBudget: body.toolBudget ?? 50,
        decision: 'confirm',
      },
      sink,
      options,
    );
  }

  return { events: sink.events, text: sink.text, structured: sink.structured, rawLines: sink.rawLines };
}

export function eventsOfType(result: RunResult, type: string): CollectedEvent[] {
  return result.events.filter((event) => event.type === type);
}

export function firstEvent(result: RunResult, type: string): CollectedEvent | undefined {
  return result.events.find((event) => event.type === type);
}
