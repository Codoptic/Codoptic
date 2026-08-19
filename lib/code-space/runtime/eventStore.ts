import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StoredAgentEvent } from '@/lib/code-space/domain';
import { createAgentEvent, encodeSseEvent, type AgentEvent, type AgentEventType } from './events';

type EventSubscriber = (event: StoredAgentEvent) => void;

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|cookie|private[_-]?key)/i;
const SECRET_VALUE_PATTERN = /(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})/i;

export interface EventStore {
  append<TPayload>(event: AgentEvent<TPayload>): Promise<StoredAgentEvent<TPayload>>;
  emit<TPayload>(input: {
    type: AgentEventType;
    projectId?: string;
    sessionId?: string;
    runId?: string;
    payload: TPayload;
  }): Promise<StoredAgentEvent<TPayload>>;
  list(runId: string): Promise<StoredAgentEvent[]>;
  subscribe(runId: string, subscriber: EventSubscriber): () => void;
  stream(runId: string, signal?: AbortSignal, lastEventId?: string): ReadableStream<Uint8Array>;
}

function storeRoot(): string {
  if (process.env.CODE_SPACE_EVENT_STORE_DIR) return process.env.CODE_SPACE_EVENT_STORE_DIR;
  return path.join(process.cwd(), '.codoptic-cache', 'events');
}

function redactSecrets(value: unknown, keyHint = ''): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY_PATTERN.test(keyHint) || SECRET_VALUE_PATTERN.test(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, keyHint));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(item, key),
      ]),
    );
  }
  return value;
}

async function readJsonl(filePath: string): Promise<StoredAgentEvent[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredAgentEvent)
      .sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export class JsonlEventStore implements EventStore {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly root = storeRoot()) {}

  async append<TPayload>(event: AgentEvent<TPayload>): Promise<StoredAgentEvent<TPayload>> {
    const runId = event.runId ?? 'global';
    await fs.mkdir(this.root, { recursive: true });
    const current = this.sequences.get(runId) ?? (await readJsonl(this.fileForRun(runId))).at(-1)?.sequence ?? 0;
    const stored: StoredAgentEvent<TPayload> = {
      ...event,
      payload: redactSecrets(event.payload) as TPayload,
      sequence: current + 1,
    };
    this.sequences.set(runId, stored.sequence);
    await fs.appendFile(this.fileForRun(runId), `${JSON.stringify(stored)}\n`, 'utf8');
    for (const subscriber of this.subscribers.get(runId) ?? []) subscriber(stored);
    return stored;
  }

  emit<TPayload>(input: {
    type: AgentEventType;
    projectId?: string;
    sessionId?: string;
    runId?: string;
    payload: TPayload;
  }): Promise<StoredAgentEvent<TPayload>> {
    return this.append(createAgentEvent(input));
  }

  list(runId: string): Promise<StoredAgentEvent[]> {
    return readJsonl(this.fileForRun(runId));
  }

  subscribe(runId: string, subscriber: EventSubscriber): () => void {
    const subscribers = this.subscribers.get(runId) ?? new Set<EventSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(runId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(runId);
    };
  }

  stream(runId: string, signal?: AbortSignal, lastEventId?: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start: async (controller) => {
        const send = (event: StoredAgentEvent) => {
          controller.enqueue(encoder.encode(encodeSseEvent(event, String(event.sequence))));
        };
        const lastSequence = lastEventId ? Number(lastEventId) : 0;
        for (const event of await this.list(runId)) {
          if (event.sequence > lastSequence) send(event);
        }
        const unsubscribe = this.subscribe(runId, send);
        const close = () => {
          unsubscribe();
          controller.close();
        };
        signal?.addEventListener('abort', close, { once: true });
      },
    });
  }

  private fileForRun(runId: string): string {
    return path.join(this.root, `${encodeURIComponent(runId)}.jsonl`);
  }
}

const globalStore = globalThis as typeof globalThis & { __codeSpaceEventStore?: JsonlEventStore };

export function getEventStore(): JsonlEventStore {
  globalStore.__codeSpaceEventStore ??= new JsonlEventStore();
  return globalStore.__codeSpaceEventStore;
}

export function redactEventPayloadForTest(value: unknown): unknown {
  return redactSecrets(value);
}

