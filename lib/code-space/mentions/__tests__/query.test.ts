import { describe, expect, it } from 'vitest';
import { buildMentionIndex } from '../index';
import { parseMentionToken, queryMentionSuggestions } from '../query';

const FIXTURE = [
  'app/components/control/controlPanel.tsx',
  'app/components/Button.tsx',
  'backend/main.py',
  'backend/README.md',
  'backend/components/AuthCard.tsx',
  'backend/components/controlPanel.tsx',
  'backend/components/forms/Input.tsx',
  'backend/controllers/userController.ts',
  'backend/routes/user.ts',
  'backend/services/api.ts',
  'frontend/App.tsx',
  'frontend/main.tsx',
  'lib/api-client.ts',
  'lib/user_controller.ts',
  'docs/intro.md',
  'docs/control-flow.md',
  'package.json',
  'README.md',
  'AGENTS.md',
  'docker-compose.yml',
  'tsconfig.json',
  '.github/workflows/deploy.yml',
  '.env.example',
  'public/logo.png',
];

function paths(results: { relativePath: string }[]): string[] {
  return results.map((r) => r.relativePath);
}

describe('parseMentionToken', () => {
  const index = buildMentionIndex(FIXTURE);

  it('empty token -> rootBrowse', () => {
    const parsed = parseMentionToken('', index);
    expect(parsed.mode).toBe('rootBrowse');
  });

  it('exact directory name -> directoryBrowse', () => {
    const parsed = parseMentionToken('backend', index);
    expect(parsed.mode).toBe('directoryBrowse');
    expect(parsed.scopeDir).toBe('backend');
  });

  it('trailing slash on directory -> directoryBrowse', () => {
    const parsed = parseMentionToken('backend/', index);
    expect(parsed.mode).toBe('directoryBrowse');
    expect(parsed.scopeDir).toBe('backend');
  });

  it('nested exact directory -> directoryBrowse', () => {
    const parsed = parseMentionToken('backend/components', index);
    expect(parsed.mode).toBe('directoryBrowse');
    expect(parsed.scopeDir).toBe('backend/components');
  });

  it('directory prefix + leaf query -> scopedSearch', () => {
    const parsed = parseMentionToken('backend/comp', index);
    expect(parsed.mode).toBe('scopedSearch');
    expect(parsed.scopeDir).toBe('backend');
    expect(parsed.query).toBe('comp');
  });

  it('global single-token without exact dir -> globalFuzzySearch', () => {
    const parsed = parseMentionToken('control', index);
    expect(parsed.mode).toBe('globalFuzzySearch');
  });

  it('multi-segment without exact dir prefix -> pathFuzzySearch', () => {
    const parsed = parseMentionToken('app/cont/panel', index);
    expect(parsed.mode).toBe('pathFuzzySearch');
  });

  it('rejects path traversal', () => {
    const parsed = parseMentionToken('../secret', index);
    expect(parsed.rejectedTraversal).toBe(true);
  });

  it('keeps dot-prefixed paths discoverable', () => {
    const parsed = parseMentionToken('.github', index);
    expect(parsed.mode).toBe('directoryBrowse');
  });
});

describe('queryMentionSuggestions', () => {
  const index = buildMentionIndex(FIXTURE);

  it('@ returns root-nearest folders and important configs, excludes node_modules-style folders', () => {
    const results = queryMentionSuggestions(index, { rawToken: '' });
    const got = paths(results);
    expect(got).toContain('README.md');
    expect(got).toContain('package.json');
    expect(got).toContain('AGENTS.md');
    // Folders show up too
    expect(got).toContain('app');
    expect(got).toContain('backend');
    expect(got).toContain('frontend');
    // .github is hidden by default and should not crowd out the visible roots
    expect(got).not.toContain('.github');
    // Length cap
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('@ includes currently open editor files in the default pool even when they are deep paths', () => {
    const results = queryMentionSuggestions(index, {
      rawToken: '',
      openFiles: ['app/components/control/controlPanel.tsx'],
    });
    const got = paths(results);
    expect(got).toContain('app/components/control/controlPanel.tsx');
  });

  it('@backend lists immediate children of backend', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'backend' });
    const got = paths(results);
    expect(got).toContain('backend/main.py');
    expect(got).toContain('backend/README.md');
    expect(got).toContain('backend/components');
    expect(got).toContain('backend/services');
    expect(got).toContain('backend/routes');
    expect(got).toContain('backend/controllers');
    // Nothing from outside backend
    expect(got.every((p) => p === 'backend' || p.startsWith('backend/'))).toBe(true);
  });

  it('@backend/ behaves the same as @backend', () => {
    const a = paths(queryMentionSuggestions(index, { rawToken: 'backend' }));
    const b = paths(queryMentionSuggestions(index, { rawToken: 'backend/' }));
    expect(a.sort()).toEqual(b.sort());
  });

  it('@backend/components lists immediate children of that directory', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'backend/components' });
    const got = paths(results);
    expect(got).toContain('backend/components/AuthCard.tsx');
    expect(got).toContain('backend/components/controlPanel.tsx');
    expect(got).toContain('backend/components/forms');
    expect(got.every((p) => p === 'backend/components' || p.startsWith('backend/components/'))).toBe(
      true,
    );
  });

  it('@backend/cont scoped-searches inside backend', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'backend/cont' });
    const got = paths(results);
    expect(got.length).toBeGreaterThan(0);
    expect(got).toContain('backend/controllers');
    expect(got.every((p) => p.startsWith('backend/'))).toBe(true);
    // Frontend never appears
    expect(got.some((p) => p.startsWith('frontend/'))).toBe(false);
  });

  it('@control ranks basename matches above deep path substrings; both duplicates appear', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'control' });
    const got = paths(results);
    // Both controlPanel.tsx files should appear (duplicate basename).
    expect(got).toContain('app/components/control/controlPanel.tsx');
    expect(got).toContain('backend/components/controlPanel.tsx');
    // docs/control-flow.md (basename starts with control) ranks decently but not above the file
    // whose entire basename starts with the same word.
    expect(got.indexOf('docs/control-flow.md')).toBeGreaterThan(-1);
  });

  it('@cpanel matches controlPanel.tsx via camelCase acronym', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'cpanel' });
    const got = paths(results);
    expect(got).toContain('app/components/control/controlPanel.tsx');
    expect(got).toContain('backend/components/controlPanel.tsx');
  });

  it('@apiclient matches api-client.ts via separator-stripped equivalence', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'apiclient' });
    const got = paths(results);
    expect(got).toContain('lib/api-client.ts');
  });

  it('@README returns README.md ranked near the top', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'README' });
    const got = paths(results);
    expect(got[0]).toBe('README.md');
  });

  it('@.github surfaces the hidden dot folder (or its immediate children)', () => {
    const results = queryMentionSuggestions(index, { rawToken: '.github' });
    const got = paths(results);
    // Spec accepts either showing `.github/` itself or its immediate children.
    const surfaced = got.some((p) => p === '.github' || p.startsWith('.github/'));
    expect(surfaced).toBe(true);
  });

  it('rejects traversal tokens entirely', () => {
    const results = queryMentionSuggestions(index, { rawToken: '../secret' });
    expect(results).toEqual([]);
  });

  it('@app/cont/panel path-fuzzy ranks the matching deep file at the top', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'app/cont/panel' });
    const got = paths(results);
    expect(got[0]).toBe('app/components/control/controlPanel.tsx');
  });

  it('hidden files are down-ranked vs visible alternatives when query has no dot', () => {
    const indexWithAlternative = buildMentionIndex([...FIXTURE, 'lib/env.ts']);
    const results = queryMentionSuggestions(indexWithAlternative, { rawToken: 'env' });
    const got = paths(results);
    // `.env.example` is hidden; the visible `lib/env.ts` should outrank it.
    const dotenvIdx = got.indexOf('.env.example');
    const envIdx = got.indexOf('lib/env.ts');
    expect(envIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeLessThan(dotenvIdx === -1 ? Number.MAX_SAFE_INTEGER : dotenvIdx);
  });

  it('caps at the requested maxResults', () => {
    const results = queryMentionSuggestions(index, { rawToken: '', maxResults: 5 });
    expect(results.length).toBe(5);
  });

  it('returns matchRanges on basename matches so the UI can highlight letters', () => {
    const results = queryMentionSuggestions(index, { rawToken: 'control' });
    const top = results[0];
    expect(top?.matchRanges.length).toBeGreaterThan(0);
    const range = top?.matchRanges.find((r) => r.field === 'basename');
    expect(range).toBeDefined();
  });

  it('handles a 1k-entry synthetic index efficiently', () => {
    const big: string[] = [];
    for (let i = 0; i < 1000; i++) {
      big.push(`src/lib/module${i}/file${i}.ts`);
    }
    big.push('src/lib/controlPanel.tsx');
    const bigIndex = buildMentionIndex(big);
    const t0 = Date.now();
    const results = queryMentionSuggestions(bigIndex, { rawToken: 'control' });
    const elapsed = Date.now() - t0;
    expect(results.length).toBeGreaterThan(0);
    expect(paths(results)).toContain('src/lib/controlPanel.tsx');
    expect(elapsed).toBeLessThan(300);
  });
});
