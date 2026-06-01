import { describe, expect, it } from 'vitest';
import { resolveInteractiveShell } from '../ptySessionManager';

describe('resolveInteractiveShell', () => {
  it('returns a shell executable path', () => {
    const shell = resolveInteractiveShell();
    expect(shell.trim().length).toBeGreaterThan(0);
  });
});
