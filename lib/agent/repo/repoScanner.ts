import fg from 'fast-glob';
import ignore from 'ignore';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultScannerIgnorePatterns, DOCUMENTATION_EXTENSIONS } from './ignoreDefaults';

// Motivation vs Logic: the canonical "skip" list lives in `ignoreDefaults.ts` so the folder
// browser and the scanner stay in lock-step. We keep a few scanner-specific extras here for
// security-sensitive patterns (credentials, source-maps, minified assets) that have no reason to
// surface in either view.
const DEFAULT_IGNORE = [
  ...defaultScannerIgnorePatterns(),
  '**/*.min.js',
  '**/*.min.css',
  '**/*.lock',
  '**/*.pem',
  '**/*.key',
  '**/*.crt',
  '**/diagram.png',
  '**/diagram.svg',
];

// Motivation vs Logic: prefix globs such as `**/setup.*` and `**/LICENSE*` can still swallow
// documentation files. A second harvest reads markdown/rst/adoc with only build/cache ignores so
// those patterns cannot hide mandatory docs.
const DOCUMENTATION_GLOBS = ['**/*.{md,mdx,rst,adoc}'];
const DOCUMENTATION_SAFE_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.*/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.codoptic-cache/**',
  '**/vendor/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
];

const MAX_FILE_BYTES = 1024 * 1024; // 1MB

export const AGENT_ALLOWED_EXTENSIONS = [
  'adoc',
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'cxx',
  'go',
  'graphql',
  'gql',
  'h',
  'hpp',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'md',
  'mdx',
  'mjs',
  'php',
  'prisma',
  'py',
  'rb',
  'rs',
  'rst',
  'scala',
  'scss',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
] as const;

// Motivation vs Logic: source plus documentation stay on the readable surface. Docs are
// mandatory priors for coding and diagram generation; named instruction files stay allowed
// even when they use uncommon casings or live outside docs/.
export const AGENT_ALLOWED_FILES = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'INSTRUCTIONS.md',
  'PROJECT_RULES.md',
] as const;

export interface RepoScanAllowlist {
  extensions: readonly string[];
  fileNames: readonly string[];
}

export const AGENT_FILE_ALLOWLIST: RepoScanAllowlist = {
  extensions: AGENT_ALLOWED_EXTENSIONS,
  fileNames: AGENT_ALLOWED_FILES,
};

export interface RepoScanOptions {
  allowlist?: RepoScanAllowlist;
  ignoredFolders?: readonly string[];
}

export interface ScannedFile {
  /** Relative POSIX-style path */
  path: string;
  bytes: number;
  ext: string;
}

export interface RepoMap {
  root: string;
  fileCount: number;
  totalBytes: number;
  byExt: Record<string, number>;
  files: ScannedFile[];
  manifests: ScannedFile[];
  entrypoints: ScannedFile[];
  apiRoutes: ScannedFile[];
  components: ScannedFile[];
  schemas: ScannedFile[];
  configs: ScannedFile[];
  infra: ScannedFile[];
  tests: ScannedFile[];
  docs: ScannedFile[];
  depHints: string[];
  ignoredFolders: string[];
  likelyStack: string[];
}

function classify(file: ScannedFile, map: RepoMap): void {
  const p = file.path.toLowerCase();

  if (/(^|\/)(index|main|app|server)\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/.test(p))
    map.entrypoints.push(file);
  if (/(^|\/)(api|routes|handlers)\//.test(p) && /\.(ts|tsx|js|jsx|py|go)$/.test(p))
    map.apiRoutes.push(file);
  if (/components\/.*\.(tsx|jsx|vue|svelte)$/.test(p)) map.components.push(file);
  if (/(schema|migrations|prisma|models)\//.test(p) || /\.(prisma|sql)$/.test(p))
    map.schemas.push(file);
  if (/(^|\/)(?:tsconfig|vite|webpack|next|tailwind|babel|eslint|prettier|vitest|jest|playwright)/.test(p))
    map.configs.push(file);
  if (
    /(^|\/)(dockerfile|docker-compose|terraform|cloudformation|helm|kustomization|kubernetes)\b/i.test(
      file.path,
    )
  )
    map.infra.push(file);
  if (/(test|spec)\.(ts|tsx|js|jsx|py|go|rb|java)$/.test(p) || /__tests__\//.test(p))
    map.tests.push(file);
  if (isDocumentationFile(p)) map.docs.push(file);
}

function detectStack(map: RepoMap): string[] {
  // Motivation vs Logic: stack hints now come from source evidence only. That lets the agent
  // stay on the code surface even when package/build manifests are intentionally hidden.
  const stack: string[] = [];
  const hasExt = (...exts: string[]): boolean => map.files.some((f) => exts.includes(f.ext));
  const hasPath = (pattern: RegExp): boolean => map.files.some((f) => pattern.test(f.path.toLowerCase()));
  const add = (label: string): void => {
    if (!stack.includes(label)) stack.push(label);
  };

  if (hasExt('js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs')) add('Node.js');
  if (hasExt('ts', 'tsx')) add('TypeScript');
  if (hasExt('js', 'jsx', 'mjs', 'cjs')) add('JavaScript');
  if (hasExt('tsx', 'jsx') || hasPath(/(^|\/)(components|app|pages|src\/app|src\/pages)\//)) add('React');
  if (
    hasPath(
      /(^|\/)(app|pages)\/.+\/(page|layout|loading|error|not-found|route|middleware)\.(ts|tsx|js|jsx)$/,
    ) ||
    hasPath(/(^|\/)(src\/)?(app|pages)\//)
  )
    add('Next.js');
  if (hasExt('vue')) add('Vue');
  if (hasExt('svelte')) add('Svelte');
  if (hasExt('py')) add('Python');
  if (hasExt('java', 'kt', 'kts')) {
    add('Java');
    if (hasPath(/(^|\/)src\/main\/java\//) || hasPath(/(^|\/)(controller|service|repository|entity)\.(java|kt)$/))
      add('Spring Boot');
  }
  if (hasExt('cs') || hasPath(/\.sln$/) || hasPath(/\.csproj$/) || hasPath(/\.fsproj$/) || hasPath(/\.vbproj$/)) add('.NET');
  if (hasExt('go')) add('Go');
  if (hasExt('rs')) add('Rust');
  if (hasExt('rb')) add('Ruby');
  if (hasExt('php')) add('PHP');
  if (hasPath(/prisma/)) add('Prisma');
  if (hasPath(/\.component\.ts$/) || hasPath(/\.module\.ts$/) || hasPath(/\.service\.ts$/)) add('Angular');

  return stack;
}

async function readGitignore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  try {
    const txt = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    ig.add(txt);
  } catch {
    /* no .gitignore */
  }
  return ig;
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

export function normalizeIgnoredFolders(folders: readonly string[] = []): string[] {
  const normalized = new Set<string>();
  for (const folder of folders) {
    const cleaned = folder
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .trim();
    if (!cleaned || cleaned === '.' || cleaned.startsWith('../') || cleaned.includes('/../')) continue;
    normalized.add(cleaned);
  }
  return [...normalized].sort((a, b) => a.localeCompare(b));
}

// Motivation vs Logic: users can now ignore individual files in addition to folders, but the
// store still keeps a flat string[] for backwards compatibility. We emit both a literal pattern
// (matches a single file or the folder name itself) and a `/**` pattern (matches folder contents)
// so fast-glob filters both cases without us tracking whether the entry was a file or directory.
function ignoredFolderPatterns(folders: readonly string[]): string[] {
  const patterns: string[] = [];
  for (const folder of normalizeIgnoredFolders(folders)) {
    patterns.push(folder);
    patterns.push(`${folder}/**`);
  }
  return patterns;
}

const DOC_EXTENSIONS = new Set(DOCUMENTATION_EXTENSIONS.map((ext) => ext.replace(/^\./, '')));

function isDocumentationFile(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').toLowerCase();
  const ext = normalizeExt(path.extname(normalized));
  if (DOC_EXTENSIONS.has(ext)) return true;
  return /(^|\/)(docs?|documentation)\//.test(normalized) && ext === 'txt';
}

function isAllowedByAllowlist(rel: string, allowlist: RepoScanAllowlist): boolean {
  // Motivation vs Logic: later stages should read source plus documentation, but still cannot
  // accidentally ingest screenshots, cached summaries, or test fixtures just because they share
  // a folder with source.
  const normalizedRel = rel.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(normalizedRel);
  const allowedFiles = new Set(allowlist.fileNames.map((name) => name.replace(/\\/g, '/').toLowerCase()));
  if (allowedFiles.has(normalizedRel) || allowedFiles.has(basename)) return true;
  if (isDocumentationFile(normalizedRel)) return true;

  const ext = normalizeExt(path.extname(rel).slice(1));
  if (!ext) return false;
  return new Set(allowlist.extensions.map(normalizeExt)).has(ext);
}

export async function scanRepo(root: string, opts: RepoScanOptions = {}): Promise<RepoMap> {
  const ig = await readGitignore(root);
  const allowlist = opts.allowlist ?? AGENT_FILE_ALLOWLIST;
  const ignorePatterns = [...DEFAULT_IGNORE, ...ignoredFolderPatterns(opts.ignoredFolders ?? [])];

  const entries = await fg('**/*', {
    cwd: root,
    dot: false,
    onlyFiles: true,
    ignore: ignorePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  const documentation = await fg(DOCUMENTATION_GLOBS, {
    cwd: root,
    dot: false,
    onlyFiles: true,
    ignore: [...DOCUMENTATION_SAFE_IGNORE, ...ignoredFolderPatterns(opts.ignoredFolders ?? [])],
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  const merged = [...new Set([...entries, ...documentation])];

  const filtered = merged.filter((p) => !ig.ignores(p) && isAllowedByAllowlist(p, allowlist));

  const map: RepoMap = {
    root,
    fileCount: 0,
    totalBytes: 0,
    byExt: {},
    files: [],
    manifests: [],
    entrypoints: [],
    apiRoutes: [],
    components: [],
    schemas: [],
    configs: [],
    infra: [],
    tests: [],
    docs: [],
    depHints: [],
    ignoredFolders: ignorePatterns,
    likelyStack: [],
  };

  for (const rel of filtered) {
    const abs = path.join(root, rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const ext = path.extname(rel).slice(1).toLowerCase();
      const file: ScannedFile = { path: rel.replace(/\\/g, '/'), bytes: stat.size, ext };
      map.files.push(file);
      map.fileCount++;
      map.totalBytes += stat.size;
      map.byExt[ext] = (map.byExt[ext] ?? 0) + 1;
      classify(file, map);
    } catch {
      /* unreadable */
    }
  }

  // Root Cause vs Logic: dependency manifests are now intentionally excluded from the readable
  // surface, so dependency hints are left empty and stack detection derives from source files.
  map.likelyStack = detectStack(map);
  return map;
}

/** Read a file from a scanned repo, truncated to maxBytes if needed. */
export async function readRepoFile(root: string, rel: string, maxBytes = 64_000): Promise<string> {
  const buf = await fs.readFile(path.join(root, rel));
  if (buf.length <= maxBytes) return buf.toString('utf8');
  return buf.subarray(0, maxBytes).toString('utf8') + `\n\n// …truncated (${buf.length - maxBytes} bytes)`;
}
