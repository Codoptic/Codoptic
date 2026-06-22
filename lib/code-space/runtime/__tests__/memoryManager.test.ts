import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryManager, normalizeMemoryPath, PROJECT_MEMORY_DIR } from '../memoryManager';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(process.cwd(), '.tmp-memory-manager-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('MemoryManager', () => {
  it('lists and ranks relevant project memories under /memories', async () => {
    await mkdir(path.join(tmpDir, PROJECT_MEMORY_DIR), { recursive: true });
    await writeFile(path.join(tmpDir, PROJECT_MEMORY_DIR, 'user-preferences.md'), '# Preferences\nPrefer small patches.\napi_key=secret-value\n', 'utf8');
    await writeFile(path.join(tmpDir, PROJECT_MEMORY_DIR, 'research-notes.md'), '# Research\nSubagent delegation notes.\n', 'utf8');
    await writeFile(path.join(tmpDir, 'outside.md'), '# Outside\nDo not load.\n', 'utf8');

    const manager = new MemoryManager();
    const context = await manager.collectRelevant(tmpDir, 'review subagent delegation workflow', 2);

    expect(context.entries.map((entry) => entry.path)).toContain('memories/research-notes.md');
    expect(context.entries.every((entry) => entry.path.startsWith('memories/'))).toBe(true);
    expect(context.entries.map((entry) => entry.content).join('\n')).not.toContain('secret-value');
  });

  it('normalizes memory paths and rejects traversal or unsupported files', () => {
    expect(normalizeMemoryPath('decisions.md')).toBe('memories/decisions.md');
    expect(normalizeMemoryPath('memories/project-context.md')).toBe('memories/project-context.md');
    expect(normalizeMemoryPath('../secrets.md')).toBe('');
    expect(normalizeMemoryPath('/tmp/secrets.md')).toBe('');
    expect(normalizeMemoryPath('memories/blob.bin')).toBe('');
  });
});
