import bench from "@/data/benchmarks.json";
import { Reveal } from "./Reveal";

type Row = { n: number; shareBgeA: number; extraMedianBps: number; extraMinBps: number; shareBgtHodl: number; shareAgtHodl: number; aprA: number; aprB: number } | null;
type Profit = { run: string; capitalUsd: number; none: Row; keeper: Record<string, Row>; noKeeper: Record<string, Row> } | null;

const data = (bench as unknown as { lpProfit?: Profit; market?: string }).lpProfit ?? null;
const market = (bench as unknown as { market?: string }).market ?? "";
const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const bps = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x) < 10 ? Math.abs(x).toFixed(1) : Math.round(Math.abs(x))} bps`;

/** Benchmark 4 on the landing page: does providing liquidity through FORGE pay, against plain Orca and against holding. */
export function LpEvidence() {
  if (!data?.none) return null;
  const levels = [
    ["u20-long", "20%"],
    ["u50-long", "50%"],
    ["u80-long", "80%"],
  ] as const;
  const worstNoKeeper = Math.min(...levels.map(([k]) => data.noKeeper[k]?.extraMinBps ?? 0));
  const hodlB = levels.map(([k]) => data.keeper[k]?.shareBgtHodl ?? 0);
  return (
    <Reveal className="mx-auto mt-16 max-w-[1480px] px-5 sm:px-8">
      <div className="border border-line bg-panel/50">
        <div className="grid gap-6 border-b border-line p-6 lg:grid-cols-[1fr_1.2fr] lg:items-end">
          <div>
            <div className="cap">Does it pay? · {market}</div>
            <h3 className="mt-2 font-display text-[clamp(1.4rem,2.2vw,1.9rem)] font-semibold leading-tight tracking-[-0.02em]">
              Tested on ten months of real prices.
            </h3>
          </div>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            {data.none.n.toLocaleString("en-US")} rolling 7- and 30-day windows of Binance price history, ${data.capitalUsd.toLocaleString("en-US")} of
            liquidity each, compared three ways: the same position in FORGE, in plain Orca, and simply holding the tokens. Borrowers hold
            for up to 7 days.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl min-w-[720px]">
            <thead>
              <tr>
                <th>Share of liquidity lent out</th>
                <th>Ends at least level with plain Orca</th>
                <th>Extra per window, median</th>
                <th>Yearly fees + premium, median</th>
                <th>Same, with no keeper</th>
              </tr>
            </thead>
            <tbody className="num">
              {levels.map(([k, label]) => {
                const r = data.keeper[k], nk = data.noKeeper[k];
                if (!r || !nk) return null;
                return (
                  <tr key={k}>
                    <td className="font-sans">{label}</td>
                    <td className="text-ink">{pct(r.shareBgeA, 1)}</td>
                    <td className="text-good">{bps(r.extraMedianBps)}</td>
                    <td>
                      {pct(r.aprA, 1)} <span className="text-ink-3">→</span> <span className="text-ink">{pct(r.aprB, 1)}</span>
                    </td>
                    <td className="text-bad">{pct(nk.shareBgeA, 1)} level</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ul className="grid gap-x-8 gap-y-3 border-t border-line p-6 text-[12.5px] leading-relaxed text-ink-2 md:grid-cols-3">
          <li>
            <span className="text-ink">It relies on the keeper.</span> Positions are closed once 80% of the borrower&apos;s premium budget is used. FORGE runs
            a keeper that does this (anyone else may too, for a 1% bounty). Without one, FORGE LPs trailed plain Orca in most windows (worst {bps(worstNoKeeper)}).
          </li>
          <li>
            <span className="text-ink">It does not remove impermanent loss.</span> Like any Orca position it can lose to just holding: plain Orca beat
            holding in {pct(data.none.shareAgtHodl)} of windows, FORGE in {pct(Math.min(...hodlB))}–{pct(Math.max(...hodlB))}.
          </li>
          <li>
            <span className="text-ink">It is a simulation.</span> A pool driven by real prices, not a replay of Orca trades. Borrow demand is assumed and
            fees are counted from arbitrage only, the low end. Run {data.run}, benchmark 4.
          </li>
        </ul>
      </div>
    </Reveal>
  );
}
