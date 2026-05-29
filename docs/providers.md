# AI providers

Codoptic supports five AI providers. Pick one in the UI; you can switch
at any time. API keys come from `.env.local` or from a per-session input
field in the UI (the field value is kept in server memory only and is
discarded when the analysis finishes).

## Retry semantics

Every provider call goes through a single retry wrapper
([lib/agent/providers/retry.ts](../lib/agent/providers/retry.ts)) with:

- **Infinite retries** until the request succeeds or the user cancels.
- **Exponential backoff** starting at 2 s, capped at 60 s, with full jitter.
- **`Retry-After` header** honored when present (rate limits).
- Each retry emits a `retry` SSE event so the UI shows
  *"Retrying in 8s (attempt 3)"* live.
- The user can cancel any time — the AbortSignal cascades to the retry loop.

## OpenAI

| Setting    | Value                                                       |
|------------|-------------------------------------------------------------|
| Env var    | `OPENAI_API_KEY`                                            |
| Models     | `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-4o`, `gpt-5-nano` |
| JSON mode  | `response_format: json_schema` with `strict: true`         |

Models are listed in order of capability. If a listed model isn't available
on your account, switch down — the API call will fail with a clear
`model_not_found` error.

## Anthropic

| Setting    | Value                                                        |
|------------|--------------------------------------------------------------|
| Env var    | `CLAUDE_API_KEY`                                             |
| Models     | `opus-4.7`, `sonnet-4.6`, `haiku-4.5`                        |
| JSON mode  | Coerced via a `tool_use` with the schema as `input_schema`   |

## Gemini

| Setting    | Value                                                            |
|------------|------------------------------------------------------------------|
| Env var    | `GEMINI_API_KEY`                                                 |
| Models     | `gemini-3.1-pro`, `gemini-3.5-flash`, `gemini-3.1-flash-lite`    |
| JSON mode  | `generationConfig.responseSchema` + `responseMimeType: application/json` |

## Grok (xAI)

| Setting    | Value                                                           |
|------------|-----------------------------------------------------------------|
| Env var    | `GROK_API_KEY`                                                   |
| Models     | `grok-3`, `grok-3-mini`, `grok-2-1212`, `grok-2-vision-1212`     |
| Base URL   | `https://api.x.ai/v1` (override with `GROK_API_BASE`)           |
| JSON mode  | `response_format: json_schema` with `strict: true`              |

## Mistral

| Setting    | Value                                                       |
|------------|-------------------------------------------------------------|
| Env var    | `MISTRAL_API_KEY`                                           |
| Models     | `mistral-large`, `mistral-medium`, `mistral-small`          |
| Base URL   | `https://api.mistral.ai/v1` (override with `MISTRAL_ENDPOINT`) |
| JSON mode  | OpenAI-compatible `response_format` payloads (strict schema) |

## DeepSeek NLU

| Setting    | Value                                                       |
|------------|-------------------------------------------------------------|
| Env var    | `DEEPSEEK_API_KEY`                                          |
| Models     | `deepseek-v4-pro`, `deepseek-v4-mini`                       |
| Endpoint   | `https://api.deepseek.com` (override with `DEEPSEEK_ENDPOINT`) |
| JSON mode  | OpenAI-compatible `response_format` payloads (strict schema) |

## NVIDIA NIM

| Setting    | Value                                                       |
|------------|-------------------------------------------------------------|
| Env var    | `NVIDIA_API_KEY`                                            |
| Models     | `meta/llama-3.1-70b-instruct`, `meta/llama-3.1-34b-instruct` |
| Endpoint   | `https://nvidia.com` (override with `NVIDIA_ENDPOINT`)     |
| JSON mode  | OpenAI-compatible `response_format` payloads (strict schema) |

## Azure AI Foundry

| Setting    | Value                                                        |
|------------|--------------------------------------------------------------|
| Env vars   | `FOUNDRY_API_KEY`, `FOUNDRY_ENDPOINT`, `FOUNDRY_MODEL`       |
| Model      | Custom deployment name (free-text input)                    |
| Endpoint   | Your Azure resource URL — required                          |
| JSON mode  | `response_format: json_schema` (OpenAI-compatible API)      |

## Validation

`/api/agent/validate` issues a tiny 1-token ping to confirm credentials and
model availability before the analysis starts. The result surfaces inline
in the UI: ✓ green / ✗ red with the error message.
