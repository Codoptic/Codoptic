import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeReadTextFile } from './repoMap';

export interface LoadedInstruction {
  path: string;
  precedence: number;
  summary: string;
  content: string;
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'INSTRUCTIONS.md', 'PROJECT_RULES.md', 'README.md'];
const SKILLS_DIR = '.agent/skills';
const INSTRUCTION_PATH_PREVIEW_LIMIT = 2800;

export class InstructionLoader {
  async loadProjectInstructions(root: string, explicitPlanPath?: string | null): Promise<LoadedInstruction[]> {
    const loaded: LoadedInstruction[] = [];
    if (explicitPlanPath) {
      const content = await safeReadTextFile(root, explicitPlanPath);
      if (content) loaded.push(toInstruction(explicitPlanPath, 2, content));
    }
    for (const [index, file] of INSTRUCTION_FILES.entries()) {
      const content = await safeReadTextFile(root, file);
      if (content) loaded.push(toInstruction(file, 3 + index, content));
    }
    // Project-provided Superpowers-style skill docs (layered under the built-in skill kernel).
    for (const skill of await listSkillFiles(root)) {
      const content = await safeReadTextFile(root, skill);
      if (content) loaded.push(toInstruction(skill, 9, content));
    }
    return loaded;
  }
}

async function listSkillFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(root, SKILLS_DIR), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => `${SKILLS_DIR}/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

function toInstruction(path: string, precedence: number, content: string): LoadedInstruction {
  const redacted = redactSecrets(content.slice(0, 20_000));
  const summary = redacted.split(/\r?\n/).find((line) => line.trim())?.slice(0, 220) ?? 'Project instruction file';
  return {
    path: formatInstructionPayload(path, redacted),
    precedence,
    content: redacted,
    summary,
  };
}

function formatInstructionPayload(path: string, content: string): string {
  const normalized = content.replace(/\s+$/gm, '').trim();
  const preview = normalized.length > INSTRUCTION_PATH_PREVIEW_LIMIT ? `${normalized.slice(0, INSTRUCTION_PATH_PREVIEW_LIMIT)}\n[TRUNCATED]` : normalized;
  return `${path}\n${preview}`;
}

function redactSecrets(content: string): string {
  return content
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)=\S+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[a-z0-9_-]{12,}|ghp_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi, '[REDACTED]');
}
