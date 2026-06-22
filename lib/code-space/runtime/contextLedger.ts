import type { AgentArtifact } from '@/lib/code-space/agent/artifacts';
import type { RuntimeScaleProfile } from './scaleProfile';

export type ContextLedgerEntryKind =
  | 'repo_map'
  | 'knowledge_graph'
  | 'file_read'
  | 'decision'
  | 'validation'
  | 'browser'
  | 'terminal'
  | 'subagent'
  | 'repair'
  | 'summary';

export interface ContextLedgerEntry {
  id: string;
  kind: ContextLedgerEntryKind;
  summary: string;
  path?: string;
  command?: string;
  artifactId?: string;
  status?: 'pending' | 'passed' | 'failed' | 'skipped' | 'completed';
  createdAt: number;
}

export interface RunContinuation {
  runId: string;
  reason: string;
  profile: RuntimeScaleProfile;
  nextWorkPackageIds: string[];
  createdAt: number;
}

export class ContextLedger {
  private readonly entries: ContextLedgerEntry[] = [];
  continuation?: RunContinuation;

  constructor(readonly runId: string, readonly profile: RuntimeScaleProfile) {}

  add(entry: Omit<ContextLedgerEntry, 'id' | 'createdAt'> & Partial<Pick<ContextLedgerEntry, 'id' | 'createdAt'>>): ContextLedgerEntry {
    const complete: ContextLedgerEntry = {
      id: entry.id ?? `ledger:${this.runId}:${this.entries.length + 1}`,
      createdAt: entry.createdAt ?? Date.now(),
      kind: entry.kind,
      summary: entry.summary,
      path: entry.path,
      command: entry.command,
      artifactId: entry.artifactId,
      status: entry.status,
    };
    this.entries.push(complete);
    return complete;
  }

  addArtifact(kind: ContextLedgerEntryKind, artifact: AgentArtifact, summary = artifact.summary): ContextLedgerEntry {
    return this.add({ kind, summary, artifactId: artifact.artifactId, path: artifact.path, status: 'completed' });
  }

  list(kind?: ContextLedgerEntryKind): ContextLedgerEntry[] {
    return kind ? this.entries.filter((entry) => entry.kind === kind) : [...this.entries];
  }

  summarize(limit = 12): string {
    const items = this.entries.slice(-limit);
    if (!items.length) return 'Context ledger: empty.';
    return [
      `Context ledger (${items.length}/${this.entries.length} recent entries, profile=${this.profile}):`,
      ...items.map((entry) => {
        const ref = entry.artifactId ? ` artifact=${entry.artifactId}` : entry.path ? ` path=${entry.path}` : entry.command ? ` command=${entry.command}` : '';
        return `- ${entry.kind}${entry.status ? `/${entry.status}` : ''}:${ref} ${entry.summary}`;
      }),
    ].join('\n');
  }

  markContinuation(reason: string, nextWorkPackageIds: string[]): RunContinuation {
    this.continuation = {
      runId: this.runId,
      reason,
      profile: this.profile,
      nextWorkPackageIds,
      createdAt: Date.now(),
    };
    this.add({ kind: 'summary', summary: `Run continuation requested: ${reason}`, status: 'pending' });
    return this.continuation;
  }
}
