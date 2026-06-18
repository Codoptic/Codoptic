'use client';

import { useState } from 'react';
import { useDiagramStore } from '@/lib/state/store';
import {
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  MISTRAL_MODELS,
  DEEPSEEK_MODELS,
  getProviderDefaultModel,
} from '@/lib/agent/utils/provider-models';
import type { ProviderId } from '@/lib/agent/providers/types';

const PROVIDERS: Array<{ id: ProviderId; label: string; envVar: string; note: string }> = [
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', note: 'Models degrade in capability from top to bottom.' },
  { id: 'anthropic', label: 'Anthropic', envVar: 'CLAUDE_API_KEY', note: 'Models degrade in capability from top to bottom.' },
  { id: 'gemini', label: 'Gemini', envVar: 'GEMINI_API_KEY', note: 'Models degrade in capability from top to bottom.' },
  { id: 'grok', label: 'xAI Grok', envVar: 'GROK_API_KEY', note: 'Fast multi-modal chat with Grok-family defaults.' },
  { id: 'mistral', label: 'Mistral', envVar: 'MISTRAL_API_KEY', note: 'High-throughput Mistral models with the same chat contract.' },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    note: 'Pick a DeepSeek model; endpoint defaults to https://api.deepseek.com.',
  },
  { id: 'nvidia', label: 'NVIDIA NIM', envVar: 'NVIDIA_API_KEY', note: 'Endpoint + model required (NIM API).' },
  { id: 'foundry', label: 'Azure Foundry', envVar: 'FOUNDRY_API_KEY', note: 'Provide the deployment name for your custom model.' },
  { id: 'openrouter', label: 'Open Router', envVar: 'OPENROUTER_API_KEY', note: 'Provide an OpenRouter model name and API URL.' },
  { id: 'local', label: 'Local Model', envVar: '', note: 'OpenAI-compatible API — works with Ollama, LM Studio, llama.cpp, Jan.' },
];

const MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
  gemini: GEMINI_MODELS,
  foundry: [],
  grok: GROK_MODELS,
  mistral: MISTRAL_MODELS,
  deepseek: DEEPSEEK_MODELS,
  openrouter: [],
};

const CUSTOM_ENDPOINT_PROVIDERS: ProviderId[] = ['foundry', 'nvidia', 'openrouter'];

function LocalModelTestButton({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);

  async function handleTest() {
    if (!baseUrl) return;
    setStatus('testing');
    setError('');
    setModels([]);
    try {
      const res = await fetch('/api/local-model/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      const data = (await res.json()) as { ok: boolean; models?: string[]; error?: string };
      if (data.ok) {
        setStatus('ok');
        setModels(data.models ?? []);
      } else {
        setStatus('fail');
        setError(data.error ?? 'Connection failed');
      }
    } catch (err) {
      setStatus('fail');
      setError(err instanceof Error ? err.message : 'Network error');
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleTest}
        disabled={!baseUrl || status === 'testing'}
        className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs hover:bg-ink-700 disabled:opacity-50"
      >
        {status === 'testing' ? 'Testing…' : 'Test Connection'}
      </button>
      {status === 'ok' && (
        <span className="text-[11px] text-green-400">
          ✓ Connected{models.length > 0 ? ` · ${models.length} model(s)` : ''}
        </span>
      )}
      {status === 'fail' && (
        <span className="truncate text-[11px] text-red-400" title={error}>
          ✕ {error}
        </span>
      )}
    </div>
  );
}

export function ProviderConfig() {
  const provider = useDiagramStore((s) => s.provider);
  const setProvider = useDiagramStore((s) => s.setProvider);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; error?: string } | null>(null);
  const showModelSelect = !CUSTOM_ENDPOINT_PROVIDERS.includes(provider.provider) && provider.provider !== 'local';
  const customModelPlaceholder =
    provider.provider === 'nvidia'
      ? 'e.g. meta/llama-3.1-70b-instruct'
      : provider.provider === 'openrouter'
        ? 'e.g. openai/gpt-4o'
        : 'e.g. my-gpt-deployment';
  const endpointPlaceholder =
    provider.provider === 'foundry'
      ? 'https://<your-resource>.openai.azure.com'
      : provider.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : 'https://nvidia.com';
  const summaryUsesCustomModel = CUSTOM_ENDPOINT_PROVIDERS.includes(provider.provider);
  const summaryModel = summaryUsesCustomModel ? provider.customModel ?? '?' : provider.model;

  const onProviderChange = (id: typeof provider.provider) => {
    setProvider({ provider: id, model: getProviderDefaultModel(id) });
    setValidation(null);
  };

  const onValidate = async () => {
    setValidating(true);
    setValidation(null);
    try {
      const res = await fetch('/api/agent/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.provider,
          model: CUSTOM_ENDPOINT_PROVIDERS.includes(provider.provider) ? provider.customModel ?? '' : provider.model,
          apiKey: provider.apiKey || undefined,
          endpoint: provider.endpoint || undefined,
        }),
      });
      const data = await res.json();
      setValidation(data);
    } catch (err) {
      setValidation({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-accent/15 bg-black/42 p-4 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-ink-400">AI Provider</div>

      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <label
            key={p.id}
            className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors ${
              provider.provider === p.id
                ? 'border-accent/60 bg-accent/10'
                : 'border-ink-700 bg-ink-800 hover:bg-ink-700'
            }`}
          >
            <input
              type="radio"
              name="provider"
              checked={provider.provider === p.id}
              onChange={() => onProviderChange(p.id)}
              className="accent-accent"
            />
            <div className="flex-1">
              <div className="text-ink-100">{p.label}</div>
              <div className="text-[10px] text-ink-400">{p.envVar}</div>
            </div>
          </label>
        ))}
      </div>

      {showModelSelect && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Model</div>
          <select
            value={provider.model}
            onChange={(e) => setProvider({ model: e.target.value })}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
          >
            {MODELS_BY_PROVIDER[provider.provider]?.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-ink-400">
            Models are listed in order of capability — switch down if the top one isn&apos;t available on your account.
          </div>
        </div>
      )}

      {CUSTOM_ENDPOINT_PROVIDERS.includes(provider.provider) && (
        <>
          <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Endpoint</div>
          <input
            value={provider.endpoint ?? ''}
            onChange={(e) => setProvider({ endpoint: e.target.value })}
            placeholder={endpointPlaceholder}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
          />
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">
            {provider.provider === 'foundry'
              ? 'Deployment (model name)'
              : provider.provider === 'openrouter'
              ? 'OpenRouter model name'
              : provider.provider === 'deepseek'
              ? 'DeepSeek model name'
              : 'Model name'}
          </div>
          <input
            value={provider.customModel ?? provider.model}
            onChange={(e) => setProvider({ customModel: e.target.value, model: e.target.value })}
            placeholder={customModelPlaceholder}
            className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
          />
          <div className="mt-1 text-[10px] text-ink-400">
            {provider.provider === 'foundry'
              ? 'Point to an Azure deployment (e.g. my-gpt-deployment).'
              : provider.provider === 'openrouter'
              ? 'Enter the OpenRouter model slug you want to use (e.g. openai/gpt-4o).'
              : provider.provider === 'deepseek'
              ? 'Enter the DeepSeek model you want to use (e.g. deepseek-v4-pro).'
              : 'Provide the NVIDIA NIM model path (e.g. meta/llama-3.1-70b-instruct).'}
          </div>
        </div>
      </>
      )}

      {provider.provider === 'local' && (
        <div className="space-y-3">
          <div className="rounded-md border border-green-900/50 bg-green-950/30 px-3 py-2 text-[11px] text-green-400">
            🟢 OpenAI-compatible API · Works with Ollama, LM Studio, llama.cpp, Jan
          </div>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Base URL</div>
            <input
              type="text"
              value={provider.localBaseUrl ?? 'http://localhost:11434/v1'}
              onChange={(e) => setProvider({ localBaseUrl: e.target.value })}
              placeholder="http://localhost:11434/v1"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
              autoComplete="off"
              aria-label="Local model base URL"
            />
          </div>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Model Name</div>
            <input
              type="text"
              value={provider.localModelName ?? ''}
              onChange={(e) => setProvider({ localModelName: e.target.value })}
              placeholder="llama3.2"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
              autoComplete="off"
              aria-label="Local model name"
            />
            <div className="mt-1 text-[10px] text-ink-400">e.g. llama3.2, mistral, codestral, phi3</div>
          </div>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">
              API Key <span className="normal-case text-ink-500">(optional)</span>
            </div>
            <input
              type="password"
              value={provider.localApiKey ?? ''}
              onChange={(e) => setProvider({ localApiKey: e.target.value })}
              placeholder="Leave blank if not required"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
              autoComplete="off"
              aria-label="Local model API key"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Context Length</div>
              <input
                type="number"
                value={provider.localContextLength ?? 4096}
                onChange={(e) => setProvider({ localContextLength: Number(e.target.value) })}
                min={256}
                step={256}
                className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
                aria-label="Context length in tokens"
              />
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Temperature</div>
              <input
                type="number"
                value={provider.localTemperature ?? 0.7}
                onChange={(e) => setProvider({ localTemperature: Number(e.target.value) })}
                min={0}
                max={2}
                step={0.1}
                className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-[13px]"
                aria-label="Temperature"
              />
            </div>
          </div>

          <LocalModelTestButton
            baseUrl={provider.localBaseUrl ?? ''}
            apiKey={provider.localApiKey ?? ''}
          />

          <div className="text-[10px] text-ink-500">✓ Config auto-saved to browser storage</div>
        </div>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-ink-400">
          <span>API Key (optional — falls back to .env.local)</span>
        </div>
        <input
          type="password"
          value={provider.apiKey}
          onChange={(e) => setProvider({ apiKey: e.target.value })}
          placeholder="sk-…"
          className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5"
          autoComplete="off"
        />
        <div className="mt-1 text-[10px] text-ink-400">
          Held in server memory only for this analysis — never written to disk or sent to the browser again.
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onValidate}
          disabled={validating}
          className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs hover:bg-ink-700 disabled:opacity-50"
        >
          {validating ? 'Checking…' : 'Validate key'}
        </button>
        {validation && (
          <div
            className={`flex-1 truncate text-[11px] ${validation.ok ? 'text-green-300' : 'text-red-300'}`}
            title={validation.error}
          >
            {validation.ok ? '✓ Provider ready' : `✕ ${validation.error}`}
          </div>
        )}
      </div>
    </div>
  );
}
