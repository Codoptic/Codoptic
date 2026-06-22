import type { AutonomyLevel } from '@/lib/code-space/domain';
import type { RuntimeToolDefinition, ToolPermission } from './toolRegistry';
import {
  canRegistryToolAutoRunUnderSuggestOnly,
  isSuggestOnlyProposeRegistryTool,
} from './autonomyPolicy';

export interface PermissionDecision {
  permission: ToolPermission;
  approvalRequired: boolean;
  reason: string;
}

export class PermissionManager {
  decide(tool: RuntimeToolDefinition, autonomy: AutonomyLevel): PermissionDecision {
    if (tool.permission === 'blocked' || tool.riskLevel === 'blocked') {
      return { permission: 'blocked', approvalRequired: false, reason: 'Tool is blocked by policy.' };
    }
    if (autonomy === 'suggest_only') {
      // Root Cause vs Logic: suggest_only blocked every tool, including safe read-only helpers like
      // harness_context, so Confirm-mode runs could not inspect the repo and falsely reported an
      // external policy deadlock. Allow read-only inspection + propose-only edits; gate mutations.
      if (canRegistryToolAutoRunUnderSuggestOnly(tool.name, tool.riskLevel)) {
        if (isSuggestOnlyProposeRegistryTool(tool.name)) {
          return {
            permission: 'approval_required',
            approvalRequired: true,
            reason: 'Suggest-only proposes edits for review without writing to disk.',
          };
        }
        return {
          permission: 'auto',
          approvalRequired: false,
          reason: 'Suggest-only allows read-only inspection tools.',
        };
      }
      return {
        permission: 'blocked',
        approvalRequired: false,
        reason: 'Suggest-only mode forbids mutating tool execution.',
      };
    }
    if (autonomy === 'approval_required') {
      return {
        permission: tool.riskLevel === 'safe' ? 'auto' : 'approval_required',
        approvalRequired: tool.riskLevel !== 'safe',
        reason: tool.riskLevel === 'safe' ? 'Safe read-only tool.' : 'Approval-required autonomy gates non-safe tools.',
      };
    }
    if (autonomy === 'auto_safe_tools') {
      const safe = tool.riskLevel === 'safe' || tool.riskLevel === 'medium';
      return {
        permission: safe ? 'auto' : 'approval_required',
        approvalRequired: !safe,
        reason: safe ? 'Safe or medium-risk tool allowed.' : 'High-risk tool requires approval.',
      };
    }
    if (autonomy === 'sandbox_autonomy') {
      return {
        permission: tool.riskLevel === 'high' ? 'approval_required' : 'auto',
        approvalRequired: tool.riskLevel === 'high',
        reason: tool.riskLevel === 'high' ? 'High-risk actions still require approval.' : 'Sandbox autonomy allows this tool.',
      };
    }
    if (autonomy === 'full_access_local') {
      return {
        permission: 'auto',
        approvalRequired: false,
        reason: 'Full local access allows this trusted-workspace tool.',
      };
    }
    return { permission: tool.permission, approvalRequired: tool.permission === 'approval_required', reason: 'Organization policy defers to tool metadata.' };
  }
}
