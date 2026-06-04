import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Code Space agent route delegation', () => {
  it('is a thin transport adapter and delegates orchestration to AgentRuntime', async () => {
    const [agentSource, validateSource] = await Promise.all([
      readFile(path.join(process.cwd(), 'app/api/code-space/agent/route.ts'), 'utf8'),
      readFile(path.join(process.cwd(), 'app/api/code-space/runs/validate/route.ts'), 'utf8'),
    ]);

    for (const source of [agentSource, validateSource]) {
      expect(source).toContain('new AgentRuntime()');
      expect(source).toContain('terminalEventSeen');
      expect(source).toContain('ended without a terminal completion event');
      expect(source).not.toContain('function detectValidationCommands');
      expect(source).not.toContain('function runValidationCommands');
      expect(source).not.toContain('function applyGeneratedPatch');
      expect(source).not.toContain('function proposeAutonomousPatch');
      expect(source).not.toContain('function expandContextWithCodeIntelligence');
    }
  });
});
