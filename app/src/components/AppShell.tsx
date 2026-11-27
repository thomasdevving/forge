"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
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
  // Designed at 1440x900. Smaller desktop screens get the same layout scaled down (to 80% at most),
  // so text and controls keep their proportions instead of crowding the chart.
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const on = () => {
      const fit = Math.min(window.innerWidth / 1440, window.innerHeight / 880);
      setZoom(window.innerWidth >= 1024 ? Number(Math.min(1, Math.max(0.8, fit)).toFixed(3)) : 1);
    };
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return (
    <div
      className="haze min-h-dvh px-3 py-3 sm:px-6 sm:py-5 lg:h-dvh lg:min-h-0"
      style={zoom < 1 ? { zoom, height: `calc(100dvh / ${zoom})` } : undefined}
    >
      <div className="frame mx-auto flex max-w-[1520px] flex-col overflow-hidden backdrop-blur-sm lg:h-full">
        <header className="flex h-14 shrink-0 items-center gap-6 border-b border-line px-4 sm:px-5">
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
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

/** Sub-header row inside the frame: title on the left, controls on the right. */
export function Bar({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 sm:px-5">
      <h1 className="text-[13px] font-semibold">{title}</h1>
      {meta && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">{meta}</div>}
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
