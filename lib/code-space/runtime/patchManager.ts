export interface PatchProposalFileInput {
  path: string;
  beforeContent: string;
  afterContent: string;
  existedBefore?: boolean;
  deleted?: boolean;
}

export interface PatchProposal {
  id: string;
  runId: string;
  projectId: string;
  status: 'proposed' | 'validated' | 'applied' | 'rejected' | 'failed';
  explanation: string;
  filesChanged: string[];
  files: PatchProposalFileInput[];
  diff: string;
  additions: number;
  deletions: number;
  createdAt: number;
}

export interface DiffHunk {
  filePath: string;
  header: string;
  patch: string;
}

function lines(content: string): string[] {
  if (!content) return [];
  const parts = content.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function createUnifiedFileDiff(file: PatchProposalFileInput): { diff: string; additions: number; deletions: number } {
  const before = lines(file.beforeContent);
  const after = file.deleted ? [] : lines(file.afterContent);
  const max = Math.max(before.length, after.length);
  const out = [`--- a/${file.path}`, `+++ b/${file.path}`, `@@ -1,${before.length} +1,${after.length} @@`];
  let additions = 0;
  let deletions = 0;

  for (let index = 0; index < max; index += 1) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine && oldLine !== undefined) {
      out.push(` ${oldLine}`);
      continue;
    }
    if (oldLine !== undefined) {
      out.push(`-${oldLine}`);
      deletions += 1;
    }
    if (newLine !== undefined) {
      out.push(`+${newLine}`);
      additions += 1;
    }
  }

  return { diff: `${out.join('\n')}\n`, additions, deletions };
}

export function createPatchProposal({
  id,
  runId,
  projectId,
  explanation,
  files,
  createdAt = Date.now(),
}: {
  id: string;
  runId: string;
  projectId: string;
  explanation: string;
  files: PatchProposalFileInput[];
  createdAt?: number;
}): PatchProposal {
  const fileDiffs = files.map(createUnifiedFileDiff);
  return {
    id,
    runId,
    projectId,
    status: 'proposed',
    explanation,
    filesChanged: files.map((file) => file.path),
    files,
    diff: fileDiffs.map((item) => item.diff).join('\n'),
    additions: fileDiffs.reduce((sum, item) => sum + item.additions, 0),
    deletions: fileDiffs.reduce((sum, item) => sum + item.deletions, 0),
    createdAt,
  };
}

export function splitDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const fileBlocks = diff.split(/\n(?=--- a\/)/).filter(Boolean);
  for (const block of fileBlocks) {
    const filePath = block.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const header = block.match(/^@@ .+ @@$/m)?.[0] ?? '@@';
    if (!filePath) continue;
    hunks.push({ filePath, header, patch: block.endsWith('\n') ? block : `${block}\n` });
  }
  return hunks;
}
