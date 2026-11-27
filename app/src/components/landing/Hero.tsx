"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import agents from "@/data/agents.json";
import meta from "../../../public/shots/meta.json";
import { AgentTerminal } from "./AgentTerminal";
import { LivePrice } from "./LivePrice";
import { Stars } from "./Stars";

type Mode = "people" | "agents";
const MODE_EVENT = "forge:hero-mode";
const tr = agents.treasury.result;

/** Writes the hero mode into the URL (?for=agents) without a navigation, keeping the hash. */
function writeMode(mode: Mode, dropHash = false) {
  const url = new URL(window.location.href);
  if (dropHash) url.hash = "";
  if (mode === "agents") url.searchParams.set("for", "agents");
  else url.searchParams.delete("for");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

/** Link elsewhere on the landing that switches the hero to the agent run and scrolls up to it. */
export function ShowAgentRun({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <a
      href="/?for=agents"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        writeMode("agents", true);
        window.dispatchEvent(new CustomEvent<Mode>(MODE_EVENT, { detail: "agents" }));
        window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }}
    >
      {children}
    </a>
  );
}

/** Two-way mode switch: each option has an icon and a one-line description; the indicator slides
 * under the active one. The agents side pulses quietly until it has been opened once. */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const [seenAgents, setSeenAgents] = useState(false);
  useEffect(() => {
    if (mode === "agents") setSeenAgents(true);
  }, [mode]);
  const opts: { m: Mode; label: string; sub: string; icon: ReactNode }[] = [
    {
      m: "people",
      label: "For people",
      sub: "Draw it or describe it",
      icon: (
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <path d="M2 12.5c2.2-.2 3.4-4.8 5.2-4.8 1.6 0 1.8 2.6 3.4 2.6 1.3 0 2.3-2.4 3.4-5.8" strokeLinecap="round" />
          <circle cx="7.2" cy="7.7" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      m: "agents",
      label: "For agents",
      sub: "Pay per request · x402",
      icon: (
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="1.5" y="2.5" width="13" height="11" />
          <path d="M4.5 6.5 6.8 8.5 4.5 10.5M8.5 10.5h3" strokeLinecap="square" />
        </svg>
      ),
    },
  ];
  return (
    <div role="group" aria-label="Show FORGE for" className="relative inline-grid grid-cols-2 border border-line-strong bg-panel/70 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur-md">
      <span
        aria-hidden
        className="absolute inset-y-1 left-1 w-[calc(50%-4px)] bg-ink shadow-[0_0_0_1px_rgba(242,244,248,0.25),0_6px_24px_rgba(183,196,214,0.25)] transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
        style={{ transform: mode === "agents" ? "translateX(100%)" : "none" }}
      />
      {opts.map(({ m, label, sub, icon }) => {
        const on = mode === m;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(m)}
            className={`relative z-10 flex items-center gap-2.5 px-3.5 py-2 text-left transition-colors duration-300 sm:px-4 sm:py-2.5 ${on ? "text-bg" : "text-ink-2 hover:text-ink"}`}
          >
            <span className="relative shrink-0">
              {icon}
              {m === "agents" && !on && !seenAgents && (
                <span aria-hidden className="absolute -right-1 -top-1 size-1.5 animate-pulse bg-accent motion-reduce:animate-none" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold leading-tight">{label}</span>
              <span className={`mt-0.5 block whitespace-nowrap font-mono text-[10.5px] leading-tight ${on ? "text-bg/70" : "text-ink-3"}`}>{sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Stacks its children in one grid cell; only the active one is visible, focusable and announced. */
function Layer({ on, ready, className = "", children }: { on: boolean; ready: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      inert={!on}
      aria-hidden={!on}
      className={`min-w-0 [grid-area:1/1] ${ready ? "transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none" : ""} ${
        on ? "opacity-100" : "pointer-events-none translate-y-2 opacity-0 blur-[3px]"
      } ${className}`}
    >
      {children}
    </div>
  );
}

type Meta = { market: string; base: string; swapPool: string; spot: number; target: [number, number][]; certifiedBound: number; maxErrorAt: number; solveMs: number; capitalLocked: number; holdings: { base: number } };
const m = meta as unknown as Meta;
const units = m.holdings.base.toLocaleString("en-US");
const usd = (n: number, d = Math.abs(n) < 1 ? 4 : 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/** The collar from the snapshot, as a small polyline. */
function Sparkline({ className = "" }: { className?: string }) {
  const pts = m.target;
  const [x0, x1] = [pts[0]![0], pts[pts.length - 1]![0]];
  const ys = pts.map((p) => p[1]);
  const [y0, y1] = [Math.min(...ys) * 0.9, Math.max(...ys) * 1.04];
  const d = pts.map((p, i) => `${i ? "L" : "M"}${(((p[0] - x0) / (x1 - x0)) * 120).toFixed(1)},${(40 - ((p[1] - y0) / (y1 - y0)) * 40).toFixed(1)}`).join("");
  return (
    <svg viewBox="-2 -2 124 44" className={className} aria-hidden>
      <path d={d} fill="none" stroke="var(--ink)" strokeWidth="1.6" />
      <line x1={((m.spot - x0) / (x1 - x0)) * 120} x2={((m.spot - x0) / (x1 - x0)) * 120} y1="0" y2="40" stroke="var(--ink-3)" strokeDasharray="2 3" />
    </svg>
  );
}

/** "Built on Solana" line above the headline. */
function Eyebrow({ right }: { right: string }) {
  return (
    <div className="hero-in flex flex-wrap items-center gap-x-4 gap-y-2" style={{ animationDelay: "80ms" }}>
      <svg viewBox="0 0 397.7 311.7" className="sol-mark h-[14px] w-auto" role="img" aria-label="Solana">
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </svg>
      <span className="num text-[11px] uppercase tracking-[0.28em] text-ink-2">Built on Solana</span>
      <span className="h-px w-10 bg-line-strong" aria-hidden />
      <span className="num text-[11px] uppercase tracking-[0.28em] text-ink-3">{right}</span>
    </div>
  );
}

/**
 * Hero: copy on the left, the Studio on a tilted screen on the right with glass cards quoting the
 * same compile. Background layers (moon, terrain) and the screen follow the pointer slightly. A toggle
 * (?for=agents) swaps copy and screen for FORGE for agents: the treasury agent's real run in a terminal.
 */
export function Hero() {
  const root = useRef<HTMLElement>(null);
  const [mode, setModeState] = useState<Mode>("people");
  const [ready, setReady] = useState(false);
  const setMode = (m: Mode) => {
    setModeState(m);
    writeMode(m);
  };
  // The server renders the human hero; the URL (?for=agents) picks the mode once mounted, without a transition.
  useEffect(() => {
    const read = () => setModeState(new URLSearchParams(window.location.search).get("for") === "agents" ? "agents" : "people");
    read();
    const raf = requestAnimationFrame(() => setReady(true));
    const onEvent = (e: Event) => setModeState((e as CustomEvent<Mode>).detail);
    window.addEventListener("popstate", read);
    window.addEventListener(MODE_EVENT, onEvent);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("popstate", read);
      window.removeEventListener(MODE_EVENT, onEvent);
    };
  }, []);
  const agentsOn = mode === "agents";
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const on = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--mx", ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
        el.style.setProperty("--my", ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
      });
    };
    const sc = () => el.style.setProperty("--sy", String(Math.min(1, window.scrollY / window.innerHeight)));
    window.addEventListener("pointermove", on, { passive: true });
    window.addEventListener("scroll", sc, { passive: true });
    return () => {
      window.removeEventListener("pointermove", on);
      window.removeEventListener("scroll", sc);
      cancelAnimationFrame(raf);
    };
  }, []);

  const floor = m.target[1]!, cap = m.target[2]!;

  return (
    <section ref={root} className="hero relative isolate flex min-h-dvh items-center overflow-hidden pt-14" aria-label="Introduction">
      {/* background */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-bg" aria-hidden>
        <Stars className="hero-stars absolute inset-0 h-full w-full [mask-image:radial-gradient(circle_at_86%_30%,transparent_0,transparent_36vh,black_44vh)]" />
        <img src="/bg/moon.jpg" alt="" className="hero-moon absolute -right-[4%] -top-[14%] h-[108%] w-auto max-w-none mix-blend-lighten [mask-image:radial-gradient(80%_75%_at_72%_32%,black_45%,transparent_95%)]" />
        <img src="/bg/terrain.jpg" alt="" className="hero-terrain absolute inset-x-[-4%] bottom-[-12%] w-[108%] max-w-none mix-blend-lighten [mask-image:linear-gradient(90deg,rgba(0,0,0,0.25)_0%,black_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(55%_75%_at_18%_50%,var(--bg)_20%,transparent_75%)]" />
        <div className="hero-glow absolute right-[6%] top-[22%] h-[62%] w-[52%]" />
        <div className="absolute inset-x-0 bottom-0 h-[20%] bg-gradient-to-t from-bg to-transparent" />
        <div className="hero-dots absolute left-[3%] top-[14%] h-28 w-48" />
      </div>

      <div className="mx-auto grid w-full max-w-[1480px] items-center gap-12 px-5 py-16 sm:px-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-6 lg:py-[4vh]">
        {/* copy */}
        <div className="relative z-10">
          <div className="hero-in" style={{ animationDelay: "40ms" }}>
            <ModeToggle mode={mode} onChange={setMode} />
          </div>
          <div className="mt-[min(2rem,3.5vh)] grid grid-cols-[minmax(0,1fr)]">
            <Layer on={!agentsOn} ready={ready}>
              <Eyebrow right="Any Orca token" />
              <h1 className="hero-in mt-[min(1.75rem,3vh)] font-display text-[clamp(2.2rem,min(4.2vw,7.4vh),5.2rem)] font-semibold leading-[1.02] tracking-[-0.04em]" style={{ animationDelay: "160ms" }}>
                Trade options on tokens <span className="text-ink-3">that don&apos;t have any.</span>
              </h1>
              <p className="hero-in mt-[min(1.75rem,3vh)] max-w-xl text-[clamp(14px,min(1.15vw,2.5vh),17px)] leading-relaxed text-ink-2" style={{ animationDelay: "260ms" }}>
                Choose how much you can lose and how much you can gain, and Forge builds it from the token&apos;s trading liquidity. Or provide that
                liquidity yourself and earn extra on top of your fees.
              </p>
              <div className="hero-in mt-[min(2.25rem,4vh)] flex flex-wrap gap-3" style={{ animationDelay: "360ms" }}>
                <Link href="/studio" className="btn btn-primary !px-6 !py-3 !text-[15px]">
                  Launch App <span aria-hidden>↗</span>
                </Link>
                <Link href="/earn" className="btn btn-ghost !px-6 !py-3 !text-[15px]">Earn as an LP</Link>
              </div>
            </Layer>
            <Layer on={agentsOn} ready={ready}>
              <Eyebrow right="x402 · USDC per request" />
              <h1 className="hero-in mt-[min(1.75rem,3vh)] font-display text-[clamp(2.2rem,min(4.2vw,7.4vh),5.2rem)] font-semibold leading-[1.02] tracking-[-0.04em]" style={{ animationDelay: "160ms" }}>
                Certified hedges, <span className="text-ink-3">sold to agents per request.</span>
              </h1>
              <p className="hero-in mt-[min(1.75rem,3vh)] max-w-xl text-[clamp(14px,min(1.15vw,2.5vh),17px)] leading-relaxed text-ink-2" style={{ animationDelay: "260ms" }}>
                Programs and AI agents pay in USDC over x402, with no account and no API key. They describe a hedge, FORGE&apos;s compiler builds
                and certifies it, and the buyer signs the open with its own key.
              </p>
              <div className="hero-in mt-[min(2.25rem,4vh)] flex flex-wrap gap-3" style={{ animationDelay: "360ms" }}>
                <Link href="/docs/agents" className="btn btn-primary !px-6 !py-3 !text-[15px]">
                  Read the agent docs <span aria-hidden>→</span>
                </Link>
                <Link href="/studio" className="btn btn-ghost !px-6 !py-3 !text-[15px]">Ask the Architect</Link>
              </div>
            </Layer>
          </div>
        </div>

        {/* tilted Studio with cards from the same compile, or the treasury agent's run */}
        <div className="hero-stage relative z-0 mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[calc((100dvh-140px)*1.72)] lg:ml-[-2rem] lg:mr-auto lg:w-full">
          <Layer on={!agentsOn} ready={ready} className="relative [perspective:1800px]">
            <div className="hero-screen relative overflow-hidden rounded-[10px] border border-[rgba(183,196,214,0.16)] bg-bg shadow-[0_50px_140px_-30px_rgba(5,6,8,0.95),0_0_80px_-10px_rgba(183,196,214,0.10)]">
              <img src="/shots/studio-compiled.jpg" alt={`The Studio after compiling a collar on ${units} ${m.base}: payoff chart, ranges, cost and certificate`} className="block w-full" />
              <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(242,244,248,0.07),transparent_32%)]" />
              <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_60px_10px_rgba(16,18,22,0.85)]" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-bg/90 to-transparent" />
            </div>

            <div className="hero-card float-a absolute -bottom-6 left-[-4%] w-[min(280px,46%)] sm:left-[-6%]">
              <div className="cap">Collar · {units} {m.base}</div>
              <div className="mt-1 flex items-end justify-between gap-3">
                <div>
                  <div className="num text-[22px] font-medium leading-none">{usd(floor[1], 0)}</div>
                  <div className="cap mt-1.5">floor below {usd(floor[0])}</div>
                </div>
                <Sparkline className="h-10 w-28" />
              </div>
            </div>

            <div className="hero-card float-b absolute -right-2 bottom-[18%] hidden w-[min(240px,40%)] sm:block lg:-right-6">
              <div className="cap">Certified max error</div>
              <div className="num mt-1 text-[26px] font-medium leading-none">±{usd(m.certifiedBound)}</div>
              <div className="cap mt-1.5">on a {usd(floor[1], 0)}–{usd(cap[1], 0)} payoff · {m.solveMs} ms</div>
            </div>

            <div className="hero-card float-c absolute -top-6 right-[8%] hidden w-[min(220px,36%)] md:block">
              <LivePrice base={m.base} quote={m.market.split("/")[1] ?? "USDC"} pool={m.swapPool} units={m.holdings.base} spot={m.spot} target={m.target} />
            </div>
          </Layer>

          <Layer on={agentsOn} ready={ready} className="relative [perspective:1800px]">
            <div className="hero-screen relative overflow-hidden rounded-[10px] border border-[rgba(183,196,214,0.16)] bg-bg shadow-[0_50px_140px_-30px_rgba(5,6,8,0.95),0_0_80px_-10px_rgba(183,196,214,0.10)]">
              <AgentTerminal active={agentsOn} />
              <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(242,244,248,0.05),transparent_32%)]" />
            </div>

            <div className="hero-card float-a absolute -bottom-6 left-[-6%] hidden w-[min(250px,46%)] sm:block">
              <div className="cap">x402 · paid per request</div>
              <div className="num mt-1 text-[22px] font-medium leading-none">${tr.apiSpendUsd.toFixed(2)}</div>
              <div className="cap mt-1.5">USDC, settled on the fork before the work ran</div>
            </div>

            <div className="hero-card float-b absolute -right-2 bottom-[22%] hidden w-[min(240px,40%)] sm:block lg:-right-6">
              <div className="cap">Certified max error</div>
              <div className="num mt-1 text-[26px] font-medium leading-none">±${tr.certifiedErrorUsd.toFixed(2)}</div>
              <div className="cap mt-1.5">put on {tr.units.toLocaleString("en-US")} {tr.base} · tolerance ${tr.toleranceUsd.toFixed(2)}</div>
            </div>

            <div className="hero-card float-c absolute -top-6 right-[8%] hidden w-[min(220px,36%)] md:block">
              <div className="cap">Opened after human approval</div>
              <div className="num mt-1 text-[22px] font-medium leading-none">{tr.transactions} transactions</div>
              <div className="cap mt-1.5 truncate">certificate {tr.certificate.slice(0, 10)}…</div>
            </div>
          </Layer>
        </div>
      </div>
    </section>
  );
}
