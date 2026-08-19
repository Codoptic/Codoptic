import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { AgentSSEEvent } from '@/lib/code-space/agent/types';
import type { CodeSpaceClarifyingQuestion } from '@/lib/code-space/core';
import { AgentRuntime, AgentRuntimeRequestSchema } from '@/lib/code-space/runtime/agentRuntime';
import { ContextGraphEngine, type ContextGraphResult } from '@/lib/code-space/runtime/contextGraphEngine';
import { PlanningEngine } from '@/lib/code-space/runtime/planningEngine';
import type { CodeSpaceAgentMode } from '@/lib/code-space/agentModes';
import { encodeSseEvent } from '@/lib/code-space/runtime/events';
import { guardPath } from '@/lib/security/pathGuard';
import { buildPlanImplementationPrompt, extractBuildPlanPath } from '@/lib/code-space/planBuild';

export { buildPlanImplementationPrompt, extractBuildPlanPath };

export const runtime = 'nodejs';

const BodySchema = AgentRuntimeRequestSchema.extend({
  enableThinking: z.boolean().optional(),
  localTemperature: z.number().min(0).max(2).optional(),
  localContextLength: z.number().int().positive().optional(),
});

export type ContextSearchResult = ContextGraphResult;

export async function collectProjectContext(
  root: string,
  prompt: string,
  openTabs: string[],
  attachments: Array<{ kind: 'file' | 'folder'; relativePath: string; displayName?: string }> = [],
): Promise<ContextGraphResult> {
  return new ContextGraphEngine().collectProjectContext(root, prompt, { openTabs, attachments });
}

export async function buildPlan(
  mode: CodeSpaceAgentMode,
  _intents: string[],
  prompt: string,
  context?: ContextGraphResult,
  ..._rest: unknown[]
): Promise<string[]> {
  if (!context?.files.length) return [];
  return new PlanningEngine().buildOutline(mode === 'ask' || mode === 'plan' || mode === 'code' ? mode : 'code', prompt, context).planItems;
}

export async function buildClarifyingQuestions(..._args: unknown[]): Promise<CodeSpaceClarifyingQuestion[]> {
  return [];
}

export function buildStrategyDocument({
  projectName,
  prompt,
  context,
  validation,
}: {
  projectName: string;
  prompt: string;
  context: ContextGraphResult;
  validation: { commands: Array<{ command: string; reason: string; kind?: string }>; packageManager?: string | null };
  codeMode?: boolean;
  answers?: unknown[];
  workflowOutline?: unknown;
}): string {
  return new PlanningEngine().buildPlanArtifact({
    projectName,
    prompt,
    context,
    validationCommands: validation.commands.map((command) => ({
      kind: 'test',
      command: command.command.split(' ')[0] ?? command.command,
      args: command.command.split(' ').slice(1),
      reason: command.reason,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.message }, { status: 400 });

  const guarded = guardPath(body.data.projectRoot);
  if (!guarded.ok) return Response.json({ error: guarded.reason ?? 'Invalid project path' }, { status: 400 });

  const encoder = new TextEncoder();
  const agentRuntime = new AgentRuntime();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminalEventSeen = false;
      const send = (event: AgentSSEEvent) => {
        if (event.type === 'agent_done' || event.type === 'agent_error') {
          terminalEventSeen = true;
        } else if (event.type === 'structured_event' && event.event.type === 'run.completed') {
          terminalEventSeen = true;
        }
        const sequence = event.type === 'structured_event' && typeof event.event.sequence === 'number' ? String(event.event.sequence) : undefined;
        controller.enqueue(encoder.encode(encodeSseEvent(event, sequence)));
      };
      try {
        await agentRuntime.run(
          { ...body.data, projectRoot: guarded.resolved },
          send,
          req.signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!terminalEventSeen) {
          terminalEventSeen = true;
          controller.enqueue(encoder.encode(encodeSseEvent({ type: 'agent_error', message, recoverable: true })));
        }
      } finally {
        if (!terminalEventSeen) {
          controller.enqueue(
            encoder.encode(
              encodeSseEvent({
                type: 'agent_error',
                message: 'The agent stream ended without a terminal completion event.',
                recoverable: true,
              }),
            ),
          );
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
