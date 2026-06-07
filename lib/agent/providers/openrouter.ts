import type { ProviderConfig } from './types';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterProvider extends OpenAICompatibleProvider {
  id = 'openrouter' as const;

  constructor(cfg: ProviderConfig) {
    super(cfg, DEFAULT_BASE_URL, 'OPENROUTER_ENDPOINT');
  }
}
