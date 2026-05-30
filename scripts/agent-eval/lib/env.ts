/**
 * Minimal .env.local reader for the agent evaluation harness.
 *
 * Motivation vs Logic: the harness drives the REAL agent over HTTP and must
 * supply real provider credentials in the request body. Rather than depend on
 * the app's internal env loader (which uses `@/` path aliases that tsx does not
 * resolve in a standalone script), we parse `.env.local` directly here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface FoundryCreds {
  providerId: 'foundry';
  apiKey: string;
  endpoint: string;
  model: string;
}

export function parseDotEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadRepoEnv(repoRoot: string): Record<string, string> {
  const merged: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of ['.env', '.env.local']) {
    try {
      Object.assign(merged, parseDotEnv(readFileSync(path.join(repoRoot, file), 'utf8')));
    } catch {
      // optional file
    }
  }
  return merged;
}

export function resolveFoundryCreds(repoRoot: string): FoundryCreds {
  const env = loadRepoEnv(repoRoot);
  const apiKey = env.FOUNDRY_API_KEY ?? '';
  const endpoint = env.FOUNDRY_ENDPOINT ?? '';
  const model = env.FOUNDRY_MODEL ?? 'gpt-5.4';
  if (!apiKey || !endpoint) {
    throw new Error('FOUNDRY_API_KEY and FOUNDRY_ENDPOINT must be set in .env.local to run the agent eval harness.');
  }
  return { providerId: 'foundry', apiKey, endpoint, model };
}
