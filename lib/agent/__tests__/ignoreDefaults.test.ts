import { describe, expect, it } from 'vitest';
import { isHiddenByDefault, isBrowserHiddenByDefault, defaultScannerIgnorePatterns } from '../repo/ignoreDefaults';

describe('ignoreDefaults', () => {
  it('keeps documentation and instruction files visible while hiding config, setup, test, and generated files', () => {
    expect(isHiddenByDefault('README.md', false)).toBe(false);
    expect(isHiddenByDefault('AGENTS.md', false)).toBe(false);
    expect(isHiddenByDefault('CHANGELOG.md', false)).toBe(false);
    expect(isHiddenByDefault('LICENSE.md', false)).toBe(false);
    expect(isHiddenByDefault('CONTRIBUTING.md', false)).toBe(false);
    expect(isHiddenByDefault('setup.md', false)).toBe(false);
    expect(isHiddenByDefault('notes.md', false)).toBe(false);
    expect(isHiddenByDefault('guide.mdx', false)).toBe(false);
    expect(isHiddenByDefault('guide.rst', false)).toBe(false);
    expect(isHiddenByDefault('guide.adoc', false)).toBe(false);
    expect(isHiddenByDefault('docs', true)).toBe(false);
    expect(isHiddenByDefault('doc', true)).toBe(false);
    expect(isHiddenByDefault('documentation', true)).toBe(false);
    expect(isHiddenByDefault('README.txt', false)).toBe(true);
    expect(isHiddenByDefault('eslint.config.mjs', false)).toBe(true);
    expect(isHiddenByDefault('next.config.ts', false)).toBe(true);
    expect(isHiddenByDefault('postcss.config.mjs', false)).toBe(true);
    expect(isHiddenByDefault('tailwind.config.ts', false)).toBe(true);
    expect(isHiddenByDefault('next-auth.d.ts', false)).toBe(true);
    expect(isHiddenByDefault('setup.sh', false)).toBe(true);
    expect(isHiddenByDefault('seed.ts', false)).toBe(true);
    expect(isHiddenByDefault('app.test.ts', false)).toBe(true);
    expect(isHiddenByDefault('app.spec.ts', false)).toBe(true);
    expect(isHiddenByDefault('app.generated.cs', false)).toBe(true);
    expect(isHiddenByDefault('Program.g.cs', false)).toBe(true);
    expect(isHiddenByDefault('public', true)).toBe(true);
    expect(isHiddenByDefault('.vscode', true)).toBe(true);
  });

  it('does not ignore documentation folders or markdown in the scanner glob set', () => {
    const patterns = defaultScannerIgnorePatterns();
    expect(patterns).not.toContain('**/docs');
    expect(patterns).not.toContain('**/docs/**');
    expect(patterns).not.toContain('**/doc');
    expect(patterns).not.toContain('**/documentation');
    expect(patterns).not.toContain('**/*.md');
    expect(patterns).not.toContain('**/*.mdx');
    expect(patterns).not.toContain('**/*.rst');
    expect(patterns).not.toContain('**/*.adoc');
    expect(patterns.some((pattern) => pattern.includes('README'))).toBe(false);
    expect(patterns.some((pattern) => pattern.includes('AGENTS'))).toBe(false);
    expect(patterns.some((pattern) => /CHANGELOG|LICENSE|CONTRIBUTING/i.test(pattern))).toBe(false);
    expect(patterns).toEqual(expect.arrayContaining(['**/*.config.*', '**/*.d.*', '**/*.test.*', '**/*.spec.*']));
  });

  it('keeps docs folders and document files visible in the Code Space browser', () => {
    expect(isBrowserHiddenByDefault('docs', true)).toBe(false);
    expect(isBrowserHiddenByDefault('documentation', true)).toBe(false);
    expect(isBrowserHiddenByDefault('guide.pdf', false)).toBe(false);
    expect(isBrowserHiddenByDefault('spec.docx', false)).toBe(false);
    expect(isBrowserHiddenByDefault('notes.md', false)).toBe(false);
    expect(isHiddenByDefault('docs', true)).toBe(false);
    expect(isHiddenByDefault('notes.md', false)).toBe(false);
  });
});
