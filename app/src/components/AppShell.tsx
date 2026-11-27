"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { WalletButton } from "./WalletButton";

const NAV = [
  { href: "/studio", label: "Studio" },
  { href: "/positions", label: "Positions" },
  { href: "/earn", label: "Earn" },
];

/** App chrome: haze background, one framed window with a top bar, like a desktop terminal. */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="haze min-h-dvh px-3 py-3 sm:px-6 sm:py-6">
      <div className="frame mx-auto max-w-[1440px] overflow-hidden backdrop-blur-sm">
        <header className="flex h-14 items-center gap-6 border-b border-line px-4 sm:px-5">
          <Logo />
          <nav className="flex h-full items-stretch gap-5 text-[13px]">
            {NAV.map((n) => {
              const on = path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} className={`relative flex items-center transition-colors ${on ? "text-ink" : "text-ink-3 hover:text-ink"}`}>
                  {n.label}
                  {on && <span className="absolute inset-x-0 -bottom-px h-px bg-ink" />}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="tag hidden sm:inline-flex" title="All balances are fork-only test funds">
              <span className="size-1.5 bg-warn" /> Fork
            </span>
            <WalletButton />
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Sub-header row inside the frame: title on the left, controls on the right. */
export function Bar({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 sm:px-5">
      <h1 className="text-[13px] font-semibold">{title}</h1>
      {meta && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">{meta}</div>}
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
