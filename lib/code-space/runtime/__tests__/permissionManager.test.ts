import { describe, expect, it } from 'vitest';
import { PermissionManager } from '../permissionManager';
import { createDefaultToolRegistry } from '../toolRegistry';

describe('PermissionManager', () => {
  it('allows safe reads but gates risky tools in approval-required autonomy', () => {
    const permissions = new PermissionManager();
    const registry = createDefaultToolRegistry();

    expect(permissions.decide(registry.get('read_file')!, 'approval_required')).toMatchObject({
      permission: 'auto',
      approvalRequired: false,
    });
    expect(permissions.decide(registry.get('run_command')!, 'approval_required')).toMatchObject({
      permission: 'approval_required',
      approvalRequired: true,
    });
  });

  it('allows safe read-only tools but blocks mutating tools in suggest-only mode', () => {
    const permissions = new PermissionManager();
    const registry = createDefaultToolRegistry();

    expect(permissions.decide(registry.get('read_file')!, 'suggest_only')).toMatchObject({
      permission: 'auto',
      approvalRequired: false,
    });
    expect(permissions.decide(registry.get('harness_context')!, 'suggest_only')).toMatchObject({
      permission: 'auto',
      approvalRequired: false,
    });
    expect(permissions.decide(registry.get('edit_file')!, 'suggest_only')).toMatchObject({
      permission: 'approval_required',
      approvalRequired: true,
    });
    expect(permissions.decide(registry.get('run_command')!, 'suggest_only')).toMatchObject({
      permission: 'blocked',
      approvalRequired: false,
    });
  });

  it('lets sandbox autonomy run shell exploration while still gating risky commands', () => {
    const permissions = new PermissionManager();
    const registry = createDefaultToolRegistry();

    expect(permissions.decide(registry.get('run_command')!, 'sandbox_autonomy')).toMatchObject({
      permission: 'auto',
      approvalRequired: false,
    });
    expect(permissions.decide(registry.get('apply_patch')!, 'sandbox_autonomy')).toMatchObject({
      permission: 'auto',
      approvalRequired: false,
    });
  });
});
