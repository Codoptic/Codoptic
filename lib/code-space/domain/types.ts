import { z } from 'zod';
import type { AgentEvent, AgentEventType } from '@/lib/code-space/runtime/events';
import type { ToolRiskLevel } from '@/lib/code-space/runtime/toolRegistry';
import type {
  CoworkingRun,
  PersistedContextLedgerEntry,
  PersistedWorkGraph,
  ScheduledWorkRecord,
  SubagentDeliverableRecord,
} from '@/lib/code-space/runtime/coworkingTypes';

export const AgentModeSchema = z.enum(['ask', 'plan', 'code', 'edit', 'debug', 'review', 'agent']);
export const AutonomyLevelSchema = z.enum([
  'suggest_only',
  'approval_required',
  'auto_safe_tools',
  'sandbox_autonomy',
  'full_access_local',
  'organization_policy',
]);
export const RunStatusSchema = z.enum(['queued', 'running', 'paused', 'cancelled', 'completed', 'failed', 'blocked']);
export const ApprovalStatusSchema = z.enum(['not_required', 'pending', 'approved', 'rejected', 'expired']);
export const PatchStatusSchema = z.enum(['proposed', 'validated', 'applied', 'rejected', 'failed', 'reverted']);
export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'blocked', 'done', 'skipped', 'failed']);

export type AgentMode = z.infer<typeof AgentModeSchema>;
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type PatchStatus = z.infer<typeof PatchStatusSchema>;
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  createdAt: number;
  updatedAt: number;
  settings: Record<string, unknown>;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  userId: string;
  mode: AgentMode;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  projectId: string;
  status: RunStatus;
  mode: AgentMode;
  autonomy: AutonomyLevel;
  model?: string;
  prompt: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface ToolCallRecord {
  id: string;
  runId: string;
  toolName: string;
  args: unknown;
  status: 'requested' | 'running' | 'completed' | 'failed' | 'cancelled';
  riskLevel: ToolRiskLevel;
  approvalStatus: ApprovalStatus;
  startedAt?: number;
  completedAt?: number;
  outputSummary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PatchRecord {
  id: string;
  runId: string;
  projectId: string;
  status: PatchStatus;
  filesChanged: string[];
  diff: string;
  explanation: string;
  createdAt: number;
  appliedAt?: number;
  rejectedAt?: number;
}

export interface CheckpointRecord {
  id: string;
  projectId: string;
  runId?: string;
  reason: string;
  snapshotRef: string;
  gitStatus?: unknown;
  createdAt: number;
}

export interface TodoRecord {
  id: string;
  runId: string;
  title: string;
  description: string;
  status: TodoStatus;
  owner: string;
  priority: 'low' | 'medium' | 'high';
  dependencies: string[];
  files: string[];
  validationMethod?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewCommentRecord {
  id: string;
  runId: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: 'blocker' | 'high' | 'medium' | 'low' | 'nit';
  issue: string;
  suggestedFix?: string;
  status: 'open' | 'resolved' | 'dismissed';
}

export interface MemoryRecord {
  id: string;
  scope: 'project' | 'user' | 'organization' | 'global';
  projectId?: string;
  key: string;
  value: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export type CoworkingRunRecord = CoworkingRun;
export type WorkGraphRecord = PersistedWorkGraph;
export type ContextLedgerRecord = PersistedContextLedgerEntry;
export type SubagentDeliverableRecordType = SubagentDeliverableRecord;
export type ScheduledWorkRecordType = ScheduledWorkRecord;

export interface StoredAgentEvent<TPayload = unknown> extends AgentEvent<TPayload> {
  sequence: number;
}

export interface CreateRunInput {
  sessionId: string;
  prompt: string;
  mode?: AgentMode;
  autonomy?: AutonomyLevel;
  model?: string;
}

export interface CreateSessionInput {
  projectId: string;
  userId?: string;
  mode?: AgentMode;
  title?: string;
}

export const StructuredEventEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string().transform((value) => value as AgentEventType),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  payload: z.unknown(),
  createdAt: z.number(),
  sequence: z.number().optional(),
});
