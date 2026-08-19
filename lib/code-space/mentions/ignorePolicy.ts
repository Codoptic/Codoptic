// Motivation vs Logic: The repo-scanner ignore policy in `lib/agent/repo/ignoreDefaults.ts`
// hides build outputs, caches, tests, and config noise, but keeps docs/ and markdown readable.
// The @ mention picker is even more inclusive: drop only generated/binary noise, and keep every
// source folder, source file, and high-value config visible. Binary/media files stay in the
// index (so an exact path match still resolves) but are flagged so the scorer can down-rank them.

/** Folder names that the picker always hides regardless of depth. */
const HARD_HIDDEN_FOLDERS = new Set<string>([
  // JS/TS build & cache outputs
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.parcel-cache',
  '.cache',
  'coverage',
  'playwright-report',
  'test-results',
  '.codoptic-cache',

  // VCS / IDE internals
  '.git',
  '.hg',
  '.svn',
  '.idea',

  // Python / language toolchains and virtualenvs
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  'site-packages',

  // Misc cache / tmp / logs
  'tmp',
  'temp',
]);

/** File basenames that are always excluded (OS noise, build metadata). */
const HARD_HIDDEN_FILES = new Set<string>([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'tsconfig.tsbuildinfo',
]);

/** Lower-cased extensions (with leading dot) the scorer treats as binary/media. */
const BINARY_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.heic',
  '.svg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.xz',
  '.bz2',
  '.iso',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.mkv',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.psd',
  '.ai',
  '.eps',
  '.swf',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.o',
  '.jar',
  '.war',
  '.ear',
  '.pyc',
  '.class',
  '.pdb',
  '.apk',
  '.msi',
  '.dmg',
  '.pkg',
  '.bin',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.map',
]);

const LOCK_FILES = new Set<string>([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Cargo.lock',
]);

/**
 * High-value root project configs and docs that should rank above generic files in `rootBrowse`.
 * Spec calls these out by name (README.md, AGENTS.md, package.json, tsconfig.json, …).
 */
const IMPORTANT_CONFIG_FILES = new Set<string>([
  'README.md',
  'README.MD',
  'AGENTS.md',
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'tailwind.config.ts',
  'tailwind.config.js',
  'postcss.config.js',
  'postcss.config.mjs',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Dockerfile',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'Makefile',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  '.env.example',
  '.env.sample',
  '.gitignore',
  '.editorconfig',
  '.cursorignore',
  '.cursorindexingignore',
  'vercel.json',
  'netlify.toml',
  'turbo.json',
  'eslint.config.js',
  'eslint.config.mjs',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  'playwright.config.ts',
  'vitest.config.ts',
  'jest.config.ts',
  'jest.config.js',
]);

export interface IgnoreSignals {
  isIgnored: boolean;
  isBinary: boolean;
  isLockFile: boolean;
  isImportantConfig: boolean;
  isHidden: boolean;
}

/**
 * Classify a path for the @ mention picker. We only mark something as `isIgnored` when it lives
 * under a hard-hidden folder or is OS-level noise. Hidden dot-paths are flagged with `isHidden`
 * but kept in the index so they're discoverable when the user explicitly types `.foo`.
 */
export function classifyMentionPath(relativePath: string, type: 'file' | 'folder'): IgnoreSignals {
  const segments = relativePath.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] ?? '';
  const lowerBase = basename.toLowerCase();

  let isIgnored = false;
  let isHidden = false;

  for (const segment of segments) {
    if (HARD_HIDDEN_FOLDERS.has(segment)) {
      isIgnored = true;
      break;
    }
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') {
      isHidden = true;
    }
  }

  if (!isIgnored && type === 'file' && HARD_HIDDEN_FILES.has(basename)) {
    isIgnored = true;
  }

  const dotIndex = lowerBase.lastIndexOf('.');
  const ext = dotIndex > 0 ? lowerBase.slice(dotIndex) : '';
  const isBinary = type === 'file' && BINARY_EXTENSIONS.has(ext);
  const isLockFile = type === 'file' && LOCK_FILES.has(basename);
  const isImportantConfig = type === 'file' && IMPORTANT_CONFIG_FILES.has(basename);

  return { isIgnored, isBinary, isLockFile, isImportantConfig, isHidden };
}

/**
 * Glob patterns suitable for fast-glob `ignore`. We mirror `HARD_HIDDEN_FOLDERS` so the
 * server-side scanner never even loads the bytes for those subtrees.
 */
export function pickerIgnoreGlobs(): string[] {
  const patterns: string[] = [];
  for (const folder of HARD_HIDDEN_FOLDERS) {
    patterns.push(`**/${folder}`);
    patterns.push(`**/${folder}/**`);
  }
  for (const name of HARD_HIDDEN_FILES) {
    patterns.push(`**/${name}`);
  }
  return patterns;
}

export function isImportantConfigBasename(basename: string): boolean {
  return IMPORTANT_CONFIG_FILES.has(basename);
}
