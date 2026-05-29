import { promises as fs } from 'node:fs';
import path from 'node:path';

const CACHE_ROOT = path.resolve(process.cwd(), '.codoptic-cache');

export async function ensureCacheDir(): Promise<string> {
  await fs.mkdir(CACHE_ROOT, { recursive: true });
  return CACHE_ROOT;
}

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(path.join(CACHE_ROOT, `${key}.json`), 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  await ensureCacheDir();
  await fs.writeFile(path.join(CACHE_ROOT, `${key}.json`), JSON.stringify(value), 'utf8');
}
