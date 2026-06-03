'use client';

import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, ExternalLink, FileText } from 'lucide-react';
import {
  buildMarkdownAssetUrl,
  resolveMarkdownLinkTarget,
  slugifyMarkdownHeading,
} from '@/lib/code-space/markdownPaths';

let mermaidModulePromise: Promise<typeof import('mermaid')> | null = null;
let mermaidInitializedTheme: 'dark' | 'light' | null = null;

async function loadMermaid(theme: 'dark' | 'light') {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid');
  }
  const mermaidModule = await mermaidModulePromise;
  const mermaid = mermaidModule.default;
  if (mermaidInitializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'light' ? 'default' : 'dark',
    });
    mermaidInitializedTheme = theme;
  }
  return mermaid;
}

function flattenText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flattenText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return flattenText((children as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
}

function MermaidDiagram({ source, theme }: { source: string; theme: 'dark' | 'light' }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderId = useId().replace(/:/g, '');

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    void (async () => {
      try {
        const mermaid = await loadMermaid(theme);
        const result = await mermaid.render(`mermaid-${renderId}`, source);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [renderId, source, theme]);

  if (error) {
    return (
      <div className="my-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
        <div className="mb-2 flex items-center gap-2 font-semibold">
          <AlertTriangle size={14} />
          Mermaid render failed
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-6">{error}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-4 rounded-lg border border-ink-700 bg-ink-950 px-3 py-4 text-xs text-ink-400">
        Rendering diagram…
      </div>
    );
  }

  return <div className="my-4 overflow-x-auto rounded-lg border border-ink-700 bg-white p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function InlineCode({ children }: { children?: ReactNode }) {
  return <code className="rounded border border-ink-700 bg-ink-850 px-1.5 py-0.5 font-mono text-[0.92em] text-accent-cool">{children}</code>;
}

function MarkdownCodeBlock({ children, theme }: { children?: ReactNode; theme: 'dark' | 'light' }) {
  const child = Array.isArray(children) ? children[0] : children;
  const codeElement = child && typeof child === 'object' && 'props' in child
    ? (child as ReactElement<{ className?: string; children?: ReactNode }>)
    : null;
  const className = codeElement?.props.className ?? '';
  const language = className.replace(/^language-/, '');
  const code = flattenText(codeElement?.props.children ?? child);

  if (language === 'mermaid') {
    return <MermaidDiagram source={code} theme={theme} />;
  }

  return (
    <pre className="my-4 overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-[11px] leading-6 text-ink-100 shadow-inner">
      <code className={`${className} font-mono`}>{codeElement?.props.children ?? children}</code>
    </pre>
  );
}

function renderHeading(level: 1 | 2 | 3 | 4 | 5 | 6, children: ReactNode) {
  const text = flattenText(children);
  const id = slugifyMarkdownHeading(text);
  const spacing =
    level === 1
      ? 'mb-4 mt-1'
      : level === 2
        ? 'mb-3 mt-6'
        : level === 3
          ? 'mb-2 mt-5'
          : 'mb-2 mt-4';
  const base = `${spacing} font-semibold text-ink-100`;
  if (level === 1) return <h1 id={id} className={`${base} text-2xl tracking-tight`}>{children}</h1>;
  if (level === 2) return <h2 id={id} className={`${base} border-b border-ink-700 pb-2 text-lg`}>{children}</h2>;
  if (level === 3) return <h3 id={id} className={`${base} text-base`}>{children}</h3>;
  if (level === 4) return <h4 id={id} className={`${base} text-sm uppercase tracking-wide text-ink-300`}>{children}</h4>;
  if (level === 5) return <h5 id={id} className={`${base} text-sm`}>{children}</h5>;
  return <h6 id={id} className={`${base} text-xs uppercase tracking-wide text-ink-300`}>{children}</h6>;
}

export interface MarkdownRendererProps {
  markdown: string;
  theme?: 'dark' | 'light';
  className?: string;
  contentClassName?: string;
  componentsOverride?: Partial<Components>;
  currentFilePath?: string;
  rootPath?: string;
  onOpenFile?: (filePath: string, options?: { preview?: boolean }) => void;
}

export function MarkdownRenderer({
  markdown,
  theme = 'dark',
  className = '',
  contentClassName = '',
  componentsOverride,
  currentFilePath = '',
  rootPath = '',
  onOpenFile,
}: MarkdownRendererProps) {
  const components = useMemo<Components>(() => {
    return {
      h1: ({ children }) => renderHeading(1, children),
      h2: ({ children }) => renderHeading(2, children),
      h3: ({ children }) => renderHeading(3, children),
      h4: ({ children }) => renderHeading(4, children),
      h5: ({ children }) => renderHeading(5, children),
      h6: ({ children }) => renderHeading(6, children),
      p: ({ children }) => <p className="my-3 leading-7 text-ink-200">{children}</p>,
      a: ({ children, href = '' }) => {
        const target = resolveMarkdownLinkTarget(currentFilePath, href);
        const isInternalFile = target?.kind === 'file';
        const isAnchor = target?.kind === 'anchor';
        const isExternal = target?.kind === 'external';
        const label = flattenText(children);

        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (isExternal) return;
          event.preventDefault();
          if (isAnchor) {
            const anchor = target.hash ? document.getElementById(target.hash) : null;
            anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
          if (isInternalFile && onOpenFile) {
            onOpenFile(target.path, { preview: target.path.toLowerCase().endsWith('.md') });
          }
        };

        return (
          <a
            className="inline-flex items-center gap-1 text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
            href={isExternal ? target.href : href}
            onClick={handleClick}
            rel={isExternal ? 'noreferrer' : undefined}
            target={isExternal ? '_blank' : undefined}
            title={label}
          >
            {children}
            {isExternal && <ExternalLink size={12} className="opacity-70" />}
            {isInternalFile && <FileText size={12} className="opacity-70" />}
          </a>
        );
      },
      ul: ({ children }) => <ul className="my-3 list-disc space-y-2 pl-5 text-ink-200">{children}</ul>,
      ol: ({ children }) => <ol className="my-3 list-decimal space-y-2 pl-5 text-ink-200">{children}</ol>,
      li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="my-4 border-l-2 border-accent/70 bg-accent/10 px-4 py-2 text-ink-200">{children}</blockquote>
      ),
      hr: () => <hr className="my-6 border-ink-700" />,
      table: ({ children }) => (
        <div className="my-4 overflow-x-auto rounded-lg border border-ink-700">
          <table className="min-w-full divide-y divide-ink-700 text-left text-xs">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="bg-ink-850 text-ink-100">{children}</thead>,
      tbody: ({ children }) => <tbody className="divide-y divide-ink-700">{children}</tbody>,
      th: ({ children }) => <th className="px-3 py-2 font-semibold">{children}</th>,
      td: ({ children }) => <td className="px-3 py-2 align-top text-ink-200">{children}</td>,
      pre: ({ children }) => <MarkdownCodeBlock theme={theme}>{children}</MarkdownCodeBlock>,
      code: ({ children }) => <InlineCode>{children}</InlineCode>,
      img: ({ alt, src = '' }) => {
        const resolvedSrc = rootPath ? buildMarkdownAssetUrl(rootPath, currentFilePath, src) ?? src : src;
        const caption = alt?.trim() ?? '';
        return (
          <span className="my-4 block space-y-2">
            {/* Motivation vs Logic: Markdown images should behave like IDE previews, so local assets resolve through the workspace asset route instead of leaking raw filesystem paths into the browser. */}
            {/* Root Cause vs Logic: plain <img> tags cannot safely load project-relative files from an arbitrary repo path; the preview needs a guarded endpoint that serves only the requested asset. */}
            <img alt={alt ?? ''} className="max-w-full rounded-lg border border-ink-700 bg-ink-900" src={resolvedSrc} />
            {caption && <span className="block text-xs text-ink-400">{caption}</span>}
          </span>
        );
      },
      del: ({ children }) => <del className="text-ink-400">{children}</del>,
      input: ({ checked, ...props }) => {
        if (props.type !== 'checkbox') return <input {...props} />;
        return <input checked={checked} className="mr-2 accent-[rgb(var(--accent))]" readOnly type="checkbox" />;
      },
    };
  }, [currentFilePath, onOpenFile, rootPath, theme]);

  const mergedComponents = useMemo<Components>(() => {
    return { ...components, ...componentsOverride };
  }, [components, componentsOverride]);

  return (
    <article className={`${className} text-sm leading-7 text-ink-100`}>
      <div className={contentClassName}>
        <ReactMarkdown components={mergedComponents} rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
          {markdown}
        </ReactMarkdown>
      </div>
    </article>
  );
}
