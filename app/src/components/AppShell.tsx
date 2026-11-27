"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { WalletButton } from "./WalletButton";

const NAV = [
  { href: "/studio", label: "Studio" },
  { href: "/positions", label: "Positions" },
  { href: "/earn", label: "Earn" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
          <Logo />
          <nav className="ml-2 flex items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${path.startsWith(n.href) ? "bg-sunk text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="pill hidden border-warn/40 bg-warn-soft text-warn sm:inline-flex" title="All balances are fork-only test funds">
              <span className="size-1.5 rounded-full bg-warn" /> Surfpool fork
            </span>
            <ThemeToggle />
            <WalletButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
