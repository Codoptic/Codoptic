import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRepo } from '../repo/repoScanner';
import { extractImportGraph } from '../repo/importGraph';
import { buildRepoContext, selectLayerContextSummaries } from '../repo/repoContext';
import type { FileSummary } from '../analysis/summarizer';

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

function summary(layer: FileSummary['layer'], role: string): FileSummary {
  return {
    role,
    category: 'service',
    layer,
    exports: [],
    imports: [],
    surface: [],
    external_deps: [],
    side_effects: [],
  };
}

describe('repoContext', () => {
  it('extracts deep deterministic context from a small repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codoptic-context-'));
    try {
      await write(root, 'package.json', JSON.stringify({ dependencies: { next: 'latest', stripe: 'latest' } }));
      await write(
        root,
        'app/api/users/route.ts',
        "import { getUser } from '../../../lib/service/user';\nexport async function GET() { return getUser(process.env.USER_TABLE!); }\n",
      );
      await write(root, 'lib/service/user.ts', "import { db } from '../data/db';\nexport function getUser(id: string) { return db.user.find(id); }\n");
      await write(root, 'lib/data/db.ts', 'export const db = { user: { find: (id: string) => id } };\n');

      const repo = await scanRepo(root);
      const imports = await extractImportGraph(root, repo.files.map((f) => f.path));
      const ctx = await buildRepoContext(repo, imports);

      expect(ctx.folderClusters.map((c) => c.folder)).toContain('app/api');
      expect(ctx.routes.some((r) => r.path === 'app/api/users/route.ts' && r.methods.includes('GET'))).toBe(true);
      expect(ctx.envVars.some((e) => e.name === 'USER_TABLE')).toBe(true);
      expect(ctx.exportsByFile.some((e) => e.path === 'lib/service/user.ts' && e.symbols.includes('getUser'))).toBe(true);
      expect(ctx.crossFolderEdges.some((e) => e.sourceFolder === 'app/api' && e.targetFolder === 'lib/service')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('selects layer files plus one-hop import boundaries', () => {
    const summaries = [
      { path: 'app/api/users/route.ts', summary: summary('gateway', 'route') },
      { path: 'lib/service/user.ts', summary: summary('service', 'service') },
      { path: 'lib/data/db.ts', summary: summary('data', 'data') },
      { path: 'components/UserList.tsx', summary: summary('client', 'client') },
    ];
    const selected = selectLayerContextSummaries(
      { name: 'Service', member_files: ['lib/service/user.ts'] },
      summaries,
      {
        files: new Map(),
        externals: new Map(),
        edges: [
          { from: 'app/api/users/route.ts', to: 'lib/service/user.ts', external: false },
          { from: 'lib/service/user.ts', to: 'lib/data/db.ts', external: false },
        ],
      },
      { min: 1, max: 10 },
    );

    expect(selected.map((s) => s.path)).toEqual(
      expect.arrayContaining(['app/api/users/route.ts', 'lib/service/user.ts', 'lib/data/db.ts']),
    );
  });
});
