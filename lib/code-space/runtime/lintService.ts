export interface LintDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
  rule?: string;
}

export function parseLintOutput(output: string, fallbackPath = 'unknown'): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const pattern = /([^:\s]+):(\d+):(\d+):\s+(error|warning|err|warn)\s+(.+)/gi;
  for (const match of output.matchAll(pattern)) {
    diagnostics.push({
      file: match[1] || fallbackPath,
      line: Number(match[2]),
      col: Number(match[3]),
      severity: /warn/i.test(match[4] ?? '') ? 'warning' : 'error',
      message: match[5]?.trim() || 'lint issue',
    });
  }
  return diagnostics;
}

export async function readLintsForFiles(
  files: string[],
  output?: string,
): Promise<LintDiagnostic[]> {
  if (output) return parseLintOutput(output).filter((item) => !files.length || files.some((file) => item.file.includes(file) || file.includes(item.file)));
  return [];
}
