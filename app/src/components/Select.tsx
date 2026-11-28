"use client";

import { useEffect, useId, useRef, useState } from "react";

export type Option = { value: string; label: string };

type Props = {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  "aria-label": string;
  className?: string;
};

/**
 * A dropdown drawn by the page instead of the OS, so it matches the rest of the app and shows up in
 * screen recordings. Keyboard: arrows move, Enter or Space picks, Escape closes, Home and End jump.
 */
export function Select({ value, options, onChange, className = "", ...rest }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, options, value]);

  const pick = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
    button.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const step: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => pick(active),
      " ": () => pick(active),
      Escape: () => setOpen(false),
      Tab: () => setOpen(false),
    };
    if (step[e.key]) {
      if (e.key !== "Tab") e.preventDefault();
      step[e.key]!();
    }
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        className="input flex items-center justify-between gap-2 text-left"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={rest["aria-label"]}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKey}
      >
        <span className="truncate">{current?.label ?? ""}</span>
        <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      {open && (
        <ul
          id={id}
          role="listbox"
          aria-label={rest["aria-label"]}
          className="absolute left-0 top-[calc(100%+4px)] z-50 min-w-full overflow-hidden rounded-[3px] border border-line-strong bg-elev py-1 shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(i)}
              className={`num flex cursor-pointer items-center justify-between gap-4 whitespace-nowrap px-2.5 py-1.5 text-[13px] ${i === active ? "bg-line text-ink" : "text-ink-2"}`}
            >
              {o.label}
              {o.value === value && <span className="text-accent" aria-hidden>✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
