'use client';

import type { AgentRunFeedEntry } from '@/lib/code-space/core';

interface MissionPackage {
  role: string;
  goal: string;
  status: string;
}

interface MissionBoardProps {
  runFeed?: AgentRunFeedEntry[];
}

export function MissionBoard({ runFeed = [] }: MissionBoardProps) {
  const coworking = runFeed.filter((entry) => /coworking|Mission board|Deliverable|Hook /.test(`${entry.id} ${entry.title}`));
  if (!coworking.length) return null;

  const latestPhase = [...coworking].reverse().find((entry) => entry.title.startsWith('Coworking phase:'))?.title.replace('Coworking phase: ', '') ?? 'intake';
  const graph = [...coworking].reverse().find((entry) => entry.title.startsWith('Mission board ready') || entry.title.startsWith('Mission board created'));
  const packages = parsePackages(graph?.detail, graph?.title);
  const blockers = coworking.filter((entry) => entry.status === 'warning').slice(-3);
  const evidence = coworking.filter((entry) => entry.status === 'success').slice(-4);

  return (
    <section className="mb-3 rounded-lg border border-[#30363d] bg-[#0d1117] px-3 py-2 font-sans">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6e7681]">Mission Board</div>
          <div className="mt-0.5 text-[12px] font-medium text-[#c9d1d9]">Phase: {latestPhase}</div>
        </div>
        <div className="rounded-full border border-[#30363d] px-2 py-0.5 text-[10px] text-[#8e8e93]">
          {packages.length} package{packages.length === 1 ? '' : 's'}
        </div>
      </div>

      {packages.length ? (
        <div className="mt-2 grid gap-1.5">
          {packages.slice(0, 5).map((pkg, index) => (
            <div key={`${index}:${pkg.role}:${pkg.goal}`} className="rounded border border-[#242424] bg-[#101419] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-medium text-[#d6d6d6]">{pkg.role}</span>
                <span className="text-[#6e7681]">{pkg.status || 'ready'}</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-[#8e8e93]">{pkg.goal}</div>
            </div>
          ))}
        </div>
      ) : null}

      {blockers.length ? (
        <div className="mt-2 rounded border border-[#3b2323] bg-[#1b1010] px-2 py-1.5 text-[11px] leading-4 text-[#ffb4a8]">
          {blockers[blockers.length - 1]?.detail || blockers[blockers.length - 1]?.title}
        </div>
      ) : null}

      {evidence.length ? (
        <div className="mt-2 text-[10px] leading-4 text-[#6e7681]">
          Latest evidence: {evidence.map((entry) => entry.title).join(' | ')}
        </div>
      ) : null}
    </section>
  );
}

function parsePackages(detail?: string, title?: string): MissionPackage[] {
  const fromTitle = title?.match(/Mission board ready \((\d+) package/)?.[1];
  if (detail?.includes(':') && detail.includes(';')) {
    return detail
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [role, ...rest] = part.split(':');
        return { role: role?.trim() || 'agent', goal: rest.join(':').trim() || part, status: 'ready' };
      });
  }
  const count = Number(fromTitle ?? 0);
  if (!count) return [];
  return Array.from({ length: Math.min(count, 5) }, (_, index) => ({
    role: 'package',
    goal: detail || `Work package ${index + 1}`,
    status: 'ready',
  }));
}
