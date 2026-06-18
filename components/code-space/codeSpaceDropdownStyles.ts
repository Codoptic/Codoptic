// Root Cause vs Logic: these dropdowns live inside fixed-width popovers, so the option text column needs to be flexible
// and the description needs to wrap; otherwise longer copy is clipped by the popover's overflow handling.
export const CODE_SPACE_DROPDOWN_OPTION_TEXT_CLASS = 'min-w-0 flex-1';

export const CODE_SPACE_DROPDOWN_OPTION_DESCRIPTION_CLASS =
  'block text-[8px] leading-3 text-[#8b949e] whitespace-normal break-words';

export const CODE_SPACE_TOOLBAR_CHIP_BASE =
  'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-1.5 font-sans text-[8.5px] font-medium leading-none tracking-normal transition disabled:cursor-not-allowed disabled:opacity-50';
