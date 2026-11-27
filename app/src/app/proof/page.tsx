import type { Metadata } from "next";
import Link from "next/link";
import bench from "@/data/benchmarks.json";
import research from "@/data/research.json";
import { Logo } from "@/components/Logo";
import { LpEvidence } from "@/components/landing/LpEvidence";
import { Caveats, describeCurve, Part, type Curve, type Pricing, PricingNote, ProofHead, Stat } from "@/components/landing/ProofKit";
import { CountUp, Reveal } from "@/components/landing/Reveal";
import { SiteNav } from "@/components/landing/SiteNav";
import { config } from "@/lib/config";

export const metadata: Metadata = {
  title: "Proof · FORGE",
  description: "How FORGE is measured: replication accuracy, real positions on a mainnet fork, the LP guarantee, LP returns against Orca and holding, and a study of the last eight weeks.",
};

// ---------- data (every figure on this page is read from these two files) ----------
type Summary = Record<string, { payoffs: number; feasible: number; median_relative_error_bps: number | null; max_relative_error_bps: number | null; mean_legs: number | null; mean_solve_ms?: number | null }>;
type GuaranteeRow = { paths: number; borrows: number; borrows_eligible: number; borrows_guarantee_holds: number; borrows_guarantee_violations: number; borrows_premium_shortfall: number; restoration_failures_total: number; keeper_closes: number; fee_apr_world_a_median: number };
const B = bench as unknown as {
  market?: string;
  replication: { run: string; summary: Summary; boundViolations: number; spot: number | null; units: number | null; payoffs: number } | null;
  realized: { run: string; refused?: { payoff: string; move: number; guard: string }[]; rows: { slippageBps?: number | null; payoff: string; move: number; construction: number; gross: number; swapCost: number; bound: number; target: number; premium: number; net: number }[] } | null;
  lpGuarantee: { run: string; history: { label: string } | null; claim?: string | null; pricing?: Pricing; summary: Record<string, GuaranteeRow> } | null;
  lpProfit: { run: string; pricing?: Pricing; history?: { span: string; label: string } | null } | null;
};
type R = {
  study: string; folder: string; generatedAt: string; windowDays: number; window: { start: string; end: string }; source: string | null;
  pricing: Pricing; curves: Record<string, Curve> | null;
  assumptions: { hedgeUsd: number | null; budgets: string | null; fairValue: string | null; pools: string | null; revenueTvlUsd: number[] };
  regimes: { token: string; open: number; close: number; low: number; return: number; maxDrawdown: number; troughDate: string; vol1d: number; volJanOct: number | null; daysAbsMoveGt5: number; weeksDown: number; weeks: number }[];
  solIv: { days: number; median: number; max: number; maxDate: string } | null;
  lp: { keeperShareMin: number | null; keeperCells: number; noKeeperLong7dShare: [number, number] | null; rows: { token: string; horizon: string; n: number; shareBgeA: number; extraMedianBps: number; extraMinBps: number; aHodlBps: number; bHodlBps: number; noKeeperLongShareBgeA: number | null }[] };
  borrowers: { token: string; tenor: string; starts: number; strikeOverSpotMedian: number | null; floorUsd: number; premiumMedianUsd: number; fairRv30MedianUsd: number | null; ratioRv30: number | null; ratioIv: number | null; ratioExpost: number | null; exanteU50: number | null; exanteU80: number | null; netMeanUsd: number | null; shareNetPositive: number | null }[];
  protocol: { revenue: { pricing: string; take: string; perYearUsd: number[] }[]; premiumFlowVsSol: { token: string; ratio: number }[] };
  band: Record<string, { tested: number; passing: { token: string; floor: number; curve: string; lpExtra7dBps: number | null; borrowerExante7d: number | null }[]; defaultCurvePassing: number }>;
  recommendation: string[];
  caveats: string[];
};
const S = research as unknown as R;

const MARKET = B.market ?? "JUP/USDC";
const BASE = MARKET.split("/")[0]!;

// ---------- formatting ----------
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x: number | null | undefined, d = 0) => (x == null || Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const sgnPct = (x: number, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`;
const bps = (x: number | null | undefined) => (x == null ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x) < 10 ? Math.abs(x).toFixed(1) : fmt(Math.abs(x))}`);
const usd = (n: number | null | undefined, d = 0) => (n == null ? "n/a" : `${n < 0 ? "−" : ""}$${fmt(Math.abs(n), d)}`);
const ratio = (x: number | null | undefined) => (x == null ? "–" : `${x.toFixed(2)}×`);
const price = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 5, maximumFractionDigits: 10 });
const short = (n: number) => (n >= 1e6 ? `$${fmt(n / 1e6, n % 1e6 ? 2 : 0)}M` : n >= 1e3 ? `$${fmt(n / 1e3, n >= 1e5 ? 0 : 1)}k` : usd(n));
const curveName = (name: string) => (S.curves?.[name] ? describeCurve(S.curves[name]!) : name);

const SECTIONS = [
  ["replication", "Compiler accuracy"],
  ["realized", "Real positions on the fork"],
  ["guarantee", "LP guarantee"],
  ["lp-returns", "LP returns"],
  ["recent", "The last eight weeks"],
  ["reproduce", "Reproduce"],
] as const;

function Table({ head, children, min = 640 }: { head: ReactNodeLike[]; children: React.ReactNode; min?: number }) {
  return (
    <div className="overflow-x-auto border border-line bg-panel/50">
      <table className="tbl whitespace-nowrap [&_td]:!px-3.5 [&_th]:!px-3.5" style={{ minWidth: min }}>
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody className="num">{children}</tbody>
      </table>
    </div>
  );
}
type ReactNodeLike = React.ReactNode;

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-12">
      <h3 className="font-display text-xl font-semibold tracking-tight">{title}</h3>
      {children}
    </div>
  );
}

export default function ProofPage() {
  const rep = B.replication, real = B.realized, lg = B.lpGuarantee, lpAll = lg?.summary["all"];
  const opt = rep?.summary["optimizer/thin"], base = rep?.summary["baseline/thin"];
  const realRows = real?.rows ?? [], refused = real?.refused ?? [];
  const slices = lg ? Object.entries(lg.summary).filter(([k]) => k !== "all") : [];
  const legacy = slices.filter(([k]) => k.includes("legacy"));
  const arb = S.band["arb-band"], noise = S.band["band+noise"];
  const bandTokens = [...new Set(S.regimes.map((r) => r.token))];
  const range = (xs: number[], f: (x: number) => string) => (xs.length ? (Math.min(...xs) === Math.max(...xs) ? f(xs[0]!) : `${f(Math.min(...xs))} to ${f(Math.max(...xs))}`) : "n/a");
  const lp7 = S.lp.rows.filter((r) => r.horizon === "7d"), lp30 = S.lp.rows.filter((r) => r.horizon === "30d");

  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <SiteNav solid />

      <div className="glow-top">
        <div className="mx-auto max-w-[1400px] px-5 pb-10 pt-32 sm:px-8">
          <div className="num flex items-center gap-3 text-[12px] text-ink-3">
            <span className="size-1.5 bg-good" />
            Proof · {MARKET} and four tokens
          </div>
          <h1 className="mt-5 max-w-4xl font-display text-[clamp(2.4rem,5.4vw,4.6rem)] font-semibold leading-[0.98] tracking-[-0.035em]">
            Measured, <span className="text-ink-3">not promised.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-[16px] leading-relaxed text-ink-2">
            Every number here is read from committed benchmark runs and one study of the most recent weeks. Each part says how it was measured,
            what came out, and where it can be wrong. Shortfalls and refusals are reported, not filtered.
          </p>
        </div>
      </div>

      <div className="mx-auto grid max-w-[1400px] gap-10 px-5 pb-24 sm:px-8 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:sticky lg:top-24 lg:block lg:self-start">
          <ul className="space-y-0.5 border-l border-line">
            {SECTIONS.map(([id, t], i) => (
              <li key={id}>
                <a href={`#${id}`} className="-ml-px flex gap-2.5 border-l border-transparent py-1.5 pl-3 text-[13px] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink">
                  <span className="num text-[11px] text-ink-3/70">{String(i + 1).padStart(2, "0")}</span>
                  {t}
                </a>
              </li>
            ))}
          </ul>
        </aside>

        <main className="min-w-0 space-y-28">
          {/* 1. replication */}
          {rep && opt && base && (
            <section>
              <ProofHead
                id="replication" n="01" kicker="Benchmark 1 · Compiler"
                title={<>The compiler builds what you draw, <span className="text-ink-3">even on thin liquidity.</span></>}
              />
              <Part label="Method">
                {rep.payoffs} target payoffs{rep.units ? ` on ${fmt(rep.units, 0)} ${BASE}` : ""}{rep.spot ? ` at a spot of ${price(rep.spot)}` : ""}, compiled against the real {MARKET} liquidity
                twice: deep, and thin (the long-tail case). FORGE&apos;s optimizer is compared with direct replication, one range at each kink of the
                payoff. Every certificate&apos;s error bound is then checked against the exact payoff on a dense price grid.
              </Part>
              <Part label="Result" wide>
                <Reveal>
                  <div className="grid border border-line bg-panel/50 sm:grid-cols-2">
                    <Stat value={<><CountUp value={opt.feasible} />/{opt.payoffs}</>} label={<>payoffs built on thin liquidity by the optimizer, against <span className="num text-ink">{base.feasible}/{base.payoffs}</span> by direct replication.</>} />
                    <div className="border-t border-line sm:border-l sm:border-t-0">
                      <Stat value={<CountUp value={rep.boundViolations} />} label="certificate bounds violated on the dense checks." tone={rep.boundViolations === 0 ? "good" : "bad"} />
                    </div>
                  </div>
                </Reveal>
                <div className="mt-4">
                  <Table head={["Method / liquidity", "Payoffs", "Feasible", "Median error (bps)", "Max error (bps)", "Mean ranges", "Mean solve (ms)"]}>
                    {Object.entries(rep.summary).map(([k, v]) => (
                      <tr key={k}>
                        <td className="font-sans">{k.replace("/", " · ")}</td>
                        <td>{v.payoffs}</td>
                        <td className="text-ink">{v.feasible}</td>
                        <td>{v.median_relative_error_bps == null ? "–" : fmt(v.median_relative_error_bps, 1)}</td>
                        <td>{v.max_relative_error_bps == null ? "–" : fmt(v.max_relative_error_bps, 1)}</td>
                        <td>{v.mean_legs == null ? "–" : fmt(v.mean_legs, 1)}</td>
                        <td className="text-ink-2">{v.mean_solve_ms == null ? "–" : fmt(v.mean_solve_ms, 0)}</td>
                      </tr>
                    ))}
                  </Table>
                </div>
                <p className="cap mt-3">Errors in basis points of notional. Run {rep.run}.</p>
              </Part>
              <Caveats items={[
                "The certified bound covers replication error over the stated price range only. Premium, pool fees and settlement swap costs are reported separately.",
                "The optimizer uses more ranges and takes longer to solve than direct replication; both are shown above.",
              ]} />
            </section>
          )}

          {/* 2. realized */}
          {real && realRows.length > 0 && (
            <section>
              <ProofHead
                id="realized" n="02" kicker="Benchmark 2 · On-chain"
                title={<>Real positions settle <span className="text-ink-3">where the certificate says.</span></>}
              />
              <Part label="Method">
                Each payoff is opened through Orca&apos;s real programs on a Surfpool fork of Solana mainnet. The price is then moved to 0.9×, 1× and 1.1× of
                spot and the position is closed. The settled value is compared with the target, the certified construction and its bound.
              </Part>
              <Part label="Result" wide>
                <Reveal>
                  <div className="grid border border-line bg-panel/50 sm:grid-cols-2">
                    <Stat value={<><CountUp value={realRows.length} />{refused.length > 0 && <span className="text-ink-3">/{realRows.length + refused.length}</span>}</>} label="closes settled, each equal to the certified construction minus the measured swap cost." />
                    <div className="border-t border-line sm:border-l sm:border-t-0">
                      <Stat value={usd(Math.max(...realRows.map((r) => r.swapCost)), 2)} label="largest restoration swap cost of any settled close." />
                    </div>
                  </div>
                </Reveal>
                <div className="mt-4">
                  <Table head={["Payoff", "Close", "Target", "Certified", "Realized", "Swap cost", "Bound"]} min={680}>
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
                  </Table>
                </div>
                <p className="cap mt-3">USD. {MARKET} on the fork{realRows[0]?.slippageBps ? `, restoration slippage cap ${(realRows[0].slippageBps / 100).toFixed(1)}%` : ""}. Run {real.run}.</p>
              </Part>
              <Caveats items={[
                ...(refused.length ? [<>{refused.length} closes after a 10% drop ({refused.map((r) => r.payoff.replace("_", " ")).join(", ")}) were refused by the program&apos;s price guards ({[...new Set(refused.map((r) => r.guard))].join(", ")}): the thin pool could not restore the liquidity at a fair price, so FORGE waited instead of overpaying. They stay recoverable.</>] : []),
                "Opens and closes are not atomic across batches. Large positions span several transactions; pending states are explicit and anyone can continue them.",
                "A fork with test funds, not mainnet.",
              ]} />
            </section>
          )}

          {/* 3. guarantee */}
          {lg && lpAll && (
            <section>
              <ProofHead
                id="guarantee" n="03" kicker="Benchmark 3 · LP guarantee"
                title={<>LPs are paid at least what they would have earned, <span className="text-ink-3">when the borrower funded it.</span></>}
              />
              <Part label="Claim">{lg.claim ?? "Idle fees plus premium paid are at least the fees from staying in Orca, per borrowed range."}</Part>
              <Part label="Method">
                Every borrow on {fmt(lpAll.paths)} price paths is checked: historical paths driven by {lg.history?.label ?? "Binance prices"}, and synthetic
                ones. Variants add extra trading volume, full funding, a keeper and stressed restorations. A borrow is eligible when its budget covered the
                premium owed.
                <PricingNote pricing={lg.pricing} run={lg.run} />
              </Part>
              <Part label="Result" wide>
                <Reveal>
                  <div className="grid border border-line bg-panel/50 sm:grid-cols-3">
                    <Stat value={<CountUp value={lpAll.borrows_guarantee_holds} />} label={<>eligible borrows where the guarantee held, of <span className="num text-ink">{fmt(lpAll.borrows_eligible)}</span>.</>} />
                    <div className="border-t border-line sm:border-l sm:border-t-0"><Stat value={<CountUp value={lpAll.borrows_guarantee_violations} />} label="violations." tone={lpAll.borrows_guarantee_violations === 0 ? "good" : "bad"} /></div>
                    <div className="border-t border-line sm:border-l sm:border-t-0"><Stat value={fmt(lpAll.borrows_premium_shortfall)} label={<>borrows whose budget ran short, of <span className="num text-ink">{fmt(lpAll.borrows)}</span>. Reported, not filtered.</>} /></div>
                  </div>
                </Reveal>
                <div className="mt-4">
                  <Table head={["Slice", "Borrows", "Eligible", "Holds", "Violations", "Shortfalls", "Restoration failures", "Keeper closes"]} min={760}>
                    {slices.map(([k, v]) => (
                      <tr key={k} className={k.includes("legacy") ? "text-ink-3" : ""}>
                        <td className="font-sans">{k.replace("historical-price-driven", "historical").replace("synthetic-gbm", "synthetic").replace("/", " · ")}</td>
                        <td>{fmt(v.borrows)}</td>
                        <td>{fmt(v.borrows_eligible)}</td>
                        <td className={k.includes("legacy") ? "" : "text-ink"}>{fmt(v.borrows_guarantee_holds)}</td>
                        <td className={v.borrows_guarantee_violations === 0 ? "text-good" : "text-bad"}>{v.borrows_guarantee_violations}</td>
                        <td>{fmt(v.borrows_premium_shortfall)}</td>
                        <td>{v.restoration_failures_total}</td>
                        <td>{fmt(v.keeper_closes)}</td>
                      </tr>
                    ))}
                  </Table>
                </div>
              </Part>
              <Caveats items={[
                "The guarantee is conditional. A borrower whose premium budget runs short leaves a shortfall; it is recorded and pauses new borrowing.",
                `${fmt(lpAll.restoration_failures_total)} restorations were refused at first (price guards) and retried with premium still accruing; they are counted, not dropped.`,
                ...(legacy.length ? ["The legacy fee model (a fee on every path point, used by earlier runs) is shown greyed for comparison and is excluded from the totals."] : []),
                "A simulated pool driven by real prices, not a replay of Orca trades.",
              ]} />
            </section>
          )}

          {/* 4. LP returns */}
          {B.lpProfit && (
            <section>
              <ProofHead
                id="lp-returns" n="04" kicker="Benchmark 4 · LP returns"
                title={<>Is it profitable to be a FORGE LP? <span className="text-ink-3">Against Orca, and against holding.</span></>}
              />
              <Part label="Method">
                The same capital on the same price path three ways: in FORGE, in plain Orca, and simply holding the tokens. Rolling windows over{" "}
                {B.lpProfit.history?.span ?? "the price history"} ({B.lpProfit.history?.label ?? "Binance"}), at three levels of borrow demand, with and
                without a keeper. Fees count arbitrage only, the low end.
                <PricingNote pricing={B.lpProfit.pricing} run={B.lpProfit.run} />
              </Part>
              <div className="pt-2">
                <LpEvidence bare />
              </div>
            </section>
          )}

          {/* 5. recent regime */}
          <section>
            <ProofHead
              id="recent" n="05" kicker={`Study · ${S.window.start.slice(0, 10)} to ${S.window.end.slice(0, 10)}`}
              title={<>The last {Math.round(S.windowDays / 7)} weeks: <span className="text-ink-3">profitable, for whom, at what price?</span></>}
              lead={`A separate study of the most recent ${S.windowDays} days for ${S.regimes.map((r) => r.token).join(", ")}: LPs against Orca and holding, what borrowers paid against fair value, and the pricing that is fair to both.`}
            />
            <Part label="Method">
              The same simulator as Benchmarks 3 and 4, on {S.source ?? "Binance prices"}. Fair value is the {S.assumptions.fairValue ?? "Black–Scholes value"}, at
              trailing, realized and (for SOL) Deribit implied volatility. Floors and multipliers are swept to find a band where LPs, borrowers and the
              protocol all come out ahead.
              <PricingNote pricing={S.pricing} run={S.folder} />
            </Part>

            <Sub title="The regime: a broad crash">
              <div className="mt-4">
                <Table head={["Token", "Open → close", "Return", "Max drawdown", "Daily vol (ann.)", "Jan–Oct vol", "Days moving > 5%", "Weeks down"]} min={760}>
                  {S.regimes.map((g) => (
                    <tr key={g.token}>
                      <td className="font-sans">{g.token}</td>
                      <td>{price(g.open)} → {price(g.close)}</td>
                      <td className={g.return < 0 ? "text-bad" : "text-good"}>{sgnPct(g.return)}</td>
                      <td>{sgnPct(g.maxDrawdown)} <span className="text-ink-3">({g.troughDate.slice(5)})</span></td>
                      <td>{pct(g.vol1d)}</td>
                      <td className="text-ink-2">{g.volJanOct == null ? "–" : pct(g.volJanOct)}</td>
                      <td>{g.daysAbsMoveGt5}</td>
                      <td>{g.weeksDown}/{g.weeks}</td>
                    </tr>
                  ))}
                </Table>
              </div>
              {S.solIv && <p className="cap mt-3">Deribit SOL implied volatility near the money over the window: median {pct(S.solIv.median)}, peak {pct(S.solIv.max)} on {S.solIv.maxDate}.</p>}
            </Sub>

            <Sub title="LPs: ahead of Orca with a keeper, behind without one">
              <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-2">
                With a keeper, FORGE LPs ended at least level with plain Orca LPs in {S.lp.keeperShareMin === 1 ? "every window" : <>at least {pct(S.lp.keeperShareMin)} of windows</>}, in
                all {S.lp.keeperCells} combinations of token, window length, demand and fee model tested.
                {S.lp.noKeeperLong7dShare && <> Without a keeper, 7-day borrows left them level in only {pct(S.lp.noKeeperLong7dShare[0])}–{pct(S.lp.noKeeperLong7dShare[1])} of 7-day windows.</>}
              </p>
              <div className="mt-4">
                <Table head={["Token", "Window", "Windows", "FORGE ≥ Orca", "Extra, median", "Extra, worst", "Orca vs hold", "FORGE vs hold", "No keeper"]} min={860}>
                  {S.lp.rows.map((r) => (
                    <tr key={r.token + r.horizon}>
                      <td className="font-sans">{r.token}</td>
                      <td>{r.horizon}</td>
                      <td className="text-ink-2">{r.n}</td>
                      <td className="text-ink">{pct(r.shareBgeA)}</td>
                      <td className="text-good">{bps(r.extraMedianBps)}</td>
                      <td>{bps(r.extraMinBps)}</td>
                      <td className="text-ink-2">{bps(r.aHodlBps)}</td>
                      <td>{bps(r.bHodlBps)}</td>
                      <td className="text-bad">{pct(r.noKeeperLongShareBgeA)}</td>
                    </tr>
                  ))}
                </Table>
              </div>
              <p className="cap mt-3">Basis points of starting capital. 50% of borrowable liquidity lent out in 8-hour borrows, realistic budgets, arbitrage-only fees. &quot;No keeper&quot;: share of windows FORGE ≥ Orca with 7-day borrows and no keeper. Median extra over Orca: {range(lp7.map((r) => r.extraMedianBps), bps)} bps per 7 days, {range(lp30.map((r) => r.extraMedianBps), bps)} per 30 days.</p>
            </Sub>

            <Sub title="Borrowers: protection cost more than fair value at the default pricing">
              <div className="mt-4">
                <Table head={["Token", "Tenor", "Starts", "Premium", "Fair value", "Paid ÷ fair", "Expected, 50% use", "80% use", "Net, mean", "Paid off"]} min={880}>
                  {S.borrowers.map((b) => (
                    <tr key={b.token + b.tenor}>
                      <td className="font-sans">{b.token}</td>
                      <td>{b.tenor}</td>
                      <td className="text-ink-2">{b.starts}</td>
                      <td className="text-ink">{usd(b.premiumMedianUsd)}</td>
                      <td>{usd(b.fairRv30MedianUsd)}</td>
                      <td className={b.ratioRv30 != null && b.ratioRv30 > 1 ? "text-bad" : "text-good"}>{ratio(b.ratioRv30)}</td>
                      <td className={b.exanteU50 != null && b.exanteU50 > 1 ? "text-bad" : "text-good"}>{ratio(b.exanteU50)}</td>
                      <td className={b.exanteU80 != null && b.exanteU80 > 1 ? "text-bad" : "text-good"}>{ratio(b.exanteU80)}</td>
                      <td className={b.netMeanUsd != null && b.netMeanUsd >= 0 ? "text-good" : "text-bad"}>{usd(b.netMeanUsd)}</td>
                      <td>{pct(b.shareNetPositive)}</td>
                    </tr>
                  ))}
                </Table>
              </div>
              <p className="cap mt-3">
                A put about {range(S.borrowers.map((b) => b.strikeOverSpotMedian ?? NaN).filter((x) => !Number.isNaN(x)), (x) => pct(x))} of spot on{" "}
                {usd(S.assumptions.hedgeUsd)} of each token, held to expiry, default pricing at 50% utilization. Premium and fair value are medians; fair value at trailing 30-day
                realized volatility. &quot;Expected&quot; is premium ÷ fair ex ante, on simulated paths at the volatility at the end of the window, at 50% and 80% utilization.
              </p>
            </Sub>

            <Sub title="Protocol economics, under labeled assumptions">
              <div className="mt-4">
                <Table head={["Pricing", "Protocol take", ...S.assumptions.revenueTvlUsd.map((v) => `${short(v)} LP TVL`)]} min={620}>
                  {S.protocol.revenue.map((r) => (
                    <tr key={r.pricing + r.take}>
                      <td className="font-sans">{r.pricing}</td>
                      <td className="font-sans text-ink-2">{r.take}</td>
                      {r.perYearUsd.map((v, i) => <td key={i} className="text-ink">{short(v)}/yr</td>)}
                    </tr>
                  ))}
                </Table>
              </div>
              <p className="cap mt-3">
                Assumptions: TVL, a 50% utilization and the take rates are inputs, not measurements. Premium flow is SOL&apos;s median over 7-day windows with a
                keeper; {S.protocol.premiumFlowVsSol.map((p) => `${p.token} ${p.ratio.toFixed(1)}×`).join(", ")} SOL&apos;s flow.
              </p>
            </Sub>

            <Sub title="The pricing band, and what changes">
              <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-2">
                A pricing passes when LPs end at least level with Orca in 95% of windows after a protocol take, borrowers pay no more than fair value ex ante,
                and the protocol take is above zero. Of {arb?.tested ?? 0} floor and multiplier combinations, <span className="text-ink">{arb?.passing.length ?? 0} pass</span> with
                arbitrage-only fees{noise ? <>, and {noise.passing.length} when assumed extra volume is added</> : null}.{arb && arb.defaultCurvePassing === 0 && " The default curve passes for no token at any floor."}
              </p>
              {arb && (
                <dl className="mt-5 grid border border-line bg-panel/50 sm:grid-cols-2">
                  {bandTokens.map((t, i) => {
                    const ps = arb.passing.filter((p) => p.token === t);
                    return (
                      <div key={t} className={`border-line p-5 ${i % 2 ? "sm:border-l" : ""} ${i >= 1 ? "border-t" : ""} ${i === 1 ? "sm:border-t-0" : ""}`}>
                        <dt className="cap">{t} · {ps.length} passing</dt>
                        <dd className="mt-2 space-y-1 text-[13px] text-ink-2">
                          {ps.length ? [...new Set(ps.map((p) => p.curve))].map((c) => (
                            <div key={c}>
                              <span className="text-ink">{curveName(c)}</span>
                              <span className="num text-ink-3"> · floor {ps.filter((p) => p.curve === c).map((p) => pct(p.floor)).join(", ")}</span>
                            </div>
                          )) : <span className="text-ink-3">none</span>}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
              {S.recommendation.length > 0 && (
                <div className="mt-6 border-l border-accent pl-5">
                  <div className="cap">The study&apos;s recommendation</div>
                  <ul className="mt-2 space-y-1.5 text-[14px] leading-relaxed text-ink-2">
                    {S.recommendation.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                </div>
              )}
            </Sub>

            <div className="mt-10">
              <Caveats items={S.caveats} />
            </div>
          </section>

          {/* reproduce */}
          <section>
            <ProofHead id="reproduce" n="06" kicker="Reproduce" title="Run it yourself." />
            <Part label="Benchmarks">
              <code className="num text-ink">uv run python benchmarks/run_all.py --market {MARKET} --fork</code> reruns Benchmarks 1–4 (Benchmark 2 needs a
              bootstrapped Surfpool fork; the others are offline and deterministic) and writes a new folder under <code className="num">benchmarks/results/</code>.
            </Part>
            <Part label="Study">
              Code, data hashes and the full report are in <code className="num">{S.folder}/</code> (generated {S.generatedAt.slice(0, 10)}).
            </Part>
            <Part label="This page">
              <code className="num">app/scripts/sync-benchmarks.mjs</code> copies the newest results into the site before every build. Nothing is typed in by hand.
            </Part>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href={config.repoUrl} className="btn btn-primary !px-5 !py-2.5" target="_blank" rel="noreferrer">Read the code <span aria-hidden>↗</span></a>
              <Link href="/studio" className="btn btn-ghost !px-5 !py-2.5">Launch App</Link>
            </div>
          </section>
        </main>
      </div>

      <footer className="bg-gradient-to-b from-transparent to-sunk/80">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-5 py-8 text-[12px] text-ink-3 sm:flex-row sm:items-center sm:px-8">
          <Logo className="h-[18px] w-auto" />
          <span className="sm:ml-6">Built for the Dev3pack hackathon on Solana.</span>
          <span className="sm:ml-auto">Not audited · fork only · open source</span>
        </div>
      </footer>
    </div>
  );
}
