import { describe, expect, it } from 'vitest';
import {
  classifyCodeSpaceIntent,
  detectCodeSpaceLanguage,
  isCodeSpaceHiddenPath,
  validateFreshStartManifest,
} from '../core';

describe('Code Space core helpers', () => {
  it('detects editor languages from common file extensions', () => {
    expect(detectCodeSpaceLanguage('app/page.tsx')).toBe('typescript');
    expect(detectCodeSpaceLanguage('styles/global.css')).toBe('css');
    expect(detectCodeSpaceLanguage('README.md')).toBe('markdown');
    expect(detectCodeSpaceLanguage('diagram.dsl')).toBe('codoptic');
    expect(detectCodeSpaceLanguage('Dockerfile')).toBe('dockerfile');
  });

  it('hides heavyweight generated folders by default', () => {
    expect(isCodeSpaceHiddenPath('node_modules/react/index.js')).toBe(true);
    expect(isCodeSpaceHiddenPath('.git/config')).toBe(true);
    expect(isCodeSpaceHiddenPath('src/components/Button.tsx')).toBe(false);
  });

  it('shows docs folders and document files in the explorer by default', () => {
    expect(isCodeSpaceHiddenPath('docs', true)).toBe(false);
    expect(isCodeSpaceHiddenPath('docs/guide.pdf')).toBe(false);
    expect(isCodeSpaceHiddenPath('docs/spec.docx')).toBe(false);
    expect(isCodeSpaceHiddenPath('docs/notes.md')).toBe(false);
    expect(isCodeSpaceHiddenPath('documentation/readme.md')).toBe(false);
  });

  it('classifies prompts into workflow intents', () => {
    expect(classifyCodeSpaceIntent('fix the failing build and run tests')).toEqual(
      expect.arrayContaining(['bug_fix', 'debugging/log_analysis', 'validation']),
    );
    expect(classifyCodeSpaceIntent('generate a system diagram for this repo')).toEqual(['system_diagram']);
    expect(classifyCodeSpaceIntent('explain this repository')).toEqual(['repository_explanation']);
  });

  it('validates fresh-start planning zip manifests', () => {
    const valid = validateFreshStartManifest([
      'planning/app-plan.md',
      'dsl/system.dsl',
      'src/components/App.tsx',
    ]);

    expect(valid.ok).toBe(true);
    expect(valid.planningFiles).toEqual(['planning/app-plan.md']);
    expect(valid.dslOrCodeFiles).toEqual(['dsl/system.dsl', 'src/components/App.tsx']);

    const invalid = validateFreshStartManifest(['assets/logo.png', 'notes/readme.txt']);

    expect(invalid.ok).toBe(false);
    expect(invalid.missing).toEqual(['planning/instruction markdown', 'DSL or code files']);
  });
});
