import type { AgentRunFeedEntry, CodeSpaceAgentSession } from '@/lib/code-space/core';
import type { CodeSpacePendingDiff } from './diffHunks';
import { countDiffLines } from './diffHunks';

export type AgentTimelineItem =
  | { id: string; kind: 'user_prompt'; content: string; messageId: string; createdAt: number }
  | { id: string; kind: 'assistant_text'; content: string; createdAt: number }
  | { id: string; kind: 'status_summary'; text: string; status?: AgentRunFeedEntry['status']; createdAt: number }
  | {
      id: string;
      kind: 'exploration_summary';
      text: string;
      filePaths: string[];
      searches: Array<{ query: string; glob?: string }>;
      createdAt: number;
    }
  | {
      id: string;
      kind: 'patch_card';
      diffId: string;
      filePath: string;
      title: string;
      added: number;
      removed: number;
      hunks: number;
      diff: string;
      status: 'pending' | 'applied' | 'failed' | 'rejected';
      explanation?: string;
      createdAt: number;
    }
  | { id: string; kind: 'file_group'; count: number; files: string[]; createdAt: number }
  | { id: string; kind: 'review_gate'; count: number; createdAt: number }
  | { id: string; kind: 'validation_summary'; command: string; status: 'passed' | 'failed' | 'skipped'; output?: string; createdAt: number }
  | { id: string; kind: 'error'; text: string; createdAt: number };

export interface BuildAgentTimelineInput {
  session: CodeSpaceAgentSession | null;
  pendingDiffs: CodeSpacePendingDiff[];
  appliedDiffs: Array<{
    filePath: string;
    beforeContent: string;
    afterContent: string;
    deleted?: boolean;
    acceptedAt: number;
  }>;
}

const MAX_INLINE_PATCH_CARDS = 4;

export function buildAgentTimeline({ session, pendingDiffs, appliedDiffs }: BuildAgentTimelineInput): AgentTimelineItem[] {
  if (!session) return [];
  const items: AgentTimelineItem[] = [];

  for (const message of session.messages) {
    if (message.role === 'tool' || message.role === 'system') continue;
    if (message.role === 'user') {
      items.push({ id: `message:${message.id}`, kind: 'user_prompt', content: message.content, messageId: message.id, createdAt: message.createdAt });
      continue;
    }
    items.push({ id: `message:${message.id}`, kind: 'assistant_text', content: message.content, createdAt: message.createdAt });
  }

  const exploration = summarizeExploration(session);
  if (exploration) items.push(exploration);

  let previousProgressTitle = '';
  for (const entry of session.runFeed ?? []) {
    if (entry.kind === 'progress' && entry.title && !isNoisyProgress(entry.title)) {
      const normalizedTitle = entry.title.trim().toLowerCase();
      if (normalizedTitle === previousProgressTitle) continue;
      previousProgressTitle = normalizedTitle;
      items.push({ id: `feed:${entry.id}`, kind: 'assistant_text', content: entry.title, createdAt: entry.createdAt });
    } else if (entry.kind === 'review' && entry.status && entry.status !== 'success') {
      items.push({ id: `feed:${entry.id}`, kind: 'status_summary', text: entry.detail ? `${entry.title}: ${entry.detail}` : entry.title, status: entry.status, createdAt: entry.createdAt });
    }
  }

  const patchItems = buildPatchItems(session, pendingDiffs, appliedDiffs);
  const inlinePatchItems = patchItems.slice(0, MAX_INLINE_PATCH_CARDS);
  items.push(...inlinePatchItems);
  if (patchItems.length > inlinePatchItems.length) {
    const hidden = patchItems.slice(inlinePatchItems.length);
    items.push({
      id: `patch-group:${session.id}:${hidden.length}`,
      kind: 'file_group',
      count: hidden.length,
      files: hidden.map((item) => item.filePath),
      createdAt: Math.max(...hidden.map((item) => item.createdAt)),
    });
  }

  if (pendingDiffs.length > 0) {
    items.push({
      id: `review-gate:${session.id}:${pendingDiffs.length}`,
      kind: 'review_gate',
      count: pendingDiffs.length,
      createdAt: session.updatedAt + 2,
    });
  }

  for (const result of session.verificationResults) {
    if (result.status === 'passed' && !result.output.trim()) continue;
    items.push({
      id: `validation:${result.id}`,
      kind: 'validation_summary',
      command: result.command,
      status: result.status,
      output: result.output,
      createdAt: session.updatedAt + 3,
    });
  }

  return items.sort((a, b) => a.createdAt - b.createdAt || orderRank(a.kind) - orderRank(b.kind));
}

function summarizeExploration(session: CodeSpaceAgentSession): AgentTimelineItem | null {
  const readFileSet = new Set<string>();
  const filePaths: string[] = [];
  const searches: Array<{ query: string; glob?: string }> = [];
  let latest = 0;
  for (const call of session.toolCalls) {
    if (call.name === 'read_file' && call.input && typeof call.input === 'object') {
      const path = (call.input as { path?: unknown }).path;
      if (typeof path === 'string' && path.trim() && !readFileSet.has(path.trim())) {
        readFileSet.add(path.trim());
        filePaths.push(path.trim());
      }
    }
    if (call.name === 'search_text') {
      const input = call.input && typeof call.input === 'object' ? call.input as { query?: unknown; glob?: unknown } : null;
      const query = typeof input?.query === 'string' && input.query.trim() ? input.query.trim() : 'Search query unavailable';
      const glob = typeof input?.glob === 'string' && input.glob.trim() ? input.glob.trim() : undefined;
      searches.push(glob ? { query, glob } : { query });
    }
    if (call.name === 'read_file' || call.name === 'search_text') latest = Math.max(latest, call.updatedAt ?? call.createdAt);
  }
  if (!filePaths.length && !searches.length) return null;
  const filesLabel = `${filePaths.length} file${filePaths.length === 1 ? '' : 's'}`;
  const searchLabel = `${searches.length} search${searches.length === 1 ? '' : 'es'}`;
  return {
    id: `exploration:${session.id}:${filePaths.length}:${searches.length}`,
    kind: 'exploration_summary',
    text: `Explored ${filesLabel}, ${searchLabel}`,
    filePaths,
    searches,
    createdAt: latest || session.updatedAt,
  };
}

function buildPatchItems(
  session: CodeSpaceAgentSession,
  pendingDiffs: CodeSpacePendingDiff[],
  appliedDiffs: BuildAgentTimelineInput['appliedDiffs'],
): Extract<AgentTimelineItem, { kind: 'patch_card' }>[] {
  const items = new Map<string, Extract<AgentTimelineItem, { kind: 'patch_card' }>>();
  for (const patch of session.patchHistory ?? []) {
    items.set(`history:${patch.patchId}`, {
      id: `patch:${patch.patchId}`,
      kind: 'patch_card',
      diffId: patch.patchId,
      filePath: patch.filePath,
      title: basename(patch.filePath),
      added: patch.added,
      removed: patch.removed,
      hunks: patch.hunks,
      diff: patch.diff,
      status: patch.status,
      explanation: patch.explanation,
      createdAt: patch.createdAt,
    });
  }
  for (const diff of pendingDiffs) {
    const counts = countDiffLines(diff.unifiedDiff, diff.hunks);
    items.set(`pending:${diff.diffId}`, {
      id: `pending:${diff.diffId}`,
      kind: 'patch_card',
      diffId: diff.diffId,
      filePath: diff.filePath,
      title: basename(diff.filePath),
      added: counts.added,
      removed: counts.removed,
      hunks: diff.hunks?.length || 1,
      diff: diff.unifiedDiff ?? `${diff.oldContent}\n---\n${diff.newContent}`,
      status: 'pending',
      explanation: diff.explanation,
      createdAt: session.updatedAt + 1,
    });
  }
  for (const diff of appliedDiffs) {
    const fallbackDiff = `${diff.beforeContent}\n---\n${diff.afterContent}`;
    items.set(`applied:${diff.acceptedAt}:${diff.filePath}`, {
      id: `applied:${diff.acceptedAt}:${diff.filePath}`,
      kind: 'patch_card',
      diffId: `applied:${diff.acceptedAt}:${diff.filePath}`,
      filePath: diff.filePath,
      title: basename(diff.filePath),
      added: diff.afterContent === diff.beforeContent ? 0 : 1,
      removed: diff.beforeContent && diff.afterContent !== diff.beforeContent ? 1 : 0,
      hunks: 1,
      diff: fallbackDiff,
      status: 'applied',
      explanation: 'Applied change',
      createdAt: diff.acceptedAt,
    });
  }
  return Array.from(items.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function basename(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

function orderRank(kind: AgentTimelineItem['kind']): number {
  switch (kind) {
    case 'user_prompt':
      return 0;
    case 'assistant_text':
      return 1;
    case 'status_summary':
    case 'exploration_summary':
      return 2;
    case 'patch_card':
      return 3;
    case 'file_group':
      return 4;
    case 'review_gate':
      return 5;
    case 'validation_summary':
      return 6;
    case 'error':
      return 7;
  }
}

function isNoisyProgress(title: string): boolean {
  return /^(waiting for model turn|streaming unavailable|tracking implementation contract)[.!…]*$/i.test(title.trim());
}
