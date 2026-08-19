import { describe, expect, it } from 'vitest';
import { classifyRelevance } from '../analysis/classifier';
import type { RepoMap, ScannedFile } from '../repo/repoScanner';

function file(path: string): ScannedFile {
  return { path, ext: path.split('.').pop() ?? '', bytes: 100 };
}

describe('classifyRelevance', () => {
  it('keeps folder coverage in large repositories', () => {
    const apiFiles = Array.from({ length: 20 }, (_, i) => file(`app/api/route${i}.ts`));
    const serviceFiles = [file('services/billing/index.ts')];
    const dataFiles = [file('db/schema.prisma')];
    const uiFiles = [file('components/dashboard/Card.tsx')];
    const files = [...apiFiles, ...serviceFiles, ...dataFiles, ...uiFiles];
    const map: RepoMap = {
      root: '/repo',
      fileCount: files.length,
      totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
      byExt: {},
      files,
      manifests: [],
      entrypoints: [],
      apiRoutes: apiFiles,
      components: uiFiles,
      schemas: dataFiles,
      configs: [],
      infra: [],
      tests: [],
      docs: [],
      depHints: [],
      ignoredFolders: [],
      likelyStack: [],
    };

    const selected = classifyRelevance(map, 'architecture', '', 8).map((item) => item.file.path);

    expect(selected.some((path) => path.startsWith('services/'))).toBe(true);
    expect(selected.some((path) => path.startsWith('db/'))).toBe(true);
    expect(selected.some((path) => path.startsWith('components/'))).toBe(true);
  });

  it('keeps documentation files eligible for architecture diagrams', () => {
    const docs = [file('docs/architecture.md'), file('README.md')];
    const code = [file('src/main.ts')];
    const files = [...docs, ...code];
    const map: RepoMap = {
      root: '/repo',
      fileCount: files.length,
      totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
      byExt: {},
      files,
      manifests: [],
      entrypoints: code,
      apiRoutes: [],
      components: [],
      schemas: [],
      configs: [],
      infra: [],
      tests: [],
      docs,
      depHints: [],
      ignoredFolders: [],
      likelyStack: [],
    };

    const selected = classifyRelevance(map, 'architecture', '', 3).map((item) => item.file.path);
    expect(selected).toEqual(expect.arrayContaining(['docs/architecture.md', 'README.md']));
  });
});
