"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Logo } from "./Logo";
import { Tour } from "./Tour";
import { WalletButton } from "./WalletButton";
import { tourFor, tourUnseen } from "@/lib/tour";
import { useWallet } from "@/lib/wallet";

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
  // each page has its own walkthrough: it starts by itself on the first visit, and from the Tour button after that
  const tour = tourFor(path);
  const [touring, setTouring] = useState(false);
  const endTour = useCallback(() => setTouring(false), []);
  useEffect(() => {
    if (!tour || !tourUnseen(tour)) return;
    const t = setTimeout(() => setTouring(true), 500);
    return () => clearTimeout(t);
  }, [tour]);
  return (
    <div
      className="haze min-h-dvh px-3 py-3 sm:px-6 sm:py-5 lg:h-dvh lg:min-h-0"
      style={zoom < 1 ? { zoom, height: `calc(100dvh / ${zoom})` } : undefined}
    >
      <div className="frame mx-auto flex max-w-[1520px] flex-col overflow-hidden backdrop-blur-sm lg:h-full">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-2 sm:h-14 sm:flex-nowrap sm:px-5 sm:py-0">
          <Logo />
          <nav className="flex items-stretch gap-5 self-stretch text-[13px]">
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
            {tour && (
              <button
                className="btn btn-ghost !px-2 !py-1.5 !text-[12px] text-ink-2"
                onClick={() => setTouring(true)}
                aria-label="Show the tour of this page"
                title="Walk through this page step by step"
              >
                <span aria-hidden className="grid size-4 place-items-center border border-line-strong text-[10px] font-semibold leading-none">?</span>
                <span className="hidden sm:inline">Tour</span>
              </button>
            )}
            <SimulationBadge />
            <WalletButton />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
      {tour && <Tour id={tour} open={touring} onClose={endTour} />}
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

/** Always visible: everything in the app runs on a fork with simulated balances. */
function SimulationBadge() {
  const w = useWallet();
  const text = w.kind === "mirror" ? "Simulation: your portfolio, no real funds" : w.kind === "demo" ? "Simulation: demo funds" : "Simulation on a mainnet fork";
  return (
    <span data-tour="sim-badge" className="tag !border-warn/60 !text-warn" title="Every action runs on a Surfpool fork of Solana mainnet. Nothing touches real funds.">
      <span className="size-1.5 animate-pulse bg-warn" /> <span className="hidden sm:inline">{text}</span><span className="sm:hidden">Simulation</span>
    </span>
  );
}
