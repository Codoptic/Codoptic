import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDocPriors } from '../docs/docReader';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '../repo/repoScanner';

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('readDocPriors', () => {
  it('reads README, instruction files, and docs/ instead of only README.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codoptic-docs-'));
    try {
      await write(root, 'src/app.ts', 'export const app = true;\n');
      await write(root, 'README.md', '# Root readme\n');
      await write(root, 'AGENTS.md', '# Agent rules\n');
      await write(root, 'docs/architecture.md', '# Architecture\n');
      await write(root, 'docs/guide.md', '# Guide\n');
      await write(root, 'docs/adr/0001-choice.md', '# ADR\n');

      const repo = await scanRepo(root, { allowlist: AGENT_FILE_ALLOWLIST });
      const docs = await readDocPriors(repo);

      expect(docs.map((doc) => doc.path)).toEqual(
        expect.arrayContaining(['AGENTS.md', 'README.md', 'docs/architecture.md', 'docs/guide.md', 'docs/adr/0001-choice.md']),
      );
      expect(docs.find((doc) => doc.path === 'README.md')?.kind).toBe('readme');
      expect(docs.find((doc) => doc.path === 'docs/adr/0001-choice.md')?.kind).toBe('adr');
      expect(docs.find((doc) => doc.path === 'docs/architecture.md')?.kind).toBe('doc');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
