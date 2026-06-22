export type ToolRiskLevel = 'safe' | 'medium' | 'high' | 'blocked';
export type ToolPermission = 'auto' | 'approval_required' | 'blocked';

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  outputSchema?: Record<string, unknown>;
  riskLevel: ToolRiskLevel;
  permission: ToolPermission;
  timeoutMs: number;
  retryPolicy: {
    retries: number;
    retryableErrors: string[];
  };
  cancellable: boolean;
  logPolicy: 'full' | 'summary' | 'redacted';
  secretRedaction: boolean;
  observationCompression: 'none' | 'truncate' | 'summarize';
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeToolDefinition>();

  register(tool: RuntimeToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): RuntimeToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): RuntimeToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): RuntimeToolDefinition['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

function baseTool(
  tool: Pick<RuntimeToolDefinition, 'name' | 'description' | 'inputSchema' | 'riskLevel' | 'permission'> &
    Partial<Omit<RuntimeToolDefinition, 'name' | 'description' | 'inputSchema' | 'riskLevel' | 'permission'>>,
): RuntimeToolDefinition {
  return {
    timeoutMs: 30_000,
    retryPolicy: { retries: 0, retryableErrors: [] },
    cancellable: true,
    logPolicy: 'summary',
    secretRedaction: true,
    observationCompression: 'truncate',
    ...tool,
  };
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    baseTool({
      name: 'repo_map',
      description: 'Map repository files, top directories, key configuration files, languages, frameworks, package manager, scripts, and validation surfaces before planning edits.',
      inputSchema: objectSchema({ depth: { type: 'number' }, includeHidden: { type: 'boolean' } }),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'list_files',
      description: 'List project files and folders inside the active workspace.',
      inputSchema: objectSchema({ path: { type: 'string' }, recursive: { type: 'boolean' } }),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'read_file',
      description: 'Read a text file from the active workspace. Agents must read a file before proposing changes to it.',
      inputSchema: objectSchema({ path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, ['path']),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'search_text',
      description: 'Search text across files in the active workspace, returning match locations and nearby context. Use this before refactors to find file names, imports, exports, call sites, and other references that must be updated.',
      inputSchema: objectSchema({ query: { type: 'string' }, glob: { type: 'string' }, contextLines: { type: 'number' } }, ['query']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'dependency_trace',
      description: 'Trace imports, exports, related files, and unresolved edges around selected implementation surfaces. Use this after a file move or rename to find every importer, re-export, and downstream usage that needs repair.',
      inputSchema: objectSchema({ paths: { type: 'array', items: { type: 'string' } }, direction: { type: 'string' } }, ['paths']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'validation_strategy',
      description: 'Detect typecheck, lint, test, build, format, and preview commands for the current stack before implementation starts.',
      inputSchema: objectSchema({ changedPaths: { type: 'array', items: { type: 'string' } } }),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'risk_assessment',
      description: 'Classify edit risk, blast radius, approval gates, rollback expectations, and validation requirements.',
      inputSchema: objectSchema({ intents: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } } }),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'git_status',
      description: 'Read git branch and changed-file state.',
      inputSchema: objectSchema({}),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'git_diff',
      description: 'Read the current workspace diff.',
      inputSchema: objectSchema({ path: { type: 'string' } }),
      riskLevel: 'safe',
      permission: 'auto',
    }),
  );
  registry.register(
    baseTool({
      name: 'research_web',
      description: 'Fetch and summarize current web pages or GitHub repository metadata for up-to-date documentation, best practices, and OSS project research. Network use is explicit and opt-in.',
      inputSchema: objectSchema({
        queries: { type: 'array', items: { type: 'string' } },
        urls: { type: 'array', items: { type: 'string' } },
        githubRepo: { type: 'string' },
        useBrowser: { type: 'boolean' },
        maxResults: { type: 'number' },
        maxChars: { type: 'number' },
      }),
      riskLevel: 'safe',
      permission: 'auto',
      timeoutMs: 90_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'harness_context',
      description: 'Audit agent instruction files, pack repository context with Repomix when installed, or fetch versioned library docs with Context7 when installed.',
      inputSchema: objectSchema({
        mode: { type: 'string', enum: ['audit', 'pack', 'docs'] },
        library: { type: 'string' },
        query: { type: 'string' },
        maxChars: { type: 'number' },
      }),
      riskLevel: 'safe',
      permission: 'auto',
      timeoutMs: 120_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'scan_code_quality',
      description: 'Run optional quality scanners for bugs, structural patterns, duplication, and secrets through Semgrep, ast-grep, jscpd/cpd, and Gitleaks when installed.',
      inputSchema: objectSchema({
        mode: { type: 'string', enum: ['all', 'semgrep', 'ast-grep', 'duplication', 'secrets'] },
        pattern: { type: 'string' },
        lang: { type: 'string' },
        maxChars: { type: 'number' },
      }),
      riskLevel: 'safe',
      permission: 'auto',
      timeoutMs: 180_000,
      logPolicy: 'redacted',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'run_validation_matrix',
      description: 'Detect and run stack-specific validation commands across Node, Python, Go, and Rust after implementation work.',
      inputSchema: objectSchema({
        scope: { type: 'string', enum: ['all', 'node', 'python', 'go', 'rust'] },
        changedPaths: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      }),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 240_000,
      logPolicy: 'redacted',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'propose_edit_blocks',
      description: 'Propose exact SEARCH/REPLACE edit blocks. The server exact-matches, rejects ambiguous blocks, syntax-validates, and returns a reviewable diff without writing to disk.',
      inputSchema: objectSchema(
        {
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                search: { type: 'string' },
                replace: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['path', 'search', 'replace', 'reason'],
            },
          },
        },
        ['edits'],
      ),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'propose_patch',
      description: 'Create a reviewable patch proposal with file-level before/after content, unified diff, explanation, and validation intent. Does not write to disk.',
      inputSchema: objectSchema(
        {
          files: { type: 'array', items: { type: 'object' } },
          explanation: { type: 'string' },
          validationCommands: { type: 'array', items: { type: 'string' } },
        },
        ['files', 'explanation'],
      ),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'apply_patch',
      description: 'Apply an approved patch proposal to the active workspace after checkpoint creation and conflict checking.',
      inputSchema: objectSchema({ patchId: { type: 'string' } }, ['patchId']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
    }),
  );
  registry.register(
    baseTool({
      name: 'restore_checkpoint',
      description: 'Restore a previously created checkpoint and rewind all files captured by that checkpoint.',
      inputSchema: objectSchema({ checkpointRef: { type: 'string' }, reason: { type: 'string' } }, ['checkpointRef']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 60_000,
    }),
  );
  registry.register(
    baseTool({
      name: 'run_command',
      description: 'Run terminal commands in the workspace for comprehensive repository exploration, file operations, scripts, and validation. Agents may use grep/rg, find, ls, pwd, cd via cwd, mkdir, cp, mv, rm, touch, git status/diff, npm/pnpm/yarn/bun scripts, python/python3, shell script activation, and stack-specific test/build commands when needed; destructive or network-mutating commands are still detected by terminal policy and require explicit approval.',
      inputSchema: objectSchema(
        {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          reason: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        ['command', 'reason'],
      ),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 120_000,
      logPolicy: 'redacted',
    }),
  );
  for (const tool of [
    {
      name: 'terminal_start',
      description: 'Start an interactive PTY terminal session in the workspace for REPLs, dev servers, prompts, and long-running commands.',
      inputSchema: objectSchema({ cwd: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } }),
    },
    {
      name: 'terminal_write',
      description: 'Write stdin bytes to an existing interactive terminal session.',
      inputSchema: objectSchema({ sessionId: { type: 'string' }, data: { type: 'string' } }, ['sessionId', 'data']),
    },
    {
      name: 'terminal_read',
      description: 'Read buffered output from an interactive terminal session without closing it.',
      inputSchema: objectSchema({ sessionId: { type: 'string' }, maxChars: { type: 'number' }, clear: { type: 'boolean' } }, ['sessionId']),
    },
    {
      name: 'terminal_wait',
      description: 'Wait until a terminal session exits or its output matches a regex pattern.',
      inputSchema: objectSchema({ sessionId: { type: 'string' }, pattern: { type: 'string' }, timeoutMs: { type: 'number' } }, ['sessionId']),
    },
    {
      name: 'terminal_signal',
      description: 'Send SIGINT, SIGTERM, or SIGKILL to an interactive terminal session.',
      inputSchema: objectSchema({ sessionId: { type: 'string' }, signal: { type: 'string' } }, ['sessionId']),
    },
    {
      name: 'terminal_close',
      description: 'Close an interactive terminal session and release the PTY.',
      inputSchema: objectSchema({ sessionId: { type: 'string' } }, ['sessionId']),
    },
  ]) {
    registry.register(
      baseTool({
        ...tool,
        riskLevel: 'medium',
        permission: 'approval_required',
        timeoutMs: 120_000,
        logPolicy: 'redacted',
      }),
    );
  }
  registry.register(
    baseTool({
      name: 'read_artifact',
      description: 'Read a bounded line range from a stored terminal, validation, grep, docs, or large-file artifact instead of injecting the full output into context.',
      inputSchema: objectSchema({ artifactId: { type: 'string' }, path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, ['path', 'startLine', 'endLine']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'grep_artifact',
      description: 'Search inside a stored artifact without loading the full artifact into the agent context.',
      inputSchema: objectSchema({ artifactId: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' }, contextLines: { type: 'number' } }, ['path', 'pattern']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'list_memories',
      description: 'List durable project memory files under /memories. Memory files store user preferences, project context, research notes, and decisions across conversations.',
      inputSchema: objectSchema({}),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'read_memory',
      description: 'Read a durable project memory file from /memories without loading unrelated repository files.',
      inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'none',
    }),
  );
  registry.register(
    baseTool({
      name: 'propose_memory_update',
      description: 'Record a proposed durable memory update. This does not write files; it emits an approval-gated proposal for the user/parent workflow.',
      inputSchema: objectSchema({ path: { type: 'string' }, content: { type: 'string' }, reason: { type: 'string' } }, ['path', 'content', 'reason']),
      riskLevel: 'safe',
      permission: 'auto',
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'spawn_subagent',
      description: 'Spawn an isolated temporary subagent with a blank context window for explorer, critic, docs-reader, test-writer, or verifier roles.',
      inputSchema: objectSchema(
        {
          role: { type: 'string' },
          task: { type: 'string' },
          allowedTools: { type: 'array', items: { type: 'string' } },
          readOnly: { type: 'boolean' },
          maxToolCalls: { type: 'number' },
        },
        ['role', 'task'],
      ),
      riskLevel: 'safe',
      permission: 'auto',
      timeoutMs: 180_000,
      observationCompression: 'summarize',
    }),
  );
  registry.register(
    baseTool({
      name: 'browser_preview_check',
      description: 'Open a browser preview with Playwright, capture console/network output, and persist an initial screenshot artifact for UI validation.',
      inputSchema: objectSchema({ url: { type: 'string' }, scenario: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, ['url', 'scenario']),
      riskLevel: 'medium',
      permission: 'approval_required',
      timeoutMs: 120_000,
      observationCompression: 'summarize',
    }),
  );
  for (const tool of [
    ['browser_open', 'Open a Playwright browser session for a URL and capture an initial screenshot.', { url: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } }, ['url']],
    ['browser_click', 'Click an element in a browser session by selector.', { sessionId: { type: 'string' }, selector: { type: 'string' } }, ['sessionId', 'selector']],
    ['browser_type', 'Fill an input element in a browser session by selector.', { sessionId: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } }, ['sessionId', 'selector', 'text']],
    ['browser_scroll', 'Scroll a browser session by pixel delta.', { sessionId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, ['sessionId']],
    ['browser_screenshot', 'Capture and persist a screenshot artifact from a browser session.', { sessionId: { type: 'string' }, label: { type: 'string' } }, ['sessionId']],
    ['browser_eval', 'Evaluate a bounded JavaScript expression in the page context and return the stringified result.', { sessionId: { type: 'string' }, expression: { type: 'string' } }, ['sessionId', 'expression']],
    ['browser_console', 'Read collected console messages and network errors from a browser session.', { sessionId: { type: 'string' } }, ['sessionId']],
    ['browser_close', 'Close a browser session.', { sessionId: { type: 'string' } }, ['sessionId']],
  ] as const) {
    registry.register(
      baseTool({
        name: tool[0],
        description: tool[1],
        inputSchema: objectSchema(tool[2], [...tool[3]]),
        riskLevel: 'medium',
        permission: 'approval_required',
        timeoutMs: 120_000,
        observationCompression: 'summarize',
      }),
    );
  }

  return registry;
}
