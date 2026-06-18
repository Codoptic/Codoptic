'use client';

import React, { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  CODE_SPACE_AGENT_MODES,
  getCodeSpaceAgentModeMeta,
  normalizeCodeSpaceAgentMode,
  type CodeSpaceAgentMode,
} from '@/lib/code-space/agentModes';
import {
  CODE_SPACE_DROPDOWN_OPTION_DESCRIPTION_CLASS,
  CODE_SPACE_DROPDOWN_OPTION_TEXT_CLASS,
  CODE_SPACE_TOOLBAR_CHIP_BASE,
} from './codeSpaceDropdownStyles';

interface AgentModeSelectorProps {
  mode: CodeSpaceAgentMode;
  disabled?: boolean;
  onChange: (mode: CodeSpaceAgentMode) => void;
}

export function AgentModeSelector({ mode, disabled = false, onChange }: AgentModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const activeMode = normalizeCodeSpaceAgentMode(mode);
  const activeMeta = getCodeSpaceAgentModeMeta(activeMode);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const handleButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
    if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const selectMode = (nextMode: CodeSpaceAgentMode) => {
    onChange(nextMode);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleButtonKeyDown}
        title={activeMeta.description}
        className={`${CODE_SPACE_TOOLBAR_CHIP_BASE} disabled:border-[#30363d] disabled:bg-[#161b22] disabled:text-[#6e7681] ${activeMeta.buttonClassName}`}
      >
        <span>{activeMeta.label}</span>
        <ChevronDown size={8} className="opacity-70" aria-hidden="true" />
      </button>
      {open && !disabled && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Agent mode"
          className="absolute bottom-6 right-0 z-20 w-52 overflow-hidden rounded border border-[#30363d] bg-[#0d1117] py-1 shadow-xl"
        >
          {CODE_SPACE_AGENT_MODES.map((nextMode) => {
            const meta = getCodeSpaceAgentModeMeta(nextMode);
            const selected = nextMode === activeMode;
            return (
              <button
                key={nextMode}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => selectMode(nextMode)}
                className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${meta.menuItemClassName}`}
              >
                <Check size={12} className={`mt-0.5 ${selected ? meta.accentClassName : 'text-transparent'}`} aria-hidden="true" />
                <span className={CODE_SPACE_DROPDOWN_OPTION_TEXT_CLASS}>
                  <span className={`block text-[9px] font-medium ${meta.accentClassName}`}>{meta.label}</span>
                  <span className={CODE_SPACE_DROPDOWN_OPTION_DESCRIPTION_CLASS}>{meta.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
