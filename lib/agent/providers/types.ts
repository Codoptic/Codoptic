export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'foundry'
  | 'grok'
  | 'local'
  | 'mistral'
  | 'deepseek'
  | 'nvidia'
  | 'openrouter';

/** A single tool call requested by the model. `input` is always a parsed object. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The runtime's answer to a tool call, fed back into the next turn. */
export interface ToolResultMessage {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns where the model requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `role: 'tool'` turns carrying the results of prior tool calls. */
  toolResults?: ToolResultMessage[];
}

export type ToolStopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal';

/** A tool the model may call during a tool-use loop. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object at root) describing the tool's input. */
  inputSchema: Record<string, unknown>;
}

/** One assistant turn from a tool-use round-trip. */
export interface AssistantTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: ToolStopReason;
}

export type ChatWithToolsStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_delta'; toolCallId: string; name?: string; inputDelta?: string }
  | { type: 'final'; turn: AssistantTurn };

export interface ChatWithToolsParams {
  messages: ChatMessage[];
  model: string;
  tools: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatParams {
  messages: ChatMessage[];
  model: string;
  /** JSON schema for structured output. Provider adapts to its native equivalent. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface ProviderConfig {
  apiKey: string;
  endpoint?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface Provider {
  id: ProviderId;
  validate(model: string): Promise<ValidationResult>;
  chat(params: ChatParams): Promise<string>;
  /** Optional native multi-turn tool-calling. One round-trip → one assistant turn. */
  chatWithTools?(params: ChatWithToolsParams): Promise<AssistantTurn>;
  /** Optional native streaming tool-calling. Must yield exactly one final turn event. */
  chatWithToolsStream?(params: ChatWithToolsParams): AsyncIterable<ChatWithToolsStreamEvent>;
}

export type RetryListener = (notice: RetryNotice) => void;
