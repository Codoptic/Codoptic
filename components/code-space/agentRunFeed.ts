import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { AgentRunFeedEntry, PatchHistoryEntry } from '@/lib/code-space/core';

const MAX_FEED_ENTRIES = 220;

export function appendRunFeedEvent(feed: AgentRunFeedEntry[] = [], event: AgentSSEEvent, now = Date.now()): AgentRunFeedEntry[] {
  const entry = runFeedEntryFromEvent(event, now);
  if (!entry) return feed;
  const existingIndex = feed.findIndex((item) => item.id === entry.id);
  const next = existingIndex >= 0
    ? feed.map((item, index) => (index === existingIndex ? { ...item, ...entry, updatedAt: now } : item))
    : [...feed, entry];
  return next.slice(Math.max(0, next.length - MAX_FEED_ENTRIES));
}

export function appendPatchHistory(history: PatchHistoryEntry[] = [], event: AgentSSEEvent): PatchHistoryEntry[] {
  if (event.type !== 'patch_history') return history;
  const existingIndex = history.findIndex((item) => item.patchId === event.patch.patchId);
  if (existingIndex >= 0) return history.map((item, index) => (index === existingIndex ? { ...item, ...event.patch } : item));
  return [...history, event.patch];
}

export function runFeedEntryFromEvent(event: AgentSSEEvent, now = Date.now()): AgentRunFeedEntry | null {
  if (event.type === 'agent_status') {
    return {
      id: event.status.id,
      kind: 'progress',
      title: event.status.title,
      detail: event.status.detail,
      status: event.status.status,
      createdAt: event.status.createdAt,
    };
  }
  if (event.type === 'run_feed_entry') return event.entry;
  if (event.type === 'tool_start') {
    return {
      id: `feed:tool:${event.toolCallId}`,
      kind: 'tool',
      title: describeTool(event.tool, event.input),
      detail: previewInput(event.input),
      status: 'running',
      createdAt: now,
    };
  }
  if (event.type === 'tool_result') {
    if (event.recoverable) {
      return {
        id: `feed:tool:${event.toolCallId}`,
        kind: 'progress',
        title: 'Replanning automatically',
        detail: describeTool(event.tool, undefined),
        status: 'warning',
        createdAt: now,
      };
    }
    return {
      id: `feed:tool:${event.toolCallId}`,
      kind: 'tool',
      title: event.error ? `${event.tool} failed` : `${event.tool} completed`,
      detail: event.error ?? `Completed in ${event.durationMs}ms`,
      status: event.error ? 'error' : 'success',
      createdAt: now,
    };
  }
  if (event.type === 'patch_history') {
    return {
      id: `feed:patch:${event.patch.patchId}`,
      kind: 'patch',
      title: `${event.patch.mode === 'proposed' ? 'Proposed' : 'Updated'} ${basename(event.patch.filePath)}`,
      detail: event.patch.explanation,
      status: event.patch.status === 'failed' ? 'error' : event.patch.status === 'pending' ? 'pending' : 'success',
      filePath: event.patch.filePath,
      added: event.patch.added,
      removed: event.patch.removed,
      hunks: event.patch.hunks,
      diff: event.patch.diff,
      createdAt: event.patch.createdAt,
    };
  }
  if (event.type === 'terminal_chunk') {
    return {
      id: `feed:terminal:${now}:${Math.random().toString(36).slice(2, 7)}`,
      kind: 'terminal',
      title: event.command ? `Terminal: ${event.command}` : 'Terminal output',
      detail: event.chunk.trim().slice(0, 240),
      status: 'running',
      command: event.command,
      createdAt: now,
    };
  }
  if (event.type === 'validation_result') {
    return {
      id: `feed:validation:${event.id}`,
      kind: 'validation',
      title: `${event.status}: ${event.command}`,
      detail: event.output,
      status: event.status === 'passed' ? 'success' : event.status === 'failed' ? 'error' : 'warning',
      command: event.command,
      createdAt: now,
    };
  }
  if (event.type === 'integration_review') {
    return {
      id: `feed:integration:${now}`,
      kind: 'review',
      title: event.findings.length ? `Integration review found ${event.findings.length} issue(s)` : 'Integration review passed',
      status: event.findings.length ? 'warning' : 'success',
      createdAt: now,
    };
  }
  if (event.type === 'supervisor_verdict') {
    return {
      id: `feed:supervisor:${now}`,
      kind: 'review',
      title: event.status === 'verified' ? 'Supervisor verified the run' : 'Supervisor needs review',
      detail: event.blockers.join(' '),
      status: event.status === 'verified' ? 'success' : 'warning',
      createdAt: now,
    };
  }
  if (event.type === 'tool_budget_warning') {
    return {
      id: `feed:budget:${now}`,
      kind: 'progress',
      title: `Approaching tool budget (${event.used}/${event.max})`,
      status: 'warning',
      createdAt: now,
    };
  }
  if (event.type === 'agent_error') {
    return {
      id: `feed:error:${now}`,
      kind: 'error',
      title: event.message,
      status: 'error',
      createdAt: now,
    };
  }
  if (event.type === 'agent_done') {
    return {
      id: `feed:done:${now}`,
      kind: 'done',
      title: 'Run completed',
      detail: event.summary,
      status: 'success',
      createdAt: now,
    };
  }
  return null;
}

function describeTool(tool: string, input: unknown): string {
  if (tool === 'read_file' && input && typeof input === 'object' && typeof (input as { path?: unknown }).path === 'string') {
    return `Reading ${basename((input as { path: string }).path)}`;
  }
  if (tool === 'search_text') return 'Searching repository';
  if (tool === 'edit_file') return 'Preparing code patch';
  if (tool === 'run_command') return 'Running terminal command';
  return tool.replace(/_/g, ' ');
}

function previewInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  try {
    const text = JSON.stringify(input);
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  } catch {
    return String(input);
  }
}

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}
