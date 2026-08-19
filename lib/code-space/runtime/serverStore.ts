import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CheckpointRecord,
  ContextLedgerRecord,
  CoworkingRunRecord,
  MemoryRecord,
  MessageRecord,
  PatchRecord,
  ProjectRecord,
  ReviewCommentRecord,
  RunRecord,
  ScheduledWorkRecordType,
  SessionRecord,
  SubagentDeliverableRecordType,
  TodoRecord,
  ToolCallRecord,
  WorkGraphRecord,
} from '@/lib/code-space/domain';

export interface CodeSpaceServerData {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  runs: RunRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  patches: PatchRecord[];
  checkpoints: CheckpointRecord[];
  todos: TodoRecord[];
  reviewComments: ReviewCommentRecord[];
  memories: MemoryRecord[];
  coworkingRuns: CoworkingRunRecord[];
  workGraphs: WorkGraphRecord[];
  contextLedgerEntries: ContextLedgerRecord[];
  subagentDeliverables: SubagentDeliverableRecordType[];
  scheduledWork: ScheduledWorkRecordType[];
}

const EMPTY_DATA: CodeSpaceServerData = {
  projects: [],
  sessions: [],
  runs: [],
  messages: [],
  toolCalls: [],
  patches: [],
  checkpoints: [],
  todos: [],
  reviewComments: [],
  memories: [],
  coworkingRuns: [],
  workGraphs: [],
  contextLedgerEntries: [],
  subagentDeliverables: [],
  scheduledWork: [],
};

function dataPath(): string {
  if (process.env.CODE_SPACE_SERVER_STORE_PATH) return process.env.CODE_SPACE_SERVER_STORE_PATH;
  const cwd = process.cwd();
  return path.join(cwd, '.codoptic-cache', 'server-store.json');
}

export class JsonCodeSpaceStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath = dataPath()) {}

  async read(): Promise<CodeSpaceServerData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return { ...EMPTY_DATA, ...(JSON.parse(raw) as Partial<CodeSpaceServerData>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_DATA };
      throw error;
    }
  }

  async update(mutator: (data: CodeSpaceServerData) => void): Promise<CodeSpaceServerData> {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.read();
      mutator(data);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    });
    await this.writeQueue;
    return this.read();
  }

  async upsert<K extends keyof CodeSpaceServerData>(collection: K, item: CodeSpaceServerData[K][number] & { id: string }): Promise<void> {
    await this.update((data) => {
      const list = data[collection] as Array<typeof item>;
      const index = list.findIndex((entry) => entry.id === item.id);
      if (index >= 0) list[index] = item;
      else list.push(item);
    });
  }
}

const globalStore = globalThis as typeof globalThis & { __codeSpaceServerStore?: JsonCodeSpaceStore };

export function getCodeSpaceStore(): JsonCodeSpaceStore {
  globalStore.__codeSpaceServerStore ??= new JsonCodeSpaceStore();
  return globalStore.__codeSpaceServerStore;
}
