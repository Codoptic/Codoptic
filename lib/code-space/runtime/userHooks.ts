export type UserHookEvent = 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'Stop';

export interface UserHookDecision {
  block: boolean;
  reason?: string;
}

export interface UserHooksConfig {
  hooks?: Partial<Record<UserHookEvent, Array<{ command?: string }>>>;
}

export function evaluateUserHook(config: UserHooksConfig | undefined, event: UserHookEvent): UserHookDecision {
  const hooks = config?.hooks?.[event] ?? [];
  if (!hooks.length) return { block: false };
  const blocked = hooks.find((hook) => hook.command === 'block');
  if (blocked) return { block: true, reason: `${event} hook blocked this action.` };
  return { block: false, reason: `${event} hooks registered: ${hooks.length}` };
}

export async function loadUserHooks(root: string): Promise<UserHooksConfig> {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  try {
    const raw = await fs.readFile(path.join(root, '.agent', 'hooks.json'), 'utf8');
    return JSON.parse(raw) as UserHooksConfig;
  } catch {
    return {};
  }
}
