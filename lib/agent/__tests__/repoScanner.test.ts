import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_FILE_ALLOWLIST, scanRepo } from '../repo/repoScanner';

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('repoScanner', () => {
  it('scans source-like files plus documentation and ignores configs, tests, assets, and generated output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codoptic-scan-'));
    try {
      const allowed = [
        'README.md',
        'AGENTS.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'LICENSE.md',
        'setup.md',
        'docs/guide.md',
        'docs/architecture.md',
        'docs/setup.md',
        'app/layout.tsx',
        'app/page.tsx',
        'backend/main.py',
        'cmd/server/main.go',
        'components/Button.tsx',
        'frontend/App.svelte',
        'frontend/App.vue',
        'src/runtime.js',
        'src/Program.cs',
        'src/app.component.ts',
        'src/app.module.ts',
        'src/main/java/com/acme/App.java',
      ];
      const ignored = [
        'appsettings.Development.json',
        'assets/logo.png',
        'build.gradle',
        'eslint.config.mjs',
        'generated/client.ts',
        'next-auth.d.ts',
        'next.config.ts',
        'package.json',
        'postcss.config.mjs',
        'pom.xml',
        'public/logo.png',
        'pyproject.toml',
        'seed.ts',
        'setup.sh',
        'tailwind.config.ts',
        'tests/app.test.ts',
        'src/app.spec.ts',
        '__tests__/fixture.ts',
        'README.txt',
      ];

      for (const rel of allowed) {
        await write(root, rel, `// ${rel}\n`);
      }
      for (const rel of ignored) {
        await write(root, rel, `// ${rel}\n`);
      }

      const repo = await scanRepo(root, { allowlist: AGENT_FILE_ALLOWLIST });
      const paths = repo.files.map((file) => file.path).sort();

      expect(paths).toEqual(expect.arrayContaining(allowed));
      expect(paths).not.toEqual(expect.arrayContaining(ignored));
      expect(repo.docs.map((file) => file.path).sort()).toEqual([
        'AGENTS.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'LICENSE.md',
        'README.md',
        'docs/architecture.md',
        'docs/guide.md',
        'docs/setup.md',
        'setup.md',
      ]);
      expect(repo.tests).toHaveLength(0);
      expect(repo.manifests).toHaveLength(0);
      expect(repo.configs).toHaveLength(0);
      expect(repo.depHints).toEqual([]);
      expect(repo.likelyStack).toEqual(
        expect.arrayContaining([
          'Node.js',
          'TypeScript',
          'JavaScript',
          'React',
          'Next.js',
          'Angular',
          'Python',
          'Java',
          'Spring Boot',
          '.NET',
          'Go',
          'Vue',
          'Svelte',
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies user-selected ignored folders before scanning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codoptic-scan-ignore-'));
    try {
      await write(root, 'src/app.ts', 'export const app = true;\n');
      await write(root, 'generated/client.ts', 'export const generated = true;\n');
      await write(root, 'packages/ignored/index.ts', 'export const ignored = true;\n');

      const repo = await scanRepo(root, {
        allowlist: AGENT_FILE_ALLOWLIST,
        ignoredFolders: ['generated', 'packages/ignored'],
      });
      const paths = repo.files.map((file) => file.path);

      expect(paths).toEqual(['src/app.ts']);
      expect(repo.ignoredFolders).toEqual(expect.arrayContaining(['generated/**', 'packages/ignored/**']));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('also honors individual file entries in the ignore list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codoptic-scan-ignore-file-'));
    try {
      await write(root, 'src/keep.ts', 'export const keep = true;\n');
      await write(root, 'src/skip.ts', 'export const skip = true;\n');
      await write(root, 'top-level.ts', 'export const top = true;\n');

      const repo = await scanRepo(root, {
        allowlist: AGENT_FILE_ALLOWLIST,
        ignoredFolders: ['src/skip.ts', 'top-level.ts'],
      });
      const paths = repo.files.map((file) => file.path).sort();

      expect(paths).toEqual(['src/keep.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
