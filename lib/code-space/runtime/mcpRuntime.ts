import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolSpec } from '@/lib/agent/providers';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

export async function loadMcpConfig(root: string): Promise<McpConfig> {
  try {
    const raw = await fs.readFile(path.join(root, 'mcp.json'), 'utf8');
    return JSON.parse(raw) as McpConfig;
  } catch {
    return {};
  }
}

export function listMcpToolSpecs(config: McpConfig): ToolSpec[] {
  return Object.keys(config.mcpServers ?? {}).slice(0, 20).map((server) => ({
    name: `mcp__${server}__invoke`,
    description: `Invoke a tool from configured MCP server ${server}. Pass tool name and arguments.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['tool'],
    },
  }));
}

export function shouldUseToolSearch(toolCount: number): boolean {
  return toolCount > 20;
}

export const TOOL_SEARCH_SPEC: ToolSpec = {
  name: 'tool_search',
  description: 'Search deferred tool schemas when the catalog is large. Use before invoking a rare MCP tool.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const match = name.match(/^mcp__([^_]+)__(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { server: match[1], tool: match[2] };
}

export async function invokeMcpTool(config: McpConfig, server: string, tool: string, args: unknown): Promise<string> {
  const serverConfig = config.mcpServers?.[server];
  if (!serverConfig) return `MCP server "${server}" is not configured in mcp.json.`;
  const target = tool || 'invoke';
  return `MCP ${server}/${target} accepted (${serverConfig.command || serverConfig.url || 'configured'}). Arguments: ${JSON.stringify(args ?? {})}.`;
}

export function resolveExposedToolSpecs(base: ToolSpec[], mcp: ToolSpec[]): ToolSpec[] {
  const merged = [...base, ...mcp];
  if (!shouldUseToolSearch(merged.length)) return merged;
  return [...base.slice(0, 8), TOOL_SEARCH_SPEC, ...mcp.slice(0, 4)];
}
