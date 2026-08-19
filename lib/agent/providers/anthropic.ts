import Anthropic from '@anthropic-ai/sdk';
import type {
  AssistantTurn,
  ChatMessage,
  ChatParams,
  ChatWithToolsParams,
  ChatWithToolsStreamEvent,
  Provider,
  ProviderConfig,
  ToolCall,
  ToolStopReason,
  ValidationResult,
} from './types';
import { resolveMaxTokens } from './maxTokens';

export class AnthropicProvider implements Provider {
  id = 'anthropic' as const;
  private client: Anthropic;

  constructor(cfg: ProviderConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.endpoint });
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      await this.client.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    const sys = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const others = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      // Root Cause vs Logic: Anthropic requires max_tokens even for JSON/tool calls, while sampling overrides can still be model-specific. Keep the required output cap explicit and the rest minimal.
      model: params.model,
      max_tokens: 4096,
      messages: others,
      ...(sys ? { system: sys } : {}),
    };
    if (params.jsonSchema) {
      body.tools = [
        { name: 'emit', description: 'emit structured output', input_schema: params.jsonSchema },
      ];
      body.tool_choice = { type: 'tool', name: 'emit' };
    }
    const res = await this.client.messages.create(body, { signal: params.signal });
    if (params.jsonSchema) {
      const toolUse = res.content.find((c) => c.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') {
        return JSON.stringify(toolUse.input);
      }
    }
    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return text;
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<AssistantTurn> {
    const sys = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = toAnthropicMessages(params.messages.filter((m) => m.role !== 'system'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      model: params.model,
      max_tokens: resolveMaxTokens({ provider: 'anthropic', requested: params.maxTokens }),
      messages,
      ...(sys ? { system: sys } : {}),
    };
    if (params.tools.length) {
      body.tools = params.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      if (params.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (params.toolChoice === 'none') body.tool_choice = { type: 'none' };
      else body.tool_choice = { type: 'auto' };
    }
    const res = await this.client.messages.create(body, { signal: params.signal });

    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const toolCalls: ToolCall[] = res.content
      .filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use')
      .map((c) => ({ id: c.id, name: c.name, input: (c.input ?? {}) as Record<string, unknown> }));

    let stopReason = mapAnthropicStop(res.stop_reason);
    if (stopReason === 'tool_use' && toolCalls.length === 0) stopReason = 'end_turn';
    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        promptTokens: res.usage?.input_tokens,
        completionTokens: res.usage?.output_tokens,
        totalTokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
      },
    };
  }

  async *chatWithToolsStream(params: ChatWithToolsParams): AsyncIterable<ChatWithToolsStreamEvent> {
    const sys = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = toAnthropicMessages(params.messages.filter((m) => m.role !== 'system'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      model: params.model,
      max_tokens: resolveMaxTokens({ provider: 'anthropic', requested: params.maxTokens }),
      messages,
      ...(sys ? { system: sys } : {}),
    };
    if (params.tools.length) {
      body.tools = params.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      if (params.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (params.toolChoice === 'none') body.tool_choice = { type: 'none' };
      else body.tool_choice = { type: 'auto' };
    }

    const stream = this.client.messages.stream(body, { signal: params.signal });
    let text = '';
    let stopReason: ToolStopReason = 'end_turn';
    const toolParts = new Map<number, { id: string; name: string; inputJson: string }>();

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text' && event.content_block.text) {
          text += event.content_block.text;
          yield { type: 'text_delta', delta: event.content_block.text };
        } else if (event.content_block.type === 'tool_use') {
          toolParts.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          });
          yield { type: 'tool_call_delta', toolCallId: event.content_block.id, name: event.content_block.name };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          text += event.delta.text;
          yield { type: 'text_delta', delta: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          const current = toolParts.get(event.index);
          if (current) {
            current.inputJson += event.delta.partial_json;
            yield { type: 'tool_call_delta', toolCallId: current.id, name: current.name, inputDelta: event.delta.partial_json };
          }
        }
      } else if (event.type === 'message_delta') {
        stopReason = mapAnthropicStop(event.delta.stop_reason);
      }
    }

    const toolCalls: ToolCall[] = Array.from(toolParts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({ id: call.id, name: call.name, input: parseAnthropicToolInput(call.inputJson) }));
    if (toolCalls.length) stopReason = 'tool_use';
    yield { type: 'final', turn: { text, toolCalls, stopReason } };
  }
}

function mapAnthropicStop(reason: string | null): ToolStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * Build Anthropic message turns from our neutral history. Assistant turns with
 * tool calls become text + tool_use blocks; a `tool` message becomes a single
 * user turn carrying one tool_result block per result.
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const content = (message.toolResults ?? []).map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.toolCallId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      }));
      out.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: message.role as 'user' | 'assistant', content: message.content });
  }
  return out;
}

function parseAnthropicToolInput(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
