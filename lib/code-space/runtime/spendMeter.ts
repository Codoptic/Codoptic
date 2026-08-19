export interface SpendSnapshot {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  calls: number;
}

export interface SpendLimits {
  maxUsd?: number;
  maxTokens?: number;
}

export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const DEFAULT_INPUT_USD_PER_M = 3;
const DEFAULT_OUTPUT_USD_PER_M = 15;

export class SpendMeter {
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;

  constructor(
    private readonly limits: SpendLimits = {},
    private readonly rates = { inputUsdPerM: DEFAULT_INPUT_USD_PER_M, outputUsdPerM: DEFAULT_OUTPUT_USD_PER_M },
  ) {}

  record(usage: ProviderUsage = {}, fallbackInput = 0, fallbackOutput = 0): SpendSnapshot {
    const input = usage.promptTokens ?? fallbackInput;
    const output = usage.completionTokens ?? (usage.totalTokens != null ? Math.max(0, usage.totalTokens - input) : fallbackOutput);
    this.inputTokens += Math.max(0, input);
    this.outputTokens += Math.max(0, output);
    this.calls += 1;
    return this.snapshot();
  }

  snapshot(): SpendSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      usd: this.usd(),
      calls: this.calls,
    };
  }

  usd(): number {
    return (this.inputTokens / 1_000_000) * this.rates.inputUsdPerM + (this.outputTokens / 1_000_000) * this.rates.outputUsdPerM;
  }

  tokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  warnSoft(): boolean {
    return this.ratio() >= 0.7 && !this.exhausted();
  }

  exhausted(): boolean {
    if (this.limits.maxUsd != null && this.usd() >= this.limits.maxUsd) return true;
    if (this.limits.maxTokens != null && this.tokens() >= this.limits.maxTokens) return true;
    return false;
  }

  ratio(): number {
    const usdRatio = this.limits.maxUsd ? this.usd() / this.limits.maxUsd : 0;
    const tokenRatio = this.limits.maxTokens ? this.tokens() / this.limits.maxTokens : 0;
    return Math.max(usdRatio, tokenRatio);
  }
}

export function parseProviderUsage(payload: unknown): ProviderUsage {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const usage = (record.usage ?? record.token_usage ?? record) as Record<string, unknown>;
  return {
    promptTokens: numberish(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens),
    completionTokens: numberish(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens),
    totalTokens: numberish(usage.total_tokens ?? usage.totalTokens),
  };
}

function numberish(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
