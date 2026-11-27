"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import meta from "../../../public/shots/meta.json";

type Meta = { spot: number; target: [number, number][]; certifiedBound: number; maxErrorAt: number; solveMs: number; capitalLocked: number; holdings: { base: number } };
const m = meta as unknown as Meta;
const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

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

/**
 * Hero: copy on the left, the Studio on a tilted screen on the right with glass cards quoting the
 * same compile. Background layers (moon, terrain) and the screen follow the pointer slightly.
 */
export function Hero() {
  const root = useRef<HTMLElement>(null);
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
    <section ref={root} className="hero relative isolate flex min-h-dvh items-center overflow-hidden pt-16" aria-label="Introduction">
      {/* background */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-bg" aria-hidden>
        <img src="/bg/moon.jpg" alt="" className="hero-moon absolute -right-[4%] -top-[14%] h-[108%] w-auto max-w-none mix-blend-lighten [mask-image:radial-gradient(80%_75%_at_72%_32%,black_45%,transparent_95%)]" />
        <img src="/bg/terrain.jpg" alt="" className="hero-terrain absolute inset-x-[-4%] bottom-[-12%] w-[108%] max-w-none mix-blend-lighten [mask-image:linear-gradient(90deg,rgba(0,0,0,0.25)_0%,black_40%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(55%_75%_at_18%_50%,var(--bg)_20%,transparent_75%)]" />
        <div className="hero-glow absolute right-[6%] top-[22%] h-[62%] w-[52%]" />
        <div className="absolute inset-x-0 bottom-0 h-[20%] bg-gradient-to-t from-bg to-transparent" />
        <div className="hero-dots absolute left-[3%] top-[14%] h-28 w-48" />
      </div>

      <div className="mx-auto grid w-full max-w-[1480px] items-center gap-12 px-5 py-16 sm:px-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-6 lg:py-0">
        {/* copy */}
        <div className="relative z-10">
          <div className="hero-in flex items-center gap-4" style={{ animationDelay: "80ms" }}>
            <svg viewBox="0 0 397.7 311.7" className="sol-mark h-[14px] w-auto" role="img" aria-label="Solana">
              <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
              <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
              <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
            </svg>
            <span className="num text-[11px] uppercase tracking-[0.28em] text-ink-2">Built on Solana</span>
            <span className="h-px w-10 bg-line-strong" aria-hidden />
            <span className="num text-[11px] uppercase tracking-[0.28em] text-ink-3">Orca liquidity</span>
          </div>
          <h1 className="hero-in mt-7 font-display text-[clamp(2.6rem,4.4vw,5.2rem)] font-semibold leading-[1.02] tracking-[-0.04em]" style={{ animationDelay: "160ms" }}>
            Draw a payoff. Get it built from <span className="text-ink-3">Orca liquidity.</span>
          </h1>
          <p className="hero-in mt-7 max-w-xl text-[17px] leading-relaxed text-ink-2" style={{ animationDelay: "260ms" }}>
            Set what your SOL should be worth at close, for example <span className="text-ink">10 SOL never below {usd(floor[1], 0)}, gains capped at {usd(cap[1], 0)}</span>.
            FORGE builds that payoff from Orca SOL/USDC liquidity ranges, certifies the worst-case error and opens it as your own on-chain position.
          </p>
          <div className="hero-in mt-9 flex flex-wrap gap-3" style={{ animationDelay: "360ms" }}>
            <Link href="/studio" className="btn btn-primary !px-6 !py-3 !text-[15px]">
              Open the Studio <span aria-hidden>↗</span>
            </Link>
            <Link href="/earn" className="btn btn-ghost !px-6 !py-3 !text-[15px]">Earn as an LP</Link>
          </div>
        </div>

        {/* tilted Studio with cards from the same compile */}
        <div className="hero-stage relative z-0 lg:-mr-10">
          <div className="hero-screen relative overflow-hidden rounded-[10px] border border-[rgba(183,196,214,0.16)] bg-bg shadow-[0_50px_140px_-30px_rgba(5,6,8,0.95),0_0_80px_-10px_rgba(183,196,214,0.10)]">
            <img src="/shots/studio-compiled.jpg" alt="The Studio after compiling a collar on 10 SOL: payoff chart, ranges, cost and certificate" className="block w-full" />
            <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(242,244,248,0.07),transparent_32%)]" />
            <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_60px_10px_rgba(16,18,22,0.85)]" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-bg/90 to-transparent" />
          </div>

          <div className="hero-card float-a absolute -bottom-10 left-[-4%] w-[min(300px,52%)] sm:left-[-6%]">
            <div className="cap">Collar · {m.holdings.base} SOL</div>
            <div className="mt-1 flex items-end justify-between gap-3">
              <div>
                <div className="num text-[22px] font-medium leading-none">{usd(floor[1], 0)}</div>
                <div className="cap mt-1.5">floor below {usd(floor[0])}</div>
              </div>
              <Sparkline className="h-10 w-28" />
            </div>
          </div>

          <div className="hero-card float-b absolute -right-2 bottom-[18%] hidden w-[250px] sm:block lg:-right-6">
            <div className="cap">Certified max error</div>
            <div className="num mt-1 text-[26px] font-medium leading-none">±{usd(m.certifiedBound)}</div>
            <div className="cap mt-1.5">on a {usd(floor[1], 0)}–{usd(cap[1], 0)} payoff · {m.solveMs} ms</div>
          </div>

          <div className="hero-card float-c absolute -top-8 right-[8%] hidden w-[210px] md:block">
            <div className="cap">SOL/USDC at snapshot</div>
            <div className="num mt-1 text-[22px] font-medium leading-none">{usd(m.spot)}</div>
            <div className="cap mt-1.5">Orca Whirlpool</div>
          </div>
        </div>
      </div>
    </section>
  );
}
