// Motivation vs Logic: The mention picker needs a vocabulary shared between the index, query
// service, composer UI, and agent payload so each layer can hand off structured records without
// re-parsing strings. These types encode the spec's contract: forward-slash relative paths,
// compact chip display, full-path tooltip/copy text, and a `kind` discriminator that survives
// all the way to `/api/code-space/agent` as `attachments[]`.

export type MentionEntryType = 'file' | 'folder';

export type MentionMode =
  | 'rootBrowse'
  | 'directoryBrowse'
  | 'scopedSearch'
  | 'globalFuzzySearch'
  | 'pathFuzzySearch';

export interface MentionEntry {
  id: string;
  type: MentionEntryType;
  /** Human-readable name (same as basename for files; folder name without trailing slash). */
  name: string;
  basename: string;
  /** Lower-case extension including the leading dot, or undefined for folders/no-ext files. */
  extension?: string;
  /** Project-root-relative path, forward-slashed, no leading slash, no trailing slash. */
  relativePath: string;
  /** Parent directory relative path (forward-slashed), '' when entry is a root child. */
  parentPath: string;
  /** Path segments split on '/'. Length == depth. */
  segments: string[];
  /** 1 for root-level entries. */
  depth: number;
  /** Lower-cased basename. */
  normalizedName: string;
  /** Lower-cased relative path. */
  normalizedPath: string;
  size?: number;
  mtime?: number;
  /** True when any segment starts with a dot (hidden by default). */
  isHidden: boolean;
  /** True when the picker considers this generated/build output (excluded by default). */
  isIgnored: boolean;
  /** True when the basename matches a known binary/media extension; heavily down-ranked. */
  isBinary: boolean;
  /** True when the basename is a recognised lock file. */
  isLockFile: boolean;
  /** True when the basename is a high-value project config (boost in rootBrowse). */
  isImportantConfig: boolean;
}

export interface MentionMatchRange {
  field: 'basename' | 'relativePath';
  start: number;
  end: number;
}

export interface MentionSuggestion {
  id: string;
  type: MentionEntryType;
  basename: string;
  /** Label shown as the primary line in the suggestion row. Basename, with trailing '/' for folders. */
  displayName: string;
  relativePath: string;
  parentPath: string;
  /** Hover tooltip / full-path disambiguator. */
  tooltip: string;
  score: number;
  matchRanges: MentionMatchRange[];
  reason?: string;
  /** Optional UI badges (open, recent, root, folder, current-dir). */
  badges: ReadonlyArray<'open' | 'recent' | 'root' | 'folder' | 'current-dir'>;
}

export interface SelectedMention {
  id: string;
  type: MentionEntryType;
  /** Visible chip text (basename for files, lastSegment + '/' for folders). */
  displayName: string;
  basename: string;
  relativePath: string;
}

export interface ParsedMentionToken {
  /** Normalized, traversal-rejected version of rawToken (without leading '@'). */
  token: string;
  mode: MentionMode;
  scopeDir?: string;
  query?: string;
  /** True when the raw input contained '..' or otherwise tried to escape the project root. */
  rejectedTraversal: boolean;
}

export interface MentionQueryContext {
  rawToken: string;
  currentEditorFilePath?: string;
  openFiles?: ReadonlyArray<string>;
  recentFiles?: ReadonlyArray<string>;
  maxResults?: number;
}

export interface MentionIndexEntryInput {
  path: string;
  size?: number;
  mtime?: number;
  /** Hint that the entry is a folder; folders are otherwise derived from file path prefixes. */
  type?: MentionEntryType;
}
