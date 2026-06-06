import { describe, expect, it } from 'vitest';
import { createDefaultToolRegistry } from '../toolRegistry';

describe('createDefaultToolRegistry', () => {
  it('registers safe read tools and approval-gated risky tools', () => {
    const registry = createDefaultToolRegistry();

    expect(registry.get('read_file')?.riskLevel).toBe('safe');
    expect(registry.get('search_text')?.permission).toBe('auto');
    expect(registry.get('apply_patch')?.riskLevel).toBe('medium');
    expect(registry.get('run_command')?.permission).toBe('approval_required');
  });

  it('registers external agent tooling with appropriate risk levels', () => {
    const registry = createDefaultToolRegistry();

    expect(registry.get('research_web')?.riskLevel).toBe('safe');
    expect(registry.get('harness_context')?.permission).toBe('auto');
    expect(registry.get('scan_code_quality')?.logPolicy).toBe('redacted');
    expect(registry.get('run_validation_matrix')?.riskLevel).toBe('medium');
  });

  it('describes comprehensive shell exploration through run_command', () => {
    const runCommand = createDefaultToolRegistry().get('run_command');

    expect(runCommand?.inputSchema.properties).toHaveProperty('cwd');
    expect(runCommand?.inputSchema.properties).toHaveProperty('timeoutMs');
    expect(runCommand?.description).toContain('grep');
    expect(runCommand?.description).toContain('ls');
    expect(runCommand?.description).toContain('npm');
    expect(runCommand?.description).toContain('python3');
    expect(runCommand?.description).toContain('mkdir');
    expect(runCommand?.description).toContain('rm');
  });

  it('exposes JSON schemas for model/tool callers', () => {
    const registry = createDefaultToolRegistry();
    const schemas = registry.list().map((tool) => tool.inputSchema);

    expect(schemas.length).toBeGreaterThan(4);
    expect(schemas.every((schema) => schema.type === 'object')).toBe(true);
  });
});
