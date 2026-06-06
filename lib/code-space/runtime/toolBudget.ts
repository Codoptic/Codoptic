/**
 * Tool budgeting for the agentic Code loop.
 *
 * Read-only tools are free: the agent should "keep reading, exploring, never
 * exhaust." Only mutating/command tools spend the request's tool budget. A
 * separate hard turn cap stops runaway read-only loops from spinning forever.
 */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_text',
  'repo_map',
  'dependency_trace',
  'git_status',
  'git_diff',
  'research_web',
  'harness_context',
  'scan_code_quality',
  'read_artifact',
  'grep_artifact',
  // Plan-mode terminal tools: they never mutate source files (the artifact is written by the runtime).
  'ask_clarifying_questions',
  'write_plan_artifact',
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export class ToolBudget {
  private mutations = 0;
  private turns = 0;

  constructor(
    private readonly maxMutations: number,
    private readonly maxTurns: number,
  ) {}

  /** Count one model round-trip. */
  recordTurn(): void {
    this.turns += 1;
  }

  /** Charge a tool call. Read-only tools cost nothing. */
  charge(toolName: string): void {
    if (!isReadOnlyTool(toolName)) this.mutations += 1;
  }

  get mutationsUsed(): number {
    return this.mutations;
  }

  get turnsUsed(): number {
    return this.turns;
  }

  get max(): number {
    return this.maxMutations;
  }

  /** Whether the next mutating tool call would exceed the mutation budget. */
  mutationBudgetExhausted(): boolean {
    return this.mutations >= this.maxMutations;
  }

  /** Whether the hard turn cap has been reached. */
  turnsExhausted(): boolean {
    return this.turns >= this.maxTurns;
  }

  /** The loop must stop entirely. */
  exhausted(): boolean {
    return this.turnsExhausted();
  }

  /** Close to a limit — the loop should nudge the model to converge. */
  nearExhaustion(): boolean {
    return this.turns >= this.maxTurns - 2 || this.mutations >= this.maxMutations - 1;
  }
}
