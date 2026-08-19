/**
 * Shared helpers for OpenAI-shaped native tool-calling.
 *
 * OpenAI, Grok, Foundry (Azure OpenAI), and local OpenAI-compatible servers all
 * speak the same `tools` / `tool_calls` / `role:'tool'` wire format. This module
 * builds request payloads from our neutral ChatMessage[] and normalizes responses
 * into an AssistantTurn so each provider's chatWithTools stays a thin adapter.
 */
import type { AssistantTurn, ChatMessage, ToolCall, ToolSpec, ToolStopReason } from './types';

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessageOut {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function safeParseJson(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapFinishReason(reason: string | undefined): ToolStopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** Convert OpenAI-style tool specs. */
export function buildOpenAIToolSpecs(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * Expand our neutral ChatMessage[] into OpenAI wire messages. A single `tool`
 * ChatMessage may carry several tool results; OpenAI requires one message per
 * result, so we fan those out here.
 */
export function buildOpenAIToolMessages(messages: ChatMessage[]): OpenAIMessageOut[] {
  const out: OpenAIMessageOut[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const results = message.toolResults ?? [];
      for (const result of results) {
        out.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.isError ? `ERROR: ${result.content}` : result.content,
        });
      }
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

interface OpenAIChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Normalize an OpenAI-shaped chat completion into an AssistantTurn. */
export function parseOpenAIToolResponse(json: OpenAIChatResponse): AssistantTurn {
  const choice = json.choices?.[0];
  const message = choice?.message;
  const text = (message?.content ?? '').trim();
  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .filter((call) => call.function?.name)
    .map((call, index) => ({
      id: call.id || `${call.function?.name ?? 'tool'}#${index}`,
      name: call.function?.name ?? 'unknown',
      input: safeParseJson(call.function?.arguments),
    }));

  let stopReason = mapFinishReason(choice?.finish_reason);
  // A finish_reason of tool_calls with no parsed calls degrades to end_turn so the loop can settle.
  if (stopReason === 'tool_use' && toolCalls.length === 0) stopReason = 'end_turn';
  return {
    text,
    toolCalls,
    stopReason,
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    },
  };
}
