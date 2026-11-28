"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { config } from "@/lib/config";
import { ModeNavLinks } from "./mode";

/** The top menu's links on phones, where the inline menu does not fit. */
export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const link = "block border-b border-line px-4 py-3 last:border-b-0 hover:bg-sunk";
  return (
    <div ref={box} className="relative md:hidden">
      <button className="btn btn-ghost !px-3 !py-1.5" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)}>
        Menu
      </button>
      {open && (
        // a click on any link closes the menu (hash links stay on the page)
        <nav id="mobile-menu" className="fixed inset-x-4 top-[60px] border border-line-strong bg-bg text-[15px] text-ink-2 shadow-[0_24px_48px_rgba(0,0,0,0.45)]" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          <ModeNavLinks className={link} />
          <Link href="/proof" className={link}>Proof</Link>
          <Link href="/docs" className={link}>Docs</Link>
          <a href={config.repoUrl} className={link} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      )}
    </div>
  );
}
