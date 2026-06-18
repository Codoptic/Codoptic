'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenText } from 'lucide-react';
import { readUiPreference, writeUiPreference } from '@/lib/state/uiPreferences';
import type { RepoSourceConfig, RepoSourceType } from '@/lib/agent/repo/repoTypes';

interface ScanResult {
  resolved: string;
  fileCount: number;
  totalBytes: number;
  byExt: Record<string, number>;
  manifests: string[];
  entrypoints: string[];
  apiRoutes: string[];
  components: string[];
  schemas: string[];
  infra: string[];
  docs: string[];
  tests: number;
  depHints: string[];
  likelyStack: string[];
}

interface BrowseEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

interface RepoInputProps {
  onScan: (path: string, result: ScanResult, ignoredFolders: string[], source: RepoSourceConfig) => void;
  onConfigChange?: (path: string, ignoredFolders: string[], source: RepoSourceConfig) => void;
  maxMode: boolean;
  onMaxModeChange: (next: boolean) => void;
  instructionMode: boolean;
  onInstructionModeChange: (next: boolean) => void;
}

// Motivation vs Logic: the browser is the user's main lever to keep noisy folders/files out of
// the agent's view, so we surface it inline (always visible) rather than hiding it behind a "..."
// modal. Each row exposes a kebab menu with Cancel/Ignore so the action is explicit and
// reversible — clicking Ignore appends to the existing `ignoredFolders` list which the analyze
// API already plumbs straight into the scanner.
export function RepoInput({ onScan, onConfigChange, maxMode, onMaxModeChange, instructionMode, onInstructionModeChange }: RepoInputProps) {
  const [sourceType, setSourceType] = useState<RepoSourceType>('local');
  const [path, setPath] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [pat, setPat] = useState('');
  const [hasLocalCheckout, setHasLocalCheckout] = useState(true);
  const [ignoredFolders, setIgnoredFolders] = useState<string[]>([]);
  const [browserParent, setBrowserParent] = useState('');
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<{
    kind: 'loading' | 'success' | 'error';
    message: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const hydratedRef = useRef(false);

  const browserRef = useRef<HTMLDivElement | null>(null);

  const composeSourceConfig = useCallback(
    (overrides: Partial<RepoSourceConfig> = {}): RepoSourceConfig => ({
      // Root Cause vs Logic: local-path mode and GitHub mode share one config object, so blank
      // optional GitHub fields can leak into requests unless we normalize them at the edge.
      sourceType: overrides.sourceType ?? sourceType,
      repoPath: overrides.repoPath ?? path,
      repoUrl:
        (overrides.sourceType ?? sourceType) === 'github'
          ? (overrides.repoUrl ?? repoUrl).trim() || undefined
          : undefined,
      authMode:
        overrides.authMode ??
        ((overrides.sourceType ?? sourceType) === 'github' && (overrides.pat ?? pat.trim()) ? 'pat' : 'none'),
      pat: (overrides.sourceType ?? sourceType) === 'github' ? (overrides.pat ?? pat).trim() || undefined : undefined,
    }),
    [path, pat, repoUrl, sourceType],
  );

  const emitConfigChange = useCallback(
    (nextPath = path, nextIgnored = ignoredFolders, overrides: Partial<RepoSourceConfig> = {}) => {
      onConfigChange?.(nextPath, nextIgnored, composeSourceConfig(overrides));
    },
    [composeSourceConfig, ignoredFolders, onConfigChange, path],
  );

  // Root Cause vs Logic: this bootstrap effect was keyed off `emitConfigChange`, which changes
  // whenever `path` changes. A successful preview updates `path`, so the effect replayed the
  // saved-config hydration and emitted a fresh config change that cleared the parent scan state.
  // We run it once on mount so preview success can keep the repo marked ready.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    const savedSourceType = readUiPreference('repoSourceType') ?? 'local';
    const savedPath = readUiPreference('repoPath') ?? '';
    const savedLocalPath = readUiPreference('repoLocalPath') ?? '';
    const savedRepoUrl = readUiPreference('repoUrl') ?? '';
    const savedIgnored = readUiPreference('repoIgnoredFolders') ?? [];
    const initialLocalPath = savedSourceType === 'local' ? savedPath || savedLocalPath : savedLocalPath;
    const initialActivePath = savedSourceType === 'local' ? savedPath || savedLocalPath : savedPath;
    setSourceType(savedSourceType);
    setRepoUrl(savedRepoUrl);
    setLocalPath(initialLocalPath);
    setHasLocalCheckout(savedSourceType === 'local' || Boolean(initialActivePath));
    if (savedIgnored.length) {
      setIgnoredFolders(savedIgnored);
    }

    if (initialActivePath) {
      setPath(initialActivePath);
      onConfigChange?.(
        initialActivePath,
        savedIgnored,
        composeSourceConfig({
          sourceType: savedSourceType,
          repoPath: initialActivePath,
          repoUrl: savedRepoUrl,
          authMode: 'none',
        }),
      );
    } else if (savedSourceType === 'local') {
      fetch('/api/repo/scan')
        .then((r) => r.json())
        .then((d: { defaultPath?: string }) => {
          if (d.defaultPath) {
            setPath(d.defaultPath);
            setLocalPath(d.defaultPath);
            writeUiPreference('repoLocalPath', d.defaultPath);
            onConfigChange?.(
              d.defaultPath,
              savedIgnored,
              composeSourceConfig({
                sourceType: savedSourceType,
                repoPath: d.defaultPath,
                repoUrl: savedRepoUrl,
                authMode: 'none',
              }),
            );
          }
        })
        .catch(() => {});
    } else {
      setPath('');
    }
  }, [onConfigChange]);

  const loadEntries = useCallback(
    async (parent = '') => {
      if (!path || !hasLocalCheckout) return;
      setLoadingEntries(true);
      setBrowseError(null);
      try {
        const res = await fetch('/api/repo/directories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rootPath: path, parent }),
        });
        const data = await res.json();
        if (!res.ok) {
          setBrowseError(data.error ?? 'Could not list folder');
          setEntries([]);
          return;
        }
        setBrowserParent(data.parent ?? '');
        const next: BrowseEntry[] = Array.isArray(data.entries)
          ? data.entries
          : Array.isArray(data.directories)
            ? data.directories.map((d: { name: string; path: string }) => ({ ...d, type: 'dir' as const }))
            : [];
        setEntries(next);
      } catch (err) {
        setBrowseError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        setLoadingEntries(false);
      }
    },
    [hasLocalCheckout, path],
  );

  // Auto-load the root listing whenever the path changes so the picker is never empty.
  useEffect(() => {
    if (!path || !hasLocalCheckout) {
      setEntries([]);
      setBrowserParent('');
      return;
    }
    void loadEntries('');
  }, [hasLocalCheckout, loadEntries, path]);

  // Close the kebab menu on outside click.
  useEffect(() => {
    if (!activeMenu) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && browserRef.current && !browserRef.current.contains(target)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [activeMenu]);

  const onPathChange = (value: string) => {
    writeUiPreference('repoPath', value);
    if (sourceType === 'local') {
      setLocalPath(value);
      writeUiPreference('repoLocalPath', value);
    }
    setPath(value);
    if (sourceType === 'local') {
      setHasLocalCheckout(Boolean(value.trim()));
    }
    setResult(null);
    setPreviewStatus(null);
    emitConfigChange(value, ignoredFolders, {
      sourceType,
      repoPath: value,
      repoUrl,
    });
  };

  const onSourceTypeChange = (value: RepoSourceType) => {
    // Root Cause vs Logic: the same `path` state was backing both local checkout browsing and
    // GitHub clone mode, so switching sources leaked the previous local path into GitHub mode.
    // We now remember the local path separately, blank the active field in GitHub mode, and
    // restore the local path when the user switches back.
    setSourceType(value);
    writeUiPreference('repoSourceType', value);
    setResult(null);
    setPreviewStatus(null);
    if (value === 'local') {
      const restored = localPath.trim();
      setPath(restored);
      setHasLocalCheckout(Boolean(restored));
      if (restored) {
        writeUiPreference('repoPath', restored);
      }
    } else {
      if (path.trim()) {
        setLocalPath(path);
        writeUiPreference('repoLocalPath', path);
      }
      setPath('');
      writeUiPreference('repoPath', '');
      setHasLocalCheckout(false);
      setEntries([]);
      setBrowserParent('');
    }
    emitConfigChange(value === 'local' ? localPath : '', ignoredFolders, {
      sourceType: value,
      repoPath: value === 'local' ? localPath : '',
      repoUrl,
    });
  };

  const updateIgnoredFolders = (next: string[]) => {
    const cleaned = [
      ...new Set(next.map((item) => item.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    setIgnoredFolders(cleaned);
    writeUiPreference('repoIgnoredFolders', cleaned);
    setResult(null);
    setPreviewStatus(null);
    emitConfigChange(path, cleaned, {
      sourceType,
      repoPath: path,
      repoUrl,
    });
  };

  const parentFolder = browserParent ? browserParent.split('/').slice(0, -1).join('/') : '';

  const ignoredSet = useMemo(() => new Set(ignoredFolders), [ignoredFolders]);

  // Motivation vs Logic: once a path is on the ignore list the agent never reads it, so leaving
  // it in the browser just adds noise. We hide both direct matches and any descendants of an
  // ignored folder — the chip row at the top is the single, authoritative place to unignore.
  const isPathIgnored = useCallback(
    (relPath: string): boolean => {
      if (ignoredSet.has(relPath)) return true;
      for (const ignored of ignoredFolders) {
        if (relPath.startsWith(`${ignored}/`)) return true;
      }
      return false;
    },
    [ignoredFolders, ignoredSet],
  );

  const visibleEntries = useMemo(
    () => entries.filter((entry) => !isPathIgnored(entry.path)),
    [entries, isPathIgnored],
  );

  const hiddenCount = entries.length - visibleEntries.length;

  const onIgnoreEntry = (entry: BrowseEntry) => {
    setActiveMenu(null);
    if (ignoredSet.has(entry.path)) return;
    updateIgnoredFolders([...ignoredFolders, entry.path]);
  };

  const onOpenEntry = (entry: BrowseEntry) => {
    if (entry.type !== 'dir') return;
    setActiveMenu(null);
    void loadEntries(entry.path);
  };

  const onPreview = async () => {
    setScanning(true);
    setError(null);
    setPreviewStatus({
      kind: 'loading',
      message:
        sourceType === 'github'
          ? 'Cloning and scanning the GitHub repository...'
          : 'Scanning the selected local repository...',
    });
    try {
      // Root Cause vs Logic: GitHub mode was previously funneled through the local-path body,
      // so the scan endpoint never saw a cloneable URL. We now submit the selected source shape
      // directly and let the server resolve or clone before scanning.
      const source = composeSourceConfig({
        sourceType,
        repoPath: path,
        repoUrl,
        pat,
      });
      const res = await fetch('/api/repo/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          sourceType === 'github'
            ? { source, ignoredFolders }
            : { path, source, ignoredFolders },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Scan failed');
        setResult(null);
        setPreviewStatus({ kind: 'error', message: data.error ?? 'Scan failed' });
        return;
      }
      setResult(data);
      setHasLocalCheckout(true);
      // Root Cause vs Logic: prefix-search paths like `Backend~` were being normalized to the
      // stem path after preview, which erased the sibling-scope hint the analyzer needs later.
      // We keep the user-entered alias for local prefix searches, while still surfacing the
      // resolved scan result in the preview summary.
      const preserveLocalPrefix = sourceType === 'local' && path.trim().endsWith('~');
      const nextPath = preserveLocalPrefix ? path : data.resolved;
      setPath(nextPath);
      if (sourceType === 'local') {
        setLocalPath(nextPath);
        writeUiPreference('repoLocalPath', nextPath);
      }
      writeUiPreference('repoPath', nextPath);
      const previewResult = preserveLocalPrefix ? { ...data, resolved: nextPath } : data;
      setPreviewStatus(
        sourceType === 'github'
          ? {
              kind: 'success',
              message: `GitHub repository cloned successfully${data.clonedFrom ? ` from ${data.clonedFrom}` : ''}.`,
            }
          : {
              kind: 'success',
              message: 'Repository preview completed successfully.',
          },
      );
      onScan(
        nextPath,
        previewResult,
        ignoredFolders,
        composeSourceConfig({ sourceType, repoPath: nextPath, repoUrl, pat }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPreviewStatus({ kind: 'error', message });
    } finally {
      setScanning(false);
    }
  };

  const previewDisabled = scanning || (sourceType === 'github' ? !repoUrl.trim() : !path.trim());

  return (
    <div className="space-y-3 rounded-xl border border-accent/15 bg-black/42 p-4 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-ink-400">Repository</div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onSourceTypeChange('local')}
          className={`rounded-md border px-2.5 py-1 text-[11px] ${sourceType === 'local' ? 'border-accent/60 bg-accent/20 text-accent' : 'border-ink-700 bg-ink-800 text-ink-300'}`}
        >
          Local Path
        </button>
        <button
          type="button"
          onClick={() => onSourceTypeChange('github')}
          className={`rounded-md border px-2.5 py-1 text-[11px] ${sourceType === 'github' ? 'border-accent/60 bg-accent/20 text-accent' : 'border-ink-700 bg-ink-800 text-ink-300'}`}
        >
          GitHub URL
        </button>
      </div>

      {sourceType === 'github' && (
        <div className="space-y-2 rounded-md border border-ink-800 bg-ink-950/70 p-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Repository URL</div>
          <input
            value={repoUrl}
            onChange={(e) => {
              const value = e.target.value;
              setRepoUrl(value);
              writeUiPreference('repoUrl', value);
              setResult(null);
              setPreviewStatus(null);
              emitConfigChange(path, ignoredFolders, {
                sourceType,
                repoPath: path,
                  repoUrl: value,
                });
              }}
              placeholder="https://github.com/org/repo or .../repo.git"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[11px]"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">Personal access token (optional)</div>
            <input
              type="password"
              autoComplete="off"
              value={pat}
            onChange={(e) => {
              const value = e.target.value;
              setPat(value);
              setResult(null);
              setPreviewStatus(null);
              emitConfigChange(path, ignoredFolders, {
                sourceType,
                repoPath: path,
                  repoUrl,
                  pat: value.trim() || undefined,
                });
              }}
              placeholder="ghp_…"
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[11px]"
            />
            <div className="mt-1 text-[10px] text-ink-400">PAT is optional for public repositories.</div>
            <div className="text-[10px] text-ink-400">If clone fails with auth/permission errors, provide a PAT and retry.</div>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">
          {sourceType === 'github' ? 'Resolved checkout path' : 'Absolute path'}
        </div>
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => onPathChange(e.target.value)}
            readOnly={sourceType === 'github'}
            placeholder={sourceType === 'github' ? 'Will populate after clone completes' : '/Users/you/projects/your-repo'}
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => void loadEntries('')}
            disabled={!path || loadingEntries}
            title="Refresh folder listing"
            className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 font-semibold hover:bg-ink-700 disabled:opacity-50"
          >
            ↻
          </button>
        </div>
        <div className="mt-1 text-[10px] text-ink-400">
          {sourceType === 'github' ? (
            'This checkout path is created automatically after clone and then used for browsing and scanning.'
          ) : (
            <>
              Default is the parent of <code>Codoptic/</code> - i.e. the project you cloned this into.
            </>
          )}
        </div>
        {sourceType === 'local' && (
          <div className="mt-1 text-[10px] text-ink-400">
            Tip: end a folder name with <code>~</code> to list sibling directories from the same parent, like{' '}
            <code>Back~</code> can relate to <code>Backend</code> or <code>Backend.API</code> and etc.
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border border-ink-800 bg-ink-950/70 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-widest text-ink-400">Ignored paths</div>
          {ignoredFolders.length > 0 && (
            <button
              type="button"
              onClick={() => updateIgnoredFolders([])}
              className="text-[10px] text-ink-400 hover:text-ink-100"
            >
              Clear
            </button>
          )}
        </div>
        {ignoredFolders.length ? (
          <div className="flex flex-wrap gap-1.5">
            {ignoredFolders.map((folder) => (
              <button
                key={folder}
                type="button"
                onClick={() => updateIgnoredFolders(ignoredFolders.filter((item) => item !== folder))}
                className="rounded-full border border-ink-700 bg-ink-800 px-2 py-0.5 font-mono text-[10px] text-ink-200 hover:border-coral/60"
                title="Remove from ignore list"
              >
                {folder} ×
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-ink-500">No extra folders ignored.</div>
        )}
      </div>

      {/* Motivation vs Logic: preview is the source-resolution step, so the user needs immediate feedback
          that a clone/scan is happening and when the GitHub checkout becomes available. */}
      {previewStatus && (
        <div
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[11px] ${
            previewStatus.kind === 'loading'
              ? 'border-blue-400/40 bg-blue-400/10 text-blue-100'
              : previewStatus.kind === 'success'
                ? 'border-green-400/40 bg-green-400/10 text-green-100'
                : 'border-red-400/40 bg-red-400/10 text-red-100'
          }`}
        >
          {previewStatus.kind === 'loading' ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          ) : previewStatus.kind === 'success' ? (
            <span className="text-green-300">✓</span>
          ) : (
            <span className="text-red-300">!</span>
          )}
          <span>{previewStatus.message}</span>
        </div>
      )}

      <div ref={browserRef} className="space-y-2 rounded-md border border-ink-700 bg-ink-950 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-ink-400">Folder browser</div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500" title={browserParent || '.'}>
              {browserParent || '.'}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void loadEntries(parentFolder)}
              disabled={!hasLocalCheckout || !browserParent || loadingEntries}
              className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] hover:bg-ink-700 disabled:opacity-50"
            >
              Up
            </button>
            <button
              type="button"
              onClick={() => void loadEntries('')}
              disabled={!hasLocalCheckout || !path || loadingEntries}
              className="rounded border border-ink-700 bg-ink-800 px-2 py-1 text-[11px] hover:bg-ink-700 disabled:opacity-50"
            >
              Root
            </button>
          </div>
        </div>

        {browseError && (
          <div className="rounded border border-red-500/50 bg-red-500/10 p-2 text-red-200">{browseError}</div>
        )}

        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded border border-ink-800 bg-ink-900/70 p-1">
          {!hasLocalCheckout ? (
            <div className="p-2 text-ink-500">Directory browsing unlocks after clone completes and a local checkout path exists.</div>
          ) : loadingEntries ? (
            <div className="p-2 text-ink-400">Loading…</div>
          ) : visibleEntries.length ? (
            visibleEntries.map((entry) => {
              const menuOpen = activeMenu === entry.path;
              const isDir = entry.type === 'dir';
              return (
                <div
                  key={entry.path}
                  className="group relative flex items-center gap-2 rounded px-2 py-1 hover:bg-ink-800"
                >
                  <span className="w-4 shrink-0 text-center text-[11px] text-ink-500">
                    {isDir ? '📁' : '📄'}
                  </span>
                  {isDir ? (
                    <button
                      type="button"
                      onClick={() => onOpenEntry(entry)}
                      className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-200 hover:text-accent"
                      title={`Open ${entry.path}`}
                    >
                      {entry.name}
                    </button>
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-300"
                      title={entry.path}
                    >
                      {entry.name}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveMenu((current) => (current === entry.path ? null : entry.path))}
                    className="shrink-0 rounded px-2 py-0.5 text-[12px] text-ink-400 hover:bg-ink-700 hover:text-ink-100"
                    title="Actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                  >
                    …
                  </button>
                  {menuOpen && (
                    <div
                      role="menu"
                      className="absolute right-2 top-full z-10 mt-1 flex w-44 flex-col gap-1 rounded-md border border-ink-700 bg-ink-900 p-1 shadow-xl"
                    >
                      {isDir && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => onOpenEntry(entry)}
                          className="rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-ink-800"
                        >
                          Open folder
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => onIgnoreEntry(entry)}
                        className="rounded border border-coral/40 bg-coral/10 px-2 py-1 text-left text-[11px] text-coral hover:bg-coral/20"
                      >
                        Ignore
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => setActiveMenu(null)}
                        className="rounded px-2 py-1 text-left text-[11px] text-ink-400 hover:bg-ink-800"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="p-2 text-ink-500">
              {entries.length ? 'All entries here are ignored.' : 'Empty folder.'}
            </div>
          )}
        </div>
        <div className="text-[10px] text-ink-500">
          Codoptic’s own folder, common build/cache directories
          {hiddenCount > 0 ? `, and ${hiddenCount} ignored entr${hiddenCount === 1 ? 'y' : 'ies'}` : ''} are hidden automatically.
        </div>
      </div>

      {/* Motivation vs Logic: keep the analysis budget control beside the preview action so the
          repo-selection flow and the "scan everything" choice stay visible in one place. */}
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] transition-colors ${
            maxMode
              ? 'border-coral/60 bg-coral/10 text-coral'
              : 'border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
          }`}
          title="MAX mode scans all relevant files instead of stopping at the default cap."
        >
          <input
            type="checkbox"
            checked={maxMode}
            onChange={(e) => onMaxModeChange(e.target.checked)}
            className="h-4 w-4 rounded border-ink-600 bg-ink-800"
            aria-label="Enable MAX mode"
          />
          <span className="font-semibold uppercase tracking-wider">MAX mode</span>
        </label>
        <label
          className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] transition-colors ${
            instructionMode
              ? 'border-accent/60 bg-accent/10 text-accent'
              : 'border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
          }`}
          title="Document Mode generates a Markdown guide alongside the diagram."
        >
          <input
            type="checkbox"
            checked={instructionMode}
            onChange={(e) => onInstructionModeChange(e.target.checked)}
            className="h-4 w-4 rounded border-ink-600 bg-ink-800 accent-[rgb(var(--accent))]"
            aria-label="Enable Document Mode"
          />
          <BookOpenText size={14} />
          <span className="font-semibold uppercase tracking-wider">Document Mode</span>
        </label>
        <button
          type="button"
          onClick={onPreview}
          disabled={previewDisabled}
          className="rounded-md border border-ink-700 bg-ink-800 px-3 py-1.5 hover:bg-ink-700 disabled:opacity-50"
        >
          {scanning ? 'Scanning…' : sourceType === 'github' ? 'Clone & scan' : 'Preview repo'}
        </button>
      </div>

      {error && <div className="rounded border border-red-500/50 bg-red-500/10 p-2 text-red-200">{error}</div>}

      {result && (
        <div className="space-y-1 rounded border border-ink-700 bg-ink-950 p-2 text-[11px] text-ink-300">
          <div>
            <span className="text-ink-400">Files:</span> {result.fileCount.toLocaleString()} ·{' '}
            <span className="text-ink-400">Size:</span> {Math.round(result.totalBytes / 1024).toLocaleString()} KB
          </div>
          <div>
            <span className="text-ink-400">Stack:</span> {result.likelyStack.join(', ') || 'unknown'}
          </div>
          <div>
            <span className="text-ink-400">Entrypoints:</span> {result.entrypoints.slice(0, 4).join(', ') || '—'}
          </div>
          <div>
            <span className="text-ink-400">API routes:</span> {result.apiRoutes.length} ·{' '}
            <span className="text-ink-400">Components:</span> {result.components.length} ·{' '}
            <span className="text-ink-400">Schemas:</span> {result.schemas.length}
          </div>
        </div>
      )}
    </div>
  );
}
