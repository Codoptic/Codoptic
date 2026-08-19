import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore, redactEventPayloadForTest } from '../eventStore';
import { createAgentEvent } from '../events';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('JsonlEventStore', () => {
  it('persists and replays run events in sequence order', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-code-space-events-'));
    const store = new JsonlEventStore(tmpDir);

    await store.append(createAgentEvent({ type: 'run.created', runId: 'run-1', payload: { index: 1 } }));
    await store.append(createAgentEvent({ type: 'run.started', runId: 'run-1', payload: { index: 2 } }));

    const events = await store.list('run-1');
    expect(events.map((event) => event.type)).toEqual(['run.created', 'run.started']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it('replays only events after Last-Event-ID', async () => {
    tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-code-space-events-'));
    const store = new JsonlEventStore(tmpDir);
    await store.append(createAgentEvent({ type: 'run.created', runId: 'run-2', payload: { index: 1 } }));
    await store.append(createAgentEvent({ type: 'run.started', runId: 'run-2', payload: { index: 2 } }));
    const stream = store.stream('run-2', undefined, '1');
    const reader = stream.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('id: 2');
    expect(text).not.toContain('"index":1');
    reader.releaseLock();
  });

  it('redacts secret-like payload keys and values before persistence', async () => {
    expect(
      redactEventPayloadForTest({
        apiKey: 'sk-test-secret-value',
        nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz' },
        safe: 'visible',
      }),
    ).toEqual({
      apiKey: '[REDACTED]',
      nested: { token: '[REDACTED]' },
      safe: 'visible',
    });
  });
});

