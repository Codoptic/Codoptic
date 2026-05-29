'use client';

import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenText, Download, FileCode2, ImageIcon, Layers3, X } from 'lucide-react';
import type { RefObject } from 'react';
import { type DiagramCanvasHandle } from '@/components/diagram/DiagramCanvas';
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer';
import { useDiagramStore } from '@/lib/state/store';
import { serializeSvg } from '@/lib/export/svg';
import { svgMarkupToPngBlob } from '@/lib/export/png';
import { instructionPdfBlob } from '@/lib/export/instructionPdf';
import { downloadExportFiles, type ExportFile } from '@/lib/export/archive';
import { compile } from '@/lib/dsl/compiler';
import { runLayout } from '@/lib/layout/strategies';
import { renderSvg } from '@/lib/render/svgString';

type DiagramExportFormat = 'png' | 'svg';
type TextExportFormat = 'txt' | 'md';
type InstructionExportFormat = 'txt' | 'pdf';
type DiagramScope = 'current' | 'all';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  diagramRef: RefObject<DiagramCanvasHandle>;
  dslText: string;
  instructionMarkdown: string;
  theme: 'dark' | 'light';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'diagram';
}

function markdownCodeFence(title: string, dslText: string): string {
  return `# ${title}\n\n\`\`\`dsl\n${dslText.trimEnd()}\n\`\`\`\n`;
}

function RadioChoice({
  name,
  value,
  checked,
  label,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition ${
        checked
          ? 'border-accent/60 bg-accent/10 text-ink-100'
          : 'border-ink-700 bg-ink-850 text-ink-300 hover:border-accent/40 hover:text-ink-100'
      }`}
    >
      <input
        checked={checked}
        className="h-4 w-4 accent-[rgb(var(--accent))]"
        name={name}
        onChange={() => onChange(value)}
        type="radio"
        value={value}
      />
      <span>{label}</span>
    </label>
  );
}

export function ExportDialog({ open, onClose, diagramRef, dslText, instructionMarkdown, theme }: ExportDialogProps) {
  const multiLayer = useDiagramStore((s) => s.multiLayer);
  const activeLayer = useDiagramStore((s) => s.activeLayer);
  const layoutStrategy = useDiagramStore((s) => s.layoutStrategy);
  const [diagramFormat, setDiagramFormat] = useState<DiagramExportFormat>('png');
  const [diagramScope, setDiagramScope] = useState<DiagramScope>('current');
  const [includeCode, setIncludeCode] = useState(false);
  const [codeFormat, setCodeFormat] = useState<TextExportFormat>('txt');
  const [includeInstructions, setIncludeInstructions] = useState(false);
  const [instructionFormat, setInstructionFormat] = useState<InstructionExportFormat>('pdf');
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instructionPreviewRef = useRef<HTMLDivElement>(null);
  const hasInstructionContent = instructionMarkdown.trim().length > 0;
  const hasMultiLayer = Boolean(multiLayer);

  useEffect(() => {
    if (!open) return;
    setDiagramFormat('png');
    setDiagramScope('current');
    setIncludeCode(false);
    setCodeFormat('txt');
    setIncludeInstructions(false);
    setInstructionFormat('pdf');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const selectedCount = useMemo(() => {
    const diagramCount = hasMultiLayer && diagramScope === 'all' ? 1 + (multiLayer?.layers.length ?? 0) : 1;
    const codeCount = includeCode
      ? hasMultiLayer && diagramScope === 'all'
        ? 1 + (multiLayer?.layers.length ?? 0)
        : 1
      : 0;
    const instructionCount = includeInstructions && hasInstructionContent ? 1 : 0;
    return diagramCount + codeCount + instructionCount;
  }, [diagramScope, hasInstructionContent, hasMultiLayer, includeCode, includeInstructions, multiLayer]);

  const buildLayerSvg = async (name: string, dsl: string, currentSvg?: SVGSVGElement | null): Promise<string> => {
    if (currentSvg && name === activeLayer) {
      return serializeSvg(currentSvg, { includeBackground: true });
    }

    const diagram = compile(dsl, dsl);
    const layout = await runLayout(diagram, layoutStrategy);
    return renderSvg(diagram, layout, { withBackground: true });
  };

  const buildExportFiles = async (): Promise<ExportFile[]> => {
    const files: ExportFile[] = [];
    const currentSvg = diagramRef.current?.getSvg() ?? null;
    const currentBase = hasMultiLayer ? slugify(activeLayer) : 'diagram';

    const diagramEntries =
      hasMultiLayer && diagramScope === 'all' && multiLayer
        ? [
            { name: 'overview', dsl: multiLayer.overview.dsl },
            ...multiLayer.layers.map((layer) => ({ name: layer.name, dsl: layer.dsl })),
          ]
        : [{ name: currentBase, dsl: dslText }];

    const diagramTasks = await Promise.all(
      diagramEntries.map(async (entry) => {
        const svg = await buildLayerSvg(entry.name, entry.dsl, currentSvg);
        if (diagramFormat === 'png') {
          return {
            name: `${slugify(entry.name)}.png`,
            content: await svgMarkupToPngBlob(svg, { includeBackground: true, scale: 2 }),
          } satisfies ExportFile;
        }
        return {
          name: `${slugify(entry.name)}.svg`,
          content: svg,
          mimeType: 'image/svg+xml;charset=utf-8',
        } satisfies ExportFile;
      }),
    );
    files.push(...diagramTasks);

    if (includeCode) {
      const codeEntries =
        hasMultiLayer && diagramScope === 'all' && multiLayer
          ? [
              { name: 'overview', dsl: multiLayer.overview.dsl },
              ...multiLayer.layers.map((layer) => ({ name: layer.name, dsl: layer.dsl })),
            ]
          : [{ name: currentBase, dsl: dslText }];

      for (const entry of codeEntries) {
        const base = slugify(entry.name);
        if (codeFormat === 'md') {
          files.push({
            name: `${base}-code.md`,
            content: markdownCodeFence(entry.name, entry.dsl),
            mimeType: 'text/markdown;charset=utf-8',
          });
        } else {
          files.push({
            name: `${base}-code.txt`,
            content: entry.dsl,
            mimeType: 'text/plain;charset=utf-8',
          });
        }
      }
    }

    if (includeInstructions && hasInstructionContent) {
      if (instructionFormat === 'txt') {
        files.push({
          name: 'instruction-guide.txt',
          content: instructionMarkdown,
          mimeType: 'text/plain;charset=utf-8',
        });
      } else {
        const node = instructionPreviewRef.current;
        if (!node) throw new Error('Instruction preview is not ready.');
        files.push({
          name: 'instruction-guide.pdf',
          content: await instructionPdfBlob(node, theme),
          mimeType: 'application/pdf',
        });
      }
    }

    return files;
  };

  const exportSelected = async () => {
    setError(null);
    setIsExporting(true);
    try {
      const files = await buildExportFiles();
      if (files.length === 0) throw new Error('Nothing was selected to export.');
      // Motivation vs Logic: when the export expands into several artifacts, the browser should receive one archive instead of a burst of separate downloads so the user's chosen bundle stays together.
      await downloadExportFiles(files, 'codoptic-export.zip');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-400">Export</div>
            <div className="text-sm text-ink-200">Choose the artifacts to download</div>
          </div>
          <button
            className="surface-transition inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink-700 bg-ink-900 text-ink-300 hover:border-accent/50 hover:text-ink-100"
            onClick={onClose}
            type="button"
            aria-label="Close export dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {hasMultiLayer && (
            <section className="rounded-lg border border-ink-700 bg-ink-950/40 p-3">
              <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-400">
                <Layers3 size={13} />
                Layer scope
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <RadioChoice
                  name="diagram-scope"
                  value="current"
                  checked={diagramScope === 'current'}
                  label="This layer"
                  onChange={(value) => setDiagramScope(value as DiagramScope)}
                />
                <RadioChoice
                  name="diagram-scope"
                  value="all"
                  checked={diagramScope === 'all'}
                  label="All layers"
                  onChange={(value) => setDiagramScope(value as DiagramScope)}
                />
              </div>
              <p className="mt-2 text-[11px] leading-5 text-ink-400">
                This layer exports the diagram you are actively viewing. All layers exports the overview and every
                layer together.
              </p>
            </section>
          )}

          <section className="rounded-lg border border-ink-700 bg-ink-950/40 p-3">
            <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-400">
              <ImageIcon size={13} />
              Diagram
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <RadioChoice
                name="diagram-format"
                value="png"
                checked={diagramFormat === 'png'}
                label="PNG"
                onChange={(value) => setDiagramFormat(value as DiagramExportFormat)}
              />
              <RadioChoice
                name="diagram-format"
                value="svg"
                checked={diagramFormat === 'svg'}
                label="SVG"
                onChange={(value) => setDiagramFormat(value as DiagramExportFormat)}
              />
            </div>
          </section>

          <section className="rounded-lg border border-ink-700 bg-ink-950/40 p-3">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-400">
              <input
                aria-label="Export code"
                checked={includeCode}
                className="h-4 w-4 rounded border-ink-600 accent-[rgb(var(--accent))]"
                id="export-dialog-code"
                onChange={(event) => setIncludeCode(event.target.checked)}
                type="checkbox"
              />
              <label className="flex items-center gap-2" htmlFor="export-dialog-code">
                <FileCode2 size={13} />
                Code
              </label>
            </div>
            {includeCode && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <RadioChoice
                  name="code-format"
                  value="txt"
                  checked={codeFormat === 'txt'}
                  label="TXT"
                  onChange={(value) => setCodeFormat(value as TextExportFormat)}
                />
                <RadioChoice
                  name="code-format"
                  value="md"
                  checked={codeFormat === 'md'}
                  label="MD"
                  onChange={(value) => setCodeFormat(value as TextExportFormat)}
                />
              </div>
            )}
          </section>

          {hasInstructionContent && (
            <section className="rounded-lg border border-ink-700 bg-ink-950/40 p-3">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-400">
                <input
                  aria-label="Export instructions"
                  checked={includeInstructions}
                  className="h-4 w-4 rounded border-ink-600 accent-[rgb(var(--accent))]"
                  id="export-dialog-instructions"
                  onChange={(event) => setIncludeInstructions(event.target.checked)}
                  type="checkbox"
                />
                <label className="flex items-center gap-2" htmlFor="export-dialog-instructions">
                  <BookOpenText size={13} />
                  Instructions
                </label>
              </div>
              {includeInstructions && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <RadioChoice
                    name="instruction-format"
                    value="txt"
                    checked={instructionFormat === 'txt'}
                    label="TXT"
                    onChange={(value) => setInstructionFormat(value as InstructionExportFormat)}
                  />
                  <RadioChoice
                    name="instruction-format"
                    value="pdf"
                    checked={instructionFormat === 'pdf'}
                    label="PDF"
                    onChange={(value) => setInstructionFormat(value as InstructionExportFormat)}
                  />
                </div>
              )}
            </section>
          )}

          {error && <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
        </div>

        <div className="flex items-center justify-between border-t border-ink-700 bg-ink-850 px-4 py-3">
          <div className="text-xs text-ink-400">
            {selectedCount} file{selectedCount === 1 ? '' : 's'} selected
            {selectedCount > 1 ? ' • zip bundle' : ''}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="surface-transition inline-flex h-9 items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-ink-200 hover:border-accent/50 hover:text-ink-100 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="surface-transition inline-flex h-9 items-center gap-2 rounded-md border border-accent/50 bg-accent/15 px-3 text-sm font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isExporting}
              onClick={exportSelected}
              type="button"
            >
              <Download size={15} />
              {isExporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>

        {hasInstructionContent && (
          <div aria-hidden className="pointer-events-none fixed left-[-10000px] top-0 w-[720px]">
            <article ref={instructionPreviewRef} className="rounded-xl border border-ink-700 bg-ink-900 px-5 py-4 text-sm shadow-inner">
              <MarkdownRenderer markdown={instructionMarkdown} />
            </article>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
