'use client';

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  CODE_SPACE_EXECUTION_POLICIES,
  getCodeSpaceExecutionPolicyMeta,
  normalizeCodeSpaceExecutionPolicy,
  type CodeSpaceExecutionPolicy,
} from '@/lib/code-space/executionPolicy';
import {
  CODE_SPACE_DROPDOWN_OPTION_DESCRIPTION_CLASS,
  CODE_SPACE_DROPDOWN_OPTION_TEXT_CLASS,
  CODE_SPACE_TOOLBAR_CHIP_BASE,
} from './codeSpaceDropdownStyles';

// Root Cause vs Logic: The selector component was missing, so Next.js failed while resolving the import; adding
// this dropdown exposes the existing execution policy options without changing the surrounding layout.
interface ExecutionPolicySelectorProps {
  policy: CodeSpaceExecutionPolicy;
  disabled?: boolean;
  onChange: (policy: CodeSpaceExecutionPolicy) => void;
}

export function ExecutionPolicySelector({
  policy,
  disabled = false,
  onChange,
}: ExecutionPolicySelectorProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const activePolicy = normalizeCodeSpaceExecutionPolicy(policy);
  const meta = getCodeSpaceExecutionPolicyMeta(activePolicy);

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

  const selectPolicy = (nextPolicy: CodeSpaceExecutionPolicy) => {
    onChange(nextPolicy);
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
        title={meta.description}
        className={`${CODE_SPACE_TOOLBAR_CHIP_BASE} disabled:border-[#30363d] disabled:bg-[#161b22] disabled:text-[#6e7681] ${meta.buttonClassName}`}
      >
        <span>{meta.label}</span>
        <ChevronDown size={8} className="opacity-70" aria-hidden="true" />
      </button>

      {open && !disabled && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Execution policy"
          className="absolute bottom-6 right-0 z-20 w-52 overflow-hidden rounded border border-[#30363d] bg-[#0d1117] py-1 shadow-xl"
        >
          {CODE_SPACE_EXECUTION_POLICIES.map((nextPolicy) => {
            const optionMeta = getCodeSpaceExecutionPolicyMeta(nextPolicy);
            const selected = nextPolicy === activePolicy;
            return (
              <button
                key={nextPolicy}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => selectPolicy(nextPolicy)}
                className={`flex w-full items-start gap-2 px-2 py-1.5 text-left ${optionMeta.menuItemClassName}`}
              >
                <Check size={12} className={`mt-0.5 ${selected ? optionMeta.accentClassName : 'text-transparent'}`} aria-hidden="true" />
                <span className={CODE_SPACE_DROPDOWN_OPTION_TEXT_CLASS}>
                  <span className={`block text-[9px] font-medium ${optionMeta.accentClassName}`}>{optionMeta.label}</span>
                  <span className={CODE_SPACE_DROPDOWN_OPTION_DESCRIPTION_CLASS}>{optionMeta.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
