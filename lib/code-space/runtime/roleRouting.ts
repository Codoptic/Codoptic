export type AgentRoleLane = 'explore' | 'implement' | 'critic' | 'plan';

export function modelForRole(role: AgentRoleLane, frontierModel: string, cheapModel?: string): string {
  if ((role === 'explore' || role === 'plan') && cheapModel) return cheapModel;
  return frontierModel;
}

export function shouldSwitchModel(atCompact: boolean): boolean {
  return atCompact;
}

export function buildAdvisorPacket(input: {
  goal: string;
  recentTools: string[];
  failingTests: string[];
}): string {
  return [
    `Goal: ${input.goal}`,
    `Recent tools: ${input.recentTools.slice(-8).join(', ') || 'none'}`,
    `Failing tests: ${input.failingTests.slice(-6).join(' | ') || 'none'}`,
    'Advise only. Do not request the full writer transcript.',
  ].join('\n');
}
