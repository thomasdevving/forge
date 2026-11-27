import Link from "next/link";
import bench from "@/data/benchmarks.json";
import { HeroGraphic } from "@/components/landing/HeroGraphic";
import { LiveStrip } from "@/components/landing/LiveStrip";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { config } from "@/lib/config";

type Summary = Record<string, { payoffs: number; feasible: number; median_relative_error_bps: number | null; mean_legs: number | null }>;
const rep = bench.replication as unknown as { run: string; summary: Summary; boundViolations: number } | null;
const real = bench.realized as unknown as { run: string; rows: { payoff: string; move: number; construction: number; gross: number; swapCost: number; bound: number; target: number }[] } | null;
const lp = bench.lpGuarantee as unknown as {
  run: string;
  summary: Record<string, { borrows: number; borrows_eligible: number; borrows_guarantee_holds: number; borrows_guarantee_violations: number; borrows_premium_shortfall: number; restoration_failures_total: number; paths: number }>;
} | null;

const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function Section({ id, eyebrow, title, children, intro }: { id?: string; eyebrow: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6 sm:py-24">
      <div className="label text-ember">{eyebrow}</div>
      <h2 className="mt-3 max-w-3xl font-display text-3xl font-bold tracking-tight sm:text-[2.6rem] sm:leading-[1.1]">{title}</h2>
      {intro && <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-2">{intro}</p>}
      <div className="mt-12">{children}</div>
    </section>
  );
}

const STEPS = [
  {
    n: "01",
    t: "Design",
    d: "Drag breakpoints on a price chart, or start from a preset: protective put, collar, spread, straddle. Feasibility updates while you draw.",
    icon: <path d="M3 17c4 0 5-10 9-10s5 10 9 10" />,
  },
  {
    n: "02",
    t: "Compile",
    d: "A constrained minimax MILP (HiGHS) picks Orca ranges to borrow or provide, inside your holdings, the leg limit and live borrowable liquidity.",
    icon: <><rect x="4" y="13" width="3" height="7" rx="1" /><rect x="10.5" y="9" width="3" height="11" rx="1" /><rect x="17" y="5" width="3" height="15" rx="1" /></>,
  },
  {
    n: "03",
    t: "Verify",
    d: "An independent verifier computes the exact maximum replication error, not a sample, and issues a certificate whose hash is pinned on-chain.",
    icon: <><path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  },
  {
    n: "04",
    t: "Execute & settle",
    d: "You sign. The program borrows or deposits liquidity through Orca CPIs, escrows real tokens, and settles from real balances with guarded restoration.",
    icon: <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
  },
];

export default function Landing() {
  const opt = rep?.summary["optimizer/thin"];
  const base = rep?.summary["baseline/thin"];
  const optDeep = rep?.summary["optimizer/deep"];
  const lpAll = lp?.summary["all"];
  const lpFunded = lp ? Object.entries(lp.summary).filter(([k]) => k.endsWith("fully-funded")).reduce((a, [, s]) => a + s.borrows_eligible, 0) : 0;
  const realRows = real?.rows ?? [];
  const maxGap = realRows.reduce((a, r) => Math.max(a, Math.abs(r.gross - r.construction - -r.swapCost)), 0);

  return (
    <div className="overflow-x-hidden">
      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm text-ink-2 md:flex">
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#lps" className="hover:text-ink">For LPs</a>
            <a href="#proof" className="hover:text-ink">Proof</a>
            <a href="#limits" className="hover:text-ink">Limitations</a>
            <a href={config.repoUrl} className="hover:text-ink" target="_blank" rel="noreferrer">GitHub</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Link href="/studio" className="btn btn-primary">Launch app</Link>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative">
        <div className="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(70%_60%_at_50%_30%,black,transparent)]" aria-hidden />
        <div className="ember-glow pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2" aria-hidden />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <div className="animate-fade-up">
            <span className="pill border-line-strong bg-elev text-ink-2">
              <span className="size-1.5 rounded-full bg-ember" /> Custom derivatives from Orca liquidity · Solana
            </span>
            <h1 className="mt-6 font-display text-[2.7rem] font-bold leading-[1.02] tracking-tight sm:text-6xl lg:text-[4.1rem]">
              Draw a payoff.
              <br />
              <span className="text-ember">Forge</span> it from liquidity.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
              Most Solana tokens have a spot market and no options market. FORGE compiles the payoff you draw into
              Orca concentrated-liquidity ranges, certifies how closely it matches, executes it on-chain and settles
              it with real token balances.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/studio" className="btn btn-primary !px-5 !py-3 text-base">Open the Studio</Link>
              <Link href="/earn" className="btn btn-ghost !px-5 !py-3 text-base">Earn as an LP</Link>
            </div>
            <p className="mt-5 text-xs text-ink-3">Hackathon software · not audited · runs on a Surfpool mainnet fork with test funds only.</p>
          </div>
          <div className="card relative p-3 sm:p-5">
            <HeroGraphic />
          </div>
        </div>
        <div className="relative mx-auto max-w-6xl px-4 pb-6 sm:px-6">
          <LiveStrip />
        </div>
      </section>

      {/* how */}
      <Section id="how" eyebrow="How it works" title="From a line you draw to a position you can settle." intro="Every step is real: the compiler, the verifier, the Orca CPIs and the settlement all run, and the certificate you accept is hashed into the position account.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="card group relative p-6 transition-transform hover:-translate-y-0.5">
              <div className="flex items-center justify-between">
                <svg viewBox="0 0 24 24" className="size-7 text-ember" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{s.icon}</svg>
                <span className="num text-xs text-ink-3">{s.n}</span>
              </div>
              <h3 className="mt-5 font-display text-xl font-semibold">{s.t}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* idea */}
      <section className="border-y border-line bg-sunk">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <div>
            <div className="label text-ember">The core idea</div>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">Concentrated liquidity already is an option.</h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-2">
              A range below the price holds only USDC. Borrow it, escrow that USDC, and owe the same liquidity back
              later. If the price falls through the range, restoring it costs less than the escrow, and the difference
              is a put payoff. Above the price the same trick, with base escrowed, gives a call.
            </p>
            <p className="mt-4 leading-relaxed text-ink-2">
              The escrow covers restoration at every price in the frictionless model. Real execution adds swap fees,
              impact and rounding, so a separate restoration buffer is locked at open and every restoration is
              price-guarded against an independent reference.
            </p>
          </div>
          <div className="card self-center p-6">
            <div className="num text-sm text-ink-2">value of liquidity L in a range [p<sub>a</sub>, p<sub>b</sub>]</div>
            <div className="num mt-3 rounded-lg bg-sunk p-4 text-[15px] leading-7">
              V(P) = x·P + y<br />
              <span className="text-ink-3">in range:</span> V(P) = L(2√P − P/√p<sub>b</sub> − √p<sub>a</sub>)<br />
              <span className="text-ink-3">long put:</span> payoff = y<sub>escrow</sub> − V(P) ≥ 0
            </div>
            <p className="mt-4 text-sm text-ink-3">Path independent: token amounts depend only on the closing price, which is what makes the LP guarantee testable.</p>
          </div>
        </div>
      </section>

      {/* LPs */}
      <Section id="lps" eyebrow="For liquidity providers" title="Idle liquidity keeps earning. Borrowed liquidity is paid for." intro="Deposit an Orca position and FORGE splits it into standardized buckets. Unborrowed liquidity stays in the pool and keeps its fees. Borrowed liquidity is measured from Orca's own fee growth and paid for.">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="card p-6">
            <div className="label">Premium</div>
            <div className="num mt-3 text-lg">max(floor, m(u) × forgone)</div>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">Forgone fees come from the bucket's on-chain fee growth while borrowed. The multiplier m(u) ≥ 1 rises with utilization; a time floor pays even when the price never arrives.</p>
          </div>
          <div className="card p-6">
            <div className="label">Conditional guarantee</div>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">If restoration succeeds and the borrower's budget covers the premium, you get the same liquidity back plus at least the fees you would have measured in Orca. Shortfalls are recorded and pause new borrowing; they are never hidden.</p>
          </div>
          <div className="card p-6">
            <div className="label">Withdrawals</div>
            <p className="mt-3 text-sm leading-relaxed text-ink-2">Unborrowed liquidity leaves immediately. Borrowed liquidity needs a 24-hour notice, after which keepers may close the positions using it. Utilization is capped at 80% per bucket.</p>
          </div>
        </div>
      </Section>

      {/* proof */}
      <section id="proof" className="scroll-mt-20 border-y border-line bg-sunk">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
          <div className="label text-ember">Proof, not promises</div>
          <h2 className="mt-3 max-w-3xl font-display text-3xl font-bold tracking-tight sm:text-[2.6rem] sm:leading-[1.1]">Measured on a mainnet fork and ten months of SOL prices.</h2>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-2">Every number here is read from the committed benchmark results. Reproduce them with one command: <span className="num text-[15px]">benchmarks/run_all.py --fork</span>.</p>
          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            <div className="card flex flex-col p-6">
              <div className="label">Replication · thin liquidity</div>
              {opt && base ? (
                <>
                  <div className="mt-4 flex items-baseline gap-3">
                    <span className="num text-5xl font-semibold text-ember">{opt.feasible}/{opt.payoffs}</span>
                    <span className="text-sm text-ink-3">payoffs compiled</span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-ink-2">The optimizer versus <span className="num">{base.feasible}/{base.payoffs}</span> for direct replication at each kink. With deep liquidity: <span className="num">{optDeep?.feasible}/{optDeep?.payoffs}</span> at a median <span className="num">{fmt(optDeep?.median_relative_error_bps ?? 0, 1)}</span> bps of notional.</p>
                  <p className="mt-auto pt-4 text-xs text-ink-3">{rep?.boundViolations === 0 ? "0 certificate bounds violated on dense out-of-sample checks." : `${rep?.boundViolations} bound violations.`}</p>
                </>
              ) : <p className="mt-4 text-sm text-ink-3">No results recorded.</p>}
            </div>
            <div className="card flex flex-col p-6">
              <div className="label">Designed vs realized · on the fork</div>
              {realRows.length ? (
                <>
                  <div className="mt-4 flex items-baseline gap-3">
                    <span className="num text-5xl font-semibold text-ember">{realRows.length}</span>
                    <span className="text-sm text-ink-3">real positions settled</span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-ink-2">Protective puts, collars, call spreads and strangles closed after real ±10% swaps. In every case the realized gross payoff equals the certified construction minus the measured restoration swap cost{maxGap < 0.01 ? " to the cent" : ""}.</p>
                  <p className="mt-auto pt-4 text-xs text-ink-3">Largest restoration cost: <span className="num">${fmt(Math.max(...realRows.map((r) => r.swapCost)), 2)}</span> on positions worth up to <span className="num">${fmt(Math.max(...realRows.map((r) => r.construction)), 0)}</span>.</p>
                </>
              ) : <p className="mt-4 text-sm text-ink-3">No results recorded.</p>}
            </div>
            <div className="card flex flex-col p-6">
              <div className="label">LP guarantee · paired simulation</div>
              {lpAll ? (
                <>
                  <div className="mt-4 flex items-baseline gap-3">
                    <span className="num text-5xl font-semibold text-ember">{fmt(lpAll.borrows_guarantee_holds)}</span>
                    <span className="text-sm text-ink-3">of {fmt(lpAll.borrows_eligible)} eligible borrows hold</span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-ink-2"><span className="num">{lpAll.borrows_guarantee_violations}</span> violations across {fmt(lpAll.paths)} path runs of Binance SOL/USDC history and synthetic paths. Reported, not filtered: <span className="num">{fmt(lpAll.borrows_premium_shortfall)}</span> premium shortfalls and <span className="num">{fmt(lpAll.restoration_failures_total)}</span> restoration failures under stress.</p>
                  <p className="mt-auto pt-4 text-xs text-ink-3">Fully funded borrowers: <span className="num">{fmt(lpFunded)}</span> eligible borrows, no shortfall.</p>
                </>
              ) : <p className="mt-4 text-sm text-ink-3">No results recorded.</p>}
            </div>
          </div>
          {realRows.length > 0 && (
            <div className="card mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-ink-3">
                  <tr className="border-b border-line">
                    {["Payoff", "Close", "Target", "Certified", "Realized gross", "Swap cost", "Bound"].map((h) => (
                      <th key={h} className="px-4 py-3 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="num">
                  {realRows.map((r, i) => (
                    <tr key={i} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-2.5 font-sans">{r.payoff.replace("_", " ")}</td>
                      <td className="px-4 py-2.5">{r.move}×</td>
                      <td className="px-4 py-2.5">{fmt(r.target, 2)}</td>
                      <td className="px-4 py-2.5">{fmt(r.construction, 2)}</td>
                      <td className="px-4 py-2.5 text-ember">{fmt(r.gross, 2)}</td>
                      <td className="px-4 py-2.5 text-ink-2">{fmt(r.swapCost, 4)}</td>
                      <td className="px-4 py-2.5 text-ink-2">±{fmt(r.bound, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-3 text-xs text-ink-3">USD values. Run {real?.run}. Premiums, fees and swap costs are excluded from the certified bound and reported separately.</p>
            </div>
          )}
        </div>
      </section>

      {/* limitations */}
      <Section id="limits" eyebrow="Read before you trust it" title="What FORGE does not promise.">
        <ul className="grid gap-x-10 gap-y-4 text-ink-2 sm:grid-cols-2">
          {[
            "Out-of-the-money options pay LPs little until the price reaches the range: positive but modest income.",
            "Borrowed LP liquidity has a 24-hour withdrawal notice.",
            "The LP guarantee is conditional: finite buffers, capped premium budgets, quote conversion and delayed or failed restoration can produce recorded shortfalls.",
            "Multi-transaction opens and closes are not atomic across batches; pending states and recovery are explicit.",
            "Capacity is limited by authorized FORGE liquidity and an eligible restoration pool.",
            "Not audited. Hackathon software. Fork and devnet only; no mainnet funds, ever.",
          ].map((t) => (
            <li key={t} className="flex gap-3 leading-relaxed">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-ember" aria-hidden />
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-8 text-sm text-ink-3">Prior art: Panoptic pioneered options from CLMM positions on Ethereum. FORGE adds payoff synthesis by constrained optimization, independently certified replication error, the bucket ladder, self-collateralized long exposures and testable, conditional LP restoration and fee compensation, natively on Solana.</p>
      </Section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="card relative overflow-hidden p-8 sm:p-12">
          <div className="ember-glow pointer-events-none absolute -right-40 -top-40 h-96 w-[600px]" aria-hidden />
          <h2 className="relative max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-4xl">Protect 10 SOL below a floor, cap the upside, and watch it settle.</h2>
          <p className="relative mt-4 max-w-xl text-ink-2">Connect a wallet or use a throwaway demo wallet with fork test funds. The whole loop takes about two minutes.</p>
          <div className="relative mt-8 flex flex-wrap gap-3">
            <Link href="/studio" className="btn btn-primary !px-5 !py-3 text-base">Open the Studio</Link>
            <a href={config.repoUrl} className="btn btn-ghost !px-5 !py-3 text-base" target="_blank" rel="noreferrer">Read the code</a>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-ink-3 sm:flex-row sm:items-center sm:px-6">
          <Logo />
          <span className="sm:ml-4">Built for the Dev3pack hackathon on Solana.</span>
          <span className="sm:ml-auto">Not audited · fork only · open source</span>
        </div>
      </footer>
    </div>
  );
}
