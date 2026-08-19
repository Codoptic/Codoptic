import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface EnvironmentContract {
  install?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
  start?: string;
  secretNames?: string[];
}

export async function loadEnvironmentContract(root: string): Promise<EnvironmentContract | null> {
  try {
    const raw = await fs.readFile(path.join(root, '.agent', 'environment.json'), 'utf8');
    return JSON.parse(raw) as EnvironmentContract;
  } catch {
    return null;
  }
}

export async function writeEnvironmentContract(root: string, contract: EnvironmentContract): Promise<string> {
  const filePath = path.join(root, '.agent', 'environment.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return '.agent/environment.json';
}

export function inferEnvironmentContract(scripts: Record<string, string> = {}): EnvironmentContract {
  return {
    install: 'npm install',
    test: scripts.test ? 'npm run test' : undefined,
    lint: scripts.lint ? 'npm run lint' : undefined,
    typecheck: scripts.typecheck ? 'npm run typecheck' : undefined,
    start: scripts.dev || scripts.start,
    secretNames: [],
  };
}
