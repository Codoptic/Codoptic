import { getCodeSpaceStore, type JsonCodeSpaceStore } from './serverStore';
import type { ContextLedger } from './contextLedger';
import type { PersistedContextLedgerEntry } from './coworkingTypes';

export class ContextLedgerStore {
  constructor(private readonly store: JsonCodeSpaceStore = getCodeSpaceStore()) {}

  async appendMany(entries: PersistedContextLedgerEntry[]): Promise<void> {
    if (!entries.length) return;
    await this.store.update((data) => {
      const existing = new Map(data.contextLedgerEntries.map((entry) => [entry.id, entry]));
      for (const entry of entries) existing.set(entry.id, entry);
      data.contextLedgerEntries = Array.from(existing.values()).sort((a, b) => a.createdAt - b.createdAt);
    });
  }

  async persistLedger(runId: string, ledger: ContextLedger): Promise<void> {
    await this.appendMany(ledger.list().map((entry) => ({ ...entry, runId })));
  }

  async list(runId: string): Promise<PersistedContextLedgerEntry[]> {
    const data = await this.store.read();
    return data.contextLedgerEntries.filter((entry) => entry.runId === runId).sort((a, b) => a.createdAt - b.createdAt);
  }
}
