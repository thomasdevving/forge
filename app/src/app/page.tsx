import Link from "next/link";
import bench from "@/data/benchmarks.json";
import { HeroGraphic } from "@/components/landing/HeroGraphic";
import { Hero } from "@/components/landing/Hero";
import { LiveStrip } from "@/components/landing/LiveStrip";
import { CountUp, Reveal } from "@/components/landing/Reveal";
import { type Step, Walkthrough } from "@/components/landing/Walkthrough";
import { Logo } from "@/components/Logo";
import { NavShell } from "@/components/landing/NavShell";
import { config } from "@/lib/config";
import shotMeta from "../../public/shots/meta.json";

type Summary = Record<string, { payoffs: number; feasible: number; median_relative_error_bps: number | null; mean_legs: number | null }>;
const rep = bench.replication as unknown as { run: string; summary: Summary; boundViolations: number } | null;
const real = bench.realized as unknown as { run: string; rows: { payoff: string; move: number; construction: number; gross: number; swapCost: number; bound: number; target: number }[] } | null;
const lp = bench.lpGuarantee as unknown as {
  run: string;
  summary: Record<string, { borrows: number; borrows_eligible: number; borrows_guarantee_holds: number; borrows_guarantee_violations: number; borrows_premium_shortfall: number; restoration_failures_total: number; paths: number }>;
} | null;

const snap = shotMeta as unknown as { openTransactions?: number; spot: number; target: [number, number][]; certifiedBound: number; capitalLocked: number; legs: { kind: string; priceLower: number; priceUpper: number }[] };
const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const FLOOR = snap.target[1]!, CAP = snap.target[2]!;
const PUT = snap.legs.find((l) => l.kind === "borrow_put");

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function Head({ n, kicker, title, intro }: { n: string; kicker: string; title: React.ReactNode; intro?: string }) {
  return (
    <Reveal className="mx-auto grid max-w-[1480px] gap-6 px-5 sm:px-8 lg:grid-cols-[1fr_1fr] lg:items-end">
      <div>
        <div className="num flex items-center gap-3 text-[12px] text-ink-3">
          <span className="text-ink">{n}</span>
          <span className="h-px w-8 bg-line-strong" />
          {kicker}
        </div>
        <h2 className="mt-5 font-display text-[clamp(2rem,4.2vw,3.6rem)] font-semibold leading-[0.98] tracking-[-0.03em]">{title}</h2>
      </div>
      {intro && <p className="max-w-lg text-[15px] leading-relaxed text-ink-2 lg:justify-self-end lg:pb-1">{intro}</p>}
    </Reveal>
  );
}

const TRADER: Step[] = [
  {
    title: "Draw what you want",
    body: `You hold 10 SOL at ${usd(snap.spot)}. You want it never worth less than ${usd(FLOOR[1], 0)}, and you're fine giving up gains above ${usd(CAP[1], 0)}. Pick "Collar" or drag the points yourself.`,
    shot: "/shots/studio-draw.jpg", path: "/studio", alt: "Studio with a collar drawn over the bucket ladder",
  },
  {
    title: "FORGE finds the ranges",
    body: `It borrows LP liquidity just below the floor (${PUT ? `${usd(PUT.priceLower)}–${usd(PUT.priceUpper)}` : "below the price"}) and places your SOL in ranges around the cap. The result matches your line to within ±${usd(snap.certifiedBound)}, checked exactly and written into a certificate.`,
    shot: "/shots/studio-compiled.jpg", path: "/studio", alt: "Compiled collar with cost and certificate",
  },
  {
    title: "Open it on-chain",
    body: `The open is simulated first, then sent as a short series of transactions you sign${snap.openTransactions ? ` (${snap.openTransactions} for this collar)` : ""}. The certificate hash is stored in your position, so anyone can check what you agreed to.`,
    shot: "/shots/studio-open.jpg", path: "/studio", alt: "Open flow with four confirmed steps",
  },
  {
    title: "Close and settle",
    body: "While it is open you see the premium paid against your cap and your current exposure. Closing gives LPs their liquidity back and pays out what the payoff says, from real token balances.",
    shot: "/shots/positions.jpg", path: "/positions", alt: "Open position with legs, premium and greeks",
  },
];

const FAQ = [
  ["Is this an options exchange?", "No order book. Each position is built from Orca liquidity ranges: a borrowed range below the price acts as a put, one above as a call. LPs who deposit into FORGE buckets are the other side and are paid a premium."],
  ["Which tokens work?", "The demo runs one market, SOL/USDC. A market is set up per Orca Whirlpool, so other pools can be added the same way."],
  ["Where do the numbers on this page come from?", "From committed benchmark runs on a Surfpool mainnet fork and ten months of Binance SOL/USDC prices. Nothing is typed in by hand; rerun them with benchmarks/run_all.py --fork."],
  ["What does an LP risk?", "Borrowed liquidity needs a 24-hour notice to withdraw. The guarantee is conditional: finite buffers, capped premium budgets and failed restorations can produce shortfalls, which are recorded and pause new borrowing."],
  ["Is the certified bound the whole cost?", "No. It covers replication error over the stated price range. Premium, pool fees and settlement swap costs are reported separately."],
  ["Are opens and closes atomic?", "Not across batches. Large positions span several transactions; pending states and recovery are explicit and anyone can continue them."],
  ["Can I use it with real funds?", "No. It is unaudited hackathon software that runs on a fork with test funds only."],
] as const;

export default function Landing() {
  const opt = rep?.summary["optimizer/thin"];
  const base = rep?.summary["baseline/thin"];
  const lpAll = lp?.summary["all"];
  const realRows = real?.rows ?? [];

  return (
    <div className="overflow-x-clip bg-bg">
      <NavShell>
        <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-8 px-5 sm:px-8">
          <Logo />
          <nav className="hidden items-center gap-7 text-[14px] text-ink-2 md:flex">
            <a href="#how" className="transition-colors hover:text-ink">How it works</a>
            <Link href="/studio" className="transition-colors hover:text-ink">Studio</Link>
            <a href="#lps" className="transition-colors hover:text-ink">For LPs</a>
            <a href="#proof" className="transition-colors hover:text-ink">Proof</a>
            <a href={`${config.repoUrl}/tree/main/docs`} className="transition-colors hover:text-ink" target="_blank" rel="noreferrer">Docs</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a href={config.repoUrl} className="btn btn-ghost hidden !py-1.5 sm:inline-flex" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" /></svg>
              GitHub
            </a>
            <Link href="/studio" className="btn btn-primary !py-1.5">Launch app <span aria-hidden>↗</span></Link>
          </div>
        </div>
      </NavShell>

      <Hero />

      {/* fork: the hero's screens are real and run here */}
      <section id="fork" className="relative">
        <div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-24 sm:px-8 lg:grid-cols-[1fr_1.6fr] lg:items-center">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="size-1.5 animate-pulse bg-good" />Live right now</div>
            <h2 className="mt-5 font-display text-[clamp(1.9rem,3.4vw,3rem)] font-semibold leading-[1] tracking-[-0.03em]">Running on a copy of Solana mainnet.</h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-2">
              FORGE runs on a Surfpool fork: Orca’s real pools and programs, copied from mainnet, with test money. Prices can be moved to show a crash. Grab free
              fork funds with the demo wallet and try every step. Nothing touches mainnet.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <LiveStrip />
            <p className="cap mt-3">Read from the fork every 15 seconds.</p>
          </Reveal>
        </div>
      </section>

      {/* how */}
      <section id="how" className="scroll-mt-14 pt-28">
        <Head n="01" kicker="How it works" title={<>One example,<br />start to finish.</>} intro="Protecting 10 SOL with a collar. These are real screens from the Studio, captured on the fork." />
        <Walkthrough steps={TRADER} />
      </section>

      {/* idea */}
      <section className="band">
        <div className="mx-auto grid max-w-[1480px] gap-12 px-5 py-24 sm:px-8 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="text-ink">02</span><span className="h-px w-8 bg-line-strong" />The idea</div>
            <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.3rem)] font-semibold leading-[0.98] tracking-[-0.03em]">Concentrated liquidity already is an option.</h2>
            <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-ink-2">
              An Orca range below the price holds only USDC. FORGE borrows it and locks that USDC. If SOL falls through the
              range, giving the liquidity back costs less than what was locked, and you keep the difference. That is a put.
              Do the same above the price with SOL and you get a call.
            </p>
            <div className="num mt-8 border-l border-accent pl-5 text-[14px] leading-8 text-ink-2">
              <div>V(P) = L(2√P − P/√p<sub>b</sub> − √p<sub>a</sub>)</div>
              <div>put = y<sub>escrow</sub> − V(P) ≥ 0</div>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="border border-line bg-bg p-3 sm:p-5">
              <HeroGraphic />
            </div>
          </Reveal>
        </div>
      </section>

      {/* LPs */}
      <section id="lps" className="scroll-mt-14 py-28">
        <Head n="03" kicker="For liquidity providers" title={<>Your liquidity keeps<br />earning, either way.</>} intro="Deposit into a price bucket. While nobody borrows it, it sits in Orca and earns normal fees. When a trader borrows it, they pay you instead." />
        <div className="mx-auto mt-14 grid max-w-[1480px] gap-10 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr] lg:items-start">
          <ol>
            {[
              ["Paid for what you miss", "Borrowers pay at least the fees your liquidity would have earned in Orca, measured on-chain, plus more as the bucket fills up. A minimum rate pays even in quiet markets."],
              ["Same liquidity back", "When the trade closes, the exact liquidity is restored to the pool. If a borrower's budget runs short, the gap is recorded and new borrowing pauses."],
              ["Leave when you want", "Unborrowed liquidity withdraws instantly. Borrowed liquidity needs 24 hours' notice. At most 80% of a bucket can be lent out."],
            ].map(([t, d], i) => (
              <Reveal key={t} delay={i * 80}>
                <li className="grid grid-cols-[2.5rem_1fr] border-t border-line py-6">
                  <span className="num text-[12px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="font-display text-xl font-semibold tracking-tight">{t}</h3>
                    <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{d}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
          <Reveal delay={120}>
            <figure className="overflow-hidden rounded-[6px] border border-line-strong bg-bg">
              <div className="flex h-8 items-center gap-3 border-b border-line px-3">
                <span className="flex gap-1.5" aria-hidden><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /><span className="size-2 bg-line-strong" /></span>
                <span className="num text-[11px] text-ink-3">forge/earn</span>
              </div>
              <img src="/shots/earn.jpg" alt="Earn: out-of-range liquidity, deposit and the bucket ladder" className="aspect-[16/10] w-full object-cover object-top" loading="lazy" />
            </figure>
          </Reveal>
        </div>
      </section>

      {/* proof */}
      <section id="proof" className="glow-top scroll-mt-14 pt-28 pb-24">
        <Head n="04" kicker="Proof" title={<>Measured,<br />not promised.</>} intro="Numbers from benchmark runs on the fork and ten months of SOL prices. One command reproduces them." />
        <div className="mx-auto mt-14 max-w-[1480px] px-5 sm:px-8">
          <Reveal>
            <div className="grid border border-line bg-panel/60 md:grid-cols-3">
              <div className="border-line p-6 md:border-r">
                <div className="cap">Payoffs compiled, thin liquidity</div>
                {opt && base ? (
                  <>
                    <div className="num mt-3 text-5xl font-medium tracking-tight"><CountUp value={opt.feasible} />/{opt.payoffs}</div>
                    <p className="mt-3 text-[13px] text-ink-2">vs <span className="num">{base.feasible}/{base.payoffs}</span> for direct replication at each kink. {rep?.boundViolations === 0 ? "0 certificate bounds violated." : `${rep?.boundViolations} bound violations.`}</p>
                  </>
                ) : <p className="cap mt-3">No results recorded.</p>}
              </div>
              <div className="border-t border-line p-6 md:border-r md:border-t-0">
                <div className="cap">Real positions settled on the fork</div>
                {realRows.length ? (
                  <>
                    <div className="num mt-3 text-5xl font-medium tracking-tight"><CountUp value={realRows.length} /></div>
                    <p className="mt-3 text-[13px] text-ink-2">Realized payoff equals the certified construction minus the measured swap cost. Largest cost <span className="num">${fmt(Math.max(...realRows.map((r) => r.swapCost)), 2)}</span>.</p>
                  </>
                ) : <p className="cap mt-3">No results recorded.</p>}
              </div>
              <div className="border-t border-line p-6 md:border-t-0">
                <div className="cap">LP guarantee holds</div>
                {lpAll ? (
                  <>
                    <div className="num mt-3 text-5xl font-medium tracking-tight"><CountUp value={lpAll.borrows_guarantee_holds} /></div>
                    <p className="mt-3 text-[13px] text-ink-2">of <span className="num">{fmt(lpAll.borrows_eligible)}</span> eligible borrows, <span className="num">{lpAll.borrows_guarantee_violations}</span> violations over {fmt(lpAll.paths)} path runs. Shortfalls reported, not filtered.</p>
                  </>
                ) : <p className="cap mt-3">No results recorded.</p>}
              </div>
            </div>
          </Reveal>
          {realRows.length > 0 && (
            <Reveal delay={100}>
              <div className="mt-6 overflow-x-auto border border-line bg-panel/60">
                <table className="tbl min-w-[680px]">
                  <thead>
                    <tr>{["Payoff", "Close", "Target", "Certified", "Realized", "Swap cost", "Bound"].map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="num">
                    {realRows.map((r, i) => (
                      <tr key={i}>
                        <td className="font-sans">{r.payoff.replace("_", " ")}</td>
                        <td>{r.move}×</td>
                        <td>{fmt(r.target, 2)}</td>
                        <td>{fmt(r.construction, 2)}</td>
                        <td className="text-ink">{fmt(r.gross, 2)}</td>
                        <td className="text-ink-2">{fmt(r.swapCost, 4)}</td>
                        <td className="text-ink-2">±{fmt(r.bound, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="cap border-t border-line px-5 py-3">USD. Run {real?.run}. Premium, fees and swap costs are outside the certified bound.</p>
              </div>
            </Reveal>
          )}
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="scroll-mt-14 py-28">
        <div className="mx-auto grid max-w-[1480px] gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_1.4fr]">
          <Reveal>
            <div className="num flex items-center gap-3 text-[12px] text-ink-3"><span className="text-ink">05</span><span className="h-px w-8 bg-line-strong" />Questions</div>
            <h2 className="mt-5 font-display text-[clamp(2rem,4vw,3.3rem)] font-semibold leading-[0.98] tracking-[-0.03em]">Read this before you trust it.</h2>
            <p className="mt-6 max-w-md text-[14px] leading-relaxed text-ink-3">Prior art: Panoptic builds options from CLMM positions on Ethereum. FORGE adds payoff synthesis, certified error, the bucket ladder and testable LP restoration, on Solana.</p>
          </Reveal>
          <Reveal delay={100}>
            <div className="border-b border-line">
              {FAQ.map(([q, a]) => (
                <details key={q} className="group border-t border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                    {q}
                    <span className="relative size-3 shrink-0" aria-hidden>
                      <span className="absolute inset-x-0 top-1/2 h-px bg-ink-2" />
                      <span className="absolute inset-y-0 left-1/2 w-px bg-ink-2 transition-transform group-open:scale-y-0" />
                    </span>
                  </summary>
                  <p className="max-w-2xl pb-5 text-[14px] leading-relaxed text-ink-2">{a}</p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* cta */}
      <section className="glow-top">
        <div className="mx-auto max-w-[1480px] px-5 py-28 sm:px-8">
          <Reveal>
            <h2 className="max-w-4xl font-display text-[clamp(2.2rem,5.4vw,4.8rem)] font-semibold leading-[0.95] tracking-[-0.035em]">
              Protect 10 SOL below a floor. Cap the upside. <span className="text-ink-3">Watch it settle.</span>
            </h2>
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Link href="/studio" className="btn btn-primary !px-5 !py-2.5">Open the Studio</Link>
              <a href={config.repoUrl} className="btn btn-ghost !px-5 !py-2.5" target="_blank" rel="noreferrer">Read the code</a>
              <span className="cap ml-2">Demo wallet with fork funds · about two minutes</span>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="bg-gradient-to-b from-transparent to-sunk/80">
        <div className="mx-auto flex max-w-[1480px] flex-col gap-3 px-5 py-8 text-[12px] text-ink-3 sm:flex-row sm:items-center sm:px-8">
          <Logo className="h-[18px] w-auto" />
          <span className="sm:ml-6">Built for the Dev3pack hackathon on Solana.</span>
          <span className="sm:ml-auto">Not audited · fork only · open source</span>
        </div>
      </footer>
    </div>
  );
}
