import OpenAI from 'openai';
import type {
  AssistantTurn,
  ChatWithToolsStreamEvent,
  ChatParams,
  ChatWithToolsParams,
  Provider,
  ProviderConfig,
  ValidationResult,
} from './types';
import { resolveMaxTokens, withMaxTokenKeyRetry } from './maxTokens';
import { buildOpenAIToolMessages, buildOpenAIToolSpecs, parseOpenAIToolResponse } from './openaiCompat';
import { runToolShimTurn } from './toolShim';

export class OpenAIProvider implements Provider {
  id = 'openai' as const;
  private client: OpenAI;

  constructor(cfg: ProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.endpoint });
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      if (usesCompletionsEndpoint(model)) {
        await withMaxTokenKeyRetry(1, (key) =>
          this.client.completions.create({ model, prompt: 'ping', [key]: 1 }),
        );
      } else {
        await this.client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'ping' }],
        });
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    if (usesCompletionsEndpoint(params.model)) {
      const prompt = toCompletionsPrompt(params.messages, params.jsonSchema);
      const maxTokens = params.jsonSchema ? 4096 : 2048;
      const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
        this.client.completions.create(
          {
            model: params.model,
            prompt,
            [key]: maxTokens,
          },
          { signal: params.signal },
        ),
      );
      return res.choices[0]?.text?.trim() ?? '';
    }

    const messages = params.messages.map((m) => ({ role: m.role, content: m.content }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseBody: any = {
      // Root Cause vs Logic: Sampling overrides can be rejected by modern models, so keep the payload minimal.
      model: params.model,
      messages,
    };
    if (params.jsonSchema) {
      baseBody.response_format = {
        type: 'json_schema',
        json_schema: { name: 'output', schema: params.jsonSchema, strict: true },
      };
    }
    const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
    const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
      this.client.chat.completions.create({ ...baseBody, [key]: maxTokens }, { signal: params.signal }),
    );
    return res.choices[0]?.message?.content ?? '';
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<AssistantTurn> {
    // Codex text models can't use native tools; drive them through the prompt shim.
    if (usesCompletionsEndpoint(params.model)) {
      const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
      return runToolShimTurn(params.messages, params.tools, async (flattened) => {
        const prompt = toCompletionsPrompt(flattened);
        const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
          this.client.completions.create(
            { model: params.model, prompt, [key]: maxTokens },
            { signal: params.signal },
          ),
        );
        return res.choices[0]?.text ?? '';
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseBody: any = {
      model: params.model,
      messages: buildOpenAIToolMessages(params.messages),
    };
    if (params.tools.length) {
      baseBody.tools = buildOpenAIToolSpecs(params.tools);
      baseBody.tool_choice =
        params.toolChoice === 'required' ? 'required' : params.toolChoice === 'none' ? 'none' : 'auto';
    }
    const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
    const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
      this.client.chat.completions.create({ ...baseBody, [key]: maxTokens }, { signal: params.signal }),
    );
    return parseOpenAIToolResponse(res);
  }

  async *chatWithToolsStream(params: ChatWithToolsParams): AsyncIterable<ChatWithToolsStreamEvent> {
    if (usesCompletionsEndpoint(params.model)) {
      yield { type: 'status', message: 'Using stable Codex completion turn.' };
      yield { type: 'final', turn: await this.chatWithTools(params) };
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseBody: any = {
      model: params.model,
      messages: buildOpenAIToolMessages(params.messages),
      stream: true,
    };
    if (params.tools.length) {
      baseBody.tools = buildOpenAIToolSpecs(params.tools);
      baseBody.tool_choice =
        params.toolChoice === 'required' ? 'required' : params.toolChoice === 'none' ? 'none' : 'auto';
    }
    const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
    const stream = await withMaxTokenKeyRetry(maxTokens, (key) =>
      this.client.chat.completions.create({ ...baseBody, [key]: maxTokens }, { signal: params.signal }),
    ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    let text = '';
    let stopReason: AssistantTurn['stopReason'] = 'end_turn';
    const toolParts = new Map<number, { id: string; name: string; argumentsText: string }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        yield { type: 'text_delta', delta: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = toolParts.get(index) ?? { id: call.id ?? `tool_${index}`, name: '', argumentsText: '' };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = call.function.name;
        if (call.function?.arguments) current.argumentsText += call.function.arguments;
        toolParts.set(index, current);
        yield {
          type: 'tool_call_delta',
          toolCallId: current.id,
          name: current.name || undefined,
          inputDelta: call.function?.arguments,
        };
      }
      if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use';
      else if (choice?.finish_reason === 'length') stopReason = 'max_tokens';
      else if (choice?.finish_reason === 'content_filter') stopReason = 'refusal';
    }

    const toolCalls = Array.from(toolParts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        input: parseToolArguments(call.argumentsText),
      }))
      .filter((call) => call.name);
    if (toolCalls.length) stopReason = 'tool_use';
    yield { type: 'final', turn: { text, toolCalls, stopReason } };
  }
}

function usesCompletionsEndpoint(model: string): boolean {
  // Root Cause vs Logic: Codex text models are rejected by /chat/completions, so route only those models through the legacy completions API while preserving chat semantics for normal OpenAI models.
  return model.toLowerCase().includes('codex');
}

function toCompletionsPrompt(messages: ChatParams['messages'], jsonSchema?: Record<string, unknown>): string {
  const conversation = messages
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join('\n\n');

  const schemaInstruction = jsonSchema
    ? `\n\nReturn only valid JSON matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`
    : '';

  return `${conversation}${schemaInstruction}\n\nASSISTANT:\n`;
}

function parseToolArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
