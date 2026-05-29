import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';

export type AgentSSEEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'agent_reasoning_delta'; delta: string }
  | { type: 'structured_event'; event: import('@/lib/code-space/runtime').AgentEvent }
  | { type: 'plan_created'; items: string[] }
  | { type: 'plan_markdown_created'; filePath: string; content: string }
  | { type: 'clarifying_questions_created'; questions: CodeSpaceClarifyingQuestion[] }
  | { type: 'todo_created'; todo: { id: string; text: string; done: boolean } }
  | { type: 'todo_updated'; todoId: string; done: boolean }
  | { type: 'tool_start'; toolCallId: string; tool: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; tool: string; output: unknown; durationMs: number; error?: string }
  | { type: 'diff_proposed'; diffId: string; filePath: string; oldContent: string; newContent: string; deleted?: boolean; explanation?: string; unifiedDiff?: string; autoApplied?: boolean }
  | { type: 'file_applied'; filePath: string; beforeContent: string; afterContent: string; deleted?: boolean; explanation?: string; unifiedDiff?: string; hash: string }
  | { type: 'terminal_chunk'; chunk: string }
  | { type: 'validation_result'; id: string; command: string; status: 'passed' | 'failed' | 'skipped'; output: string }
  | { type: 'lint_errors'; filePath: string; errors: Array<{ file: string; line: number; col: number; severity: 'error' | 'warning'; message: string; rule?: string }> }
  | { type: 'integration_review'; findings: Array<{ path: string; kind: string; message: string }> }
  | { type: 'supervisor_verdict'; status: 'verified' | 'needs_review'; blockers: string[] }
  | { type: 'agent_done'; summary: string; filesChanged: string[] }
  | { type: 'agent_error'; message: string; recoverable: boolean }
  | { type: 'tool_budget_warning'; used: number; max: number };

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'system'; content: string }
  | { role: 'tool'; content: string };
