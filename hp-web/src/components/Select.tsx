"use client";

import type { ReactNode } from "react";
import { Select as BaseSelect } from "@base-ui/react/select";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

// Styled wrapper over Base UI's Select with the controlled string-value shape
// of a native <select>. Chrome (border, popup) is built in; call sites pass
// sizing and typography for the trigger, and popupClassName when the popup
// text should differ from the text-sm default.
export default function Select({
  value,
  onChange,
  options,
  ariaLabel,
  className = "",
  popupClassName = "text-sm",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  className?: string;
  popupClassName?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      items={options}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={`flex cursor-default select-none items-center justify-between gap-2 rounded-md border border-neutral-300 bg-transparent outline-none focus-visible:border-neutral-500 dark:border-neutral-700 ${className}`}
      >
        <BaseSelect.Value className="truncate" />
        <BaseSelect.Icon className="flex shrink-0 text-neutral-400">
          <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50 outline-none" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup
            className={`max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg outline-none dark:border-neutral-800 dark:bg-neutral-950 ${popupClassName}`}
          >
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="grid cursor-default select-none grid-cols-[1rem_1fr] items-center gap-1 py-1 pl-2 pr-4 data-disabled:opacity-50 data-highlighted:bg-neutral-100 dark:data-highlighted:bg-neutral-800/80"
              >
                <BaseSelect.ItemIndicator className="col-start-1 flex justify-center">
                  <svg className="size-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                    <path d="M2 6.5 4.7 9l5-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText className="col-start-2 truncate">{o.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
