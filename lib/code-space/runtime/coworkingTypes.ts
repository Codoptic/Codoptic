import type { AutonomyLevel } from '@/lib/code-space/domain';
import type { ContextLedgerEntry } from './contextLedger';
import type { WorkGraph, WorkPackage } from './agentOrchestrator';
import type { RuntimeScaleProfile } from './scaleProfile';
import type { SubagentRole } from './subagentRunner';

export type CoworkingPhase =
  | 'intake'
  | 'plan_review'
  | 'workgraph_ready'
  | 'executing'
  | 'validating'
  | 'syncing'
  | 'blocked'
  | 'complete';

export type CoworkingSyncMode = 'quiet_autonomous' | 'ask_before_risky_decisions' | 'frequent_coworking_updates';
export type WorkPackageStatus = 'queued' | 'ready' | 'running' | 'sleeping' | 'blocked' | 'retryable' | 'reviewing' | 'done' | 'cancelled';
export type SubagentDeliverableStatus = 'done' | 'blocked' | 'retryable' | 'needs_review';

export interface PackageOwnership {
  ownerRole: SubagentRole;
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiresReview: boolean;
  reviewerRole?: SubagentRole;
}

export interface GovernedWorkPackage extends WorkPackage {
  status: WorkPackageStatus;
  goal: string;
  acceptanceCriteria: string[];
  validation: string[];
  risk: 'low' | 'medium' | 'high';
  expectedArtifacts: string[];
  blockerCriteria: string[];
  ownership: PackageOwnership;
  updatedAt: number;
}

export interface SubagentDeliverable {
  packageId: string;
  role: SubagentRole;
  status: SubagentDeliverableStatus;
  changedFiles: string[];
  evidence: Array<{ kind: 'file' | 'validation' | 'browser' | 'terminal' | 'review' | 'artifact'; summary: string; ref?: string }>;
  blockers: string[];
  handoffNotes: string;
  validationRequested: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface RolePolicy {
  role: SubagentRole;
  allowedTools: string[];
  forbiddenTools: string[];
  expectedOutputs: Array<keyof SubagentDeliverable>;
  maxAutonomy: AutonomyLevel;
  escalationTriggers: string[];
  requiresEvidence: boolean;
}

export interface CoworkingRun {
  id: string;
  runId: string;
  sessionId: string;
  projectId: string;
  projectRoot: string;
  prompt: string;
  phase: CoworkingPhase;
  scaleProfile: RuntimeScaleProfile;
  syncMode: CoworkingSyncMode;
  workGraphId?: string;
  latestPlanSummary: string;
  openBlockers: string[];
  nextSyncAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedWorkGraph {
  id: string;
  runId: string;
  graph: WorkGraph;
  packages: GovernedWorkPackage[];
  createdAt: number;
  updatedAt: number;
}

export interface PersistedContextLedgerEntry extends ContextLedgerEntry {
  runId: string;
}

export interface SubagentDeliverableRecord extends SubagentDeliverable {
  id: string;
  runId: string;
  createdAt: number;
}

export interface ScheduledWorkRecord {
  id: string;
  runId: string;
  packageId: string;
  status: 'queued' | 'running' | 'sleeping' | 'completed' | 'failed';
  runAfter?: number;
  heartbeatAt?: number;
  attempts: number;
  reason: string;
  updatedAt: number;
}
