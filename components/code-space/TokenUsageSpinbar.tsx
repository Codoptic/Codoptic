'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDailyTokens,
  getSessionTokens,
  getTokenLimits,
  getWeeklyTokens,
  saveTokenLimits,
  type TokenUsageLimits,
} from '@/lib/code-space/tokenUsage';

interface UsageSnapshot {
  session: number;
  daily: number;
  weekly: number;
  limits: TokenUsageLimits;
}

function usagePct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, (used / limit) * 100);
}

function usageStroke(pct: number): string {
  if (pct >= 90) return '#f85149';
  if (pct >= 70) return '#f0883e';
  return '#3fb950';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

interface RingProps {
  pct: number;
  size?: number;
  strokeWidth?: number;
}

function Ring({ pct, size = 13, strokeWidth = 2 }: RingProps) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  const color = usageStroke(pct);
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#30363d" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}

interface UsageRowProps {
  label: string;
  used: number;
  limit: number;
}

function UsageRow({ label, used, limit }: UsageRowProps) {
  const pct = usagePct(used, limit);
  const color = usageStroke(pct);
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between gap-3">
        <span className="text-[#8b949e]">{label}</span>
        <span className="text-[#c9d1d9]">
          {formatTokens(used)}&nbsp;/&nbsp;{formatTokens(limit)}
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#30363d]">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

export function TokenUsageSpinbar() {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [limitDraft, setLimitDraft] = useState({ session: '', daily: '', weekly: '' });
  const popupRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(() => {
    const limits = getTokenLimits();
    setSnapshot({
      session: getSessionTokens(),
      daily: getDailyTokens(),
      weekly: getWeeklyTokens(),
      limits,
    });
    setLimitDraft({
      session: String(limits.session),
      daily: String(limits.daily),
      weekly: String(limits.weekly),
    });
  }, []);

  // Initial load + periodic refresh while open
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [open, refresh]);

  // Close popup on outside click
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (!popupRef.current?.contains(target) && !btnRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  function handleLimitChange(key: 'session' | 'daily' | 'weekly', value: string) {
    const updated = { ...limitDraft, [key]: value };
    setLimitDraft(updated);
    const parsed = {
      session: parseInt(updated.session, 10) || 10_000_000,
      daily: parseInt(updated.daily, 10) || 10_000_000,
      weekly: parseInt(updated.weekly, 10) || 50_000_000,
    };
    saveTokenLimits(parsed);
    setSnapshot((prev) => prev ? { ...prev, limits: parsed } : prev);
  }

  const maxPct = snapshot
    ? Math.max(
        usagePct(snapshot.session, snapshot.limits.session),
        usagePct(snapshot.daily, snapshot.limits.daily),
        usagePct(snapshot.weekly, snapshot.limits.weekly),
      )
    : 0;

  return (
    <div className="relative flex items-center">
      <button
        ref={btnRef}
        type="button"
        title="Token usage"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) refresh();
        }}
        className="flex h-[22px] w-[22px] items-center justify-center rounded-md hover:bg-[#1f2630]"
      >
        <Ring pct={maxPct} />
      </button>

      {open && snapshot && (
        <div
          ref={popupRef}
          className="absolute bottom-7 left-1/2 z-50 w-56 -translate-x-1/2 rounded border border-[#30363d] bg-[#161b22] p-3 text-xs font-mono shadow-2xl"
        >
          {/* Header */}
          <div className="mb-2.5 text-[10px] uppercase tracking-widest text-[#58a6ff]">
            Token Usage
          </div>

          {/* Usage bars */}
          <div className="space-y-2.5">
            <UsageRow label="Session" used={snapshot.session} limit={snapshot.limits.session} />
            <UsageRow label="Daily" used={snapshot.daily} limit={snapshot.limits.daily} />
            <UsageRow label="Weekly" used={snapshot.weekly} limit={snapshot.limits.weekly} />
          </div>

          {/* Settings section */}
          <div className="mt-2.5 flex items-center justify-between border-t border-[#30363d] pt-2">
            <span className="text-[10px] uppercase tracking-wider text-[#6e7681]">Settings</span>
            <button
              type="button"
              onClick={() => setSettingsOpen((s) => !s)}
              className="text-[10px] text-[#58a6ff] underline underline-offset-2 hover:text-[#79b8ff]"
            >
              {settingsOpen ? 'close' : 'open'}
            </button>
          </div>

          {settingsOpen && (
            <div className="mt-2 space-y-2">
              {(['session', 'daily', 'weekly'] as const).map((key) => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <label className="whitespace-nowrap text-[10px] text-[#8b949e]">
                    {key.charAt(0).toUpperCase() + key.slice(1)} limit
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={limitDraft[key]}
                    onChange={(e) => handleLimitChange(key, e.target.value)}
                    className="w-24 rounded border border-[#30363d] bg-[#0d1117] px-1.5 py-0.5 text-[10px] text-[#e6edf3] outline-none focus:border-[#58a6ff]"
                  />
                </div>
              ))}
              <p className="text-[9px] text-[#6e7681]">Auto-saved · default: 10M / 10M / 50M</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
