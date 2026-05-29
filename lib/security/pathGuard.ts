import os from 'node:os';
import path from 'node:path';

const FORBIDDEN_PREFIXES = ['/etc', '/var', '/usr', '/bin', '/sbin', '/System', '/Library'];
const FORBIDDEN_NAMES = ['.ssh', '.aws', '.config', '.gnupg'];

export interface PathGuardResult {
  ok: boolean;
  resolved: string;
  reason?: string;
}

export interface BrowsePathResult extends PathGuardResult {
  browseRoot: string;
  prefix: string | null;
}

export function guardPath(input: string, opts: { allowSensitive?: boolean } = {}): PathGuardResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, resolved: '', reason: 'Path is required' };
  }
  let resolved = input;
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  resolved = path.resolve(resolved);

  if (resolved === '/') {
    return { ok: false, resolved, reason: 'Refusing root directory' };
  }
  if (!opts.allowSensitive) {
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (resolved === prefix || resolved.startsWith(prefix + path.sep)) {
        return { ok: false, resolved, reason: `Path inside ${prefix} is blocked by default` };
      }
    }
    const segments = resolved.split(path.sep).filter(Boolean);
    for (const seg of segments) {
      if (FORBIDDEN_NAMES.includes(seg)) {
        return { ok: false, resolved, reason: `Path contains sensitive segment "${seg}"` };
      }
    }
    if (segments.length < 2) {
      return { ok: false, resolved, reason: 'Path is too shallow' };
    }
  }
  return { ok: true, resolved };
}

// Motivation vs Logic: the folder browser needs a safe way to interpret trailing `~` as a
// sibling-prefix search without teaching every caller how to split/guard the path on its own.
// We keep the exact-path guard unchanged and add this narrow resolver so browse and scan logic
// can share one interpretation at the edge.
export function resolveBrowsePath(input: string, opts: { allowSensitive?: boolean } = {}): BrowsePathResult {
  if (!input || typeof input !== 'string') {
    return { ok: false, resolved: '', browseRoot: '', prefix: null, reason: 'Path is required' };
  }

  const trimmed = input.trim();
  const isPrefixSearch = trimmed.endsWith('~');
  const candidate = isPrefixSearch ? trimmed.slice(0, -1) : trimmed;
  const guard = guardPath(candidate, opts);
  if (!guard.ok) {
    return { ok: false, resolved: guard.resolved, browseRoot: '', prefix: null, reason: guard.reason };
  }

  if (!isPrefixSearch) {
    return { ok: true, resolved: guard.resolved, browseRoot: guard.resolved, prefix: null };
  }

  const browseRootCandidate = path.dirname(guard.resolved);
  const browseRootGuard = guardPath(browseRootCandidate, opts);
  if (!browseRootGuard.ok) {
    return {
      ok: false,
      resolved: guard.resolved,
      browseRoot: browseRootGuard.resolved,
      prefix: null,
      reason: browseRootGuard.reason,
    };
  }

  return {
    ok: true,
    resolved: guard.resolved,
    browseRoot: browseRootGuard.resolved,
    prefix: path.basename(guard.resolved),
  };
}

export function defaultRepoPath(): string {
  if (process.env.CODOPTIC_DEFAULT_REPO_PATH) {
    return process.env.CODOPTIC_DEFAULT_REPO_PATH;
  }
  return path.resolve(process.cwd(), '..');
}
