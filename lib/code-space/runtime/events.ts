export type AgentEventType =
  | 'session.created'
  | 'session.updated'
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.cancelled'
  | 'run.completed'
  | 'run.failed'
  | 'message.user.created'
  | 'message.assistant.delta'
  | 'message.assistant.completed'
  | 'plan.created'
  | 'plan.updated'
  | 'todo.created'
  | 'todo.updated'
  | 'todo.completed'
  | 'context.search.started'
  | 'context.search.completed'
  | 'context.sufficiency.completed'
  | 'context.file.selected'
  | 'context.file.dropped'
  | 'tool.requested'
  | 'tool.approval.required'
  | 'tool.approved'
  | 'tool.rejected'
  | 'tool.started'
  | 'tool.stdout'
  | 'tool.stderr'
  | 'tool.completed'
  | 'tool.failed'
  | 'patch.proposed'
  | 'patch.validated'
  | 'patch.applied'
  | 'patch.rejected'
  | 'patch.failed'
  | 'file.read'
  | 'file.created'
  | 'file.updated'
  | 'file.deleted'
  | 'file.reverted'
  | 'file.revert.failed'
  | 'git.status.updated'
  | 'git.diff.updated'
  | 'checkpoint.created'
  | 'checkpoint.restored'
  | 'validation.started'
  | 'validation.completed'
  | 'validation.failed'
  | 'terminal.started'
  | 'terminal.output'
  | 'terminal.exited'
  | 'browser.preview.started'
  | 'browser.console.message'
  | 'browser.network.error'
  | 'browser.screenshot.created'
  | 'review.started'
  | 'review.comment.created'
  | 'review.completed'
  | 'subagent.plan.created'
  | 'subagent.started'
  | 'subagent.message'
  | 'subagent.completed'
  | 'subagent.reconciled'
  | 'integration.reviewed'
  | 'supervisor.verdict'
  | 'knowledge_graph.building'
  | 'knowledge_graph.ready'
  | 'knowledge_graph.failed'
  | 'memory.loaded'
  | 'memory.read'
  | 'memory.update.proposed'
  | 'artifact.created'
  | 'coworking.run.created'
  | 'coworking.phase.changed'
  | 'coworking.workgraph.persisted'
  | 'coworking.ledger.persisted'
  | 'coworking.hook.completed'
  | 'coworking.deliverable.recorded';

export interface AgentEvent<TPayload = unknown> {
  id: string;
  type: AgentEventType;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  payload: TPayload;
  createdAt: number;
}

export function createAgentEvent<TPayload>({
  type,
  projectId,
  sessionId,
  runId,
  payload,
  createdAt = Date.now(),
}: {
  type: AgentEventType;
  projectId?: string;
  sessionId?: string;
  runId?: string;
  payload: TPayload;
  createdAt?: number;
}): AgentEvent<TPayload> {
  return {
    id: `event:${createdAt}:${Math.random().toString(36).slice(2, 10)}`,
    type,
    projectId,
    sessionId,
    runId,
    payload,
    createdAt,
  };
}

export function encodeSseEvent(event: AgentEvent | Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
