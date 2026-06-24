import { describe, expect, it } from 'vitest';
import { isHiddenByDefault, isBrowserHiddenByDefault, defaultScannerIgnorePatterns } from '../repo/ignoreDefaults';

describe('ignoreDefaults', () => {
  it('keeps only exact README.md visible while hiding config, setup, test, and generated files', () => {
    expect(isHiddenByDefault('README.md', false)).toBe(false);
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

  it('keeps README.md out of the scanner ignore glob set', () => {
    const patterns = defaultScannerIgnorePatterns();
    expect(patterns.some((pattern) => pattern.includes('README'))).toBe(false);
    expect(patterns).toEqual(expect.arrayContaining(['**/*.config.*', '**/*.d.*', '**/*.test.*', '**/*.spec.*']));
  });

  it('keeps docs folders and document files visible in the Code Space browser', () => {
    expect(isBrowserHiddenByDefault('docs', true)).toBe(false);
    expect(isBrowserHiddenByDefault('documentation', true)).toBe(false);
    expect(isBrowserHiddenByDefault('guide.pdf', false)).toBe(false);
    expect(isBrowserHiddenByDefault('spec.docx', false)).toBe(false);
    expect(isBrowserHiddenByDefault('notes.md', false)).toBe(false);
    expect(isHiddenByDefault('docs', true)).toBe(true);
    expect(isHiddenByDefault('notes.md', false)).toBe(true);
  });
});
