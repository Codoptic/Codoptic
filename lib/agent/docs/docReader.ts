/**
 * Documentation reader — pulls README, agent instruction files, and docs/
 * surfaces as planning priors. These files are mandatory knowledge for coding
 * and diagram generation, not optional scaffolding.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoMap } from '../repo/repoScanner';

export interface DocPrior {
  path: string;
  bytes: number;
  excerpt: string; // first ~6 KB
  kind: 'readme' | 'adr' | 'doc';
}

function classify(p: string): DocPrior['kind'] {
  const lower = p.toLowerCase();
  if (/(^|\/)readme\.mdx?$/.test(lower)) return 'readme';
  if (/(^|\/)(docs\/)?adr[\/_-]/i.test(lower) || /(^|\/)adr[-_]/i.test(lower)) return 'adr';
  return 'doc';
}

const PRIORITY: Array<RegExp> = [
  /^agents\.md$/i,
  /^readme\.md$/i,
  /^docs?\/readme\.md$/i,
  /^docs?\/architecture\.md$/i,
  /^docs?\/code-space\.md$/i,
  /^docs?\/(dsl-grammar|providers|local-setup|generative)\.md$/i,
  /^docs?\//i,
  /(^|\/)docs?\/adr\//i,
  /\.(md|mdx|rst|adoc)$/i,
];

function priorityFor(p: string): number {
  for (let i = 0; i < PRIORITY.length; i++) {
    if (PRIORITY[i]!.test(p)) return i;
  }
  return PRIORITY.length + 1;
}

export async function readDocPriors(repo: RepoMap, maxBytes = 6000, maxDocs = 16): Promise<DocPrior[]> {
  const candidates = repo.docs
    .map((f) => f.path)
    .sort((a, b) => priorityFor(a) - priorityFor(b) || a.localeCompare(b))
    .slice(0, maxDocs);
  const out: DocPrior[] = [];
  for (const rel of candidates) {
    try {
      const buf = await fs.readFile(path.join(repo.root, rel));
      out.push({
        path: rel,
        bytes: buf.length,
        excerpt: buf.subarray(0, maxBytes).toString('utf8'),
        kind: classify(rel),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}
