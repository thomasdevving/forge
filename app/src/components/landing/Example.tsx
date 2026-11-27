import meta from "../../../public/shots/meta.json";
import { Reveal } from "./Reveal";

type Meta = {
  market: string;
  base: string;
  spot: number;
  holdings: { base: number };
  premiumBudget: number;
  target: [number, number][];
  legs: { kind: string; priceLower: number; priceUpper: number }[];
  certifiedBound: number;
  capitalLocked: number;
  openTransactions?: number;
};
const m = meta as unknown as Meta;
const usd = (n: number, d = Math.abs(n) < 1 ? 4 : 0) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

/** The collar from the snapshot as a payoff diagram: target, just holding, floor and cap marked. */
function PayoffDiagram() {
  const W = 560, H = 260, L = 8, R = 8, T = 18, B = 30;
  const pts = m.target;
  const [x0, x1] = [pts[0]![0], pts[pts.length - 1]![0]];
  const hold = (p: number) => m.holdings.base * p;
  const ys = [...pts.map((p) => p[1]), hold(x0), hold(x1)];
  const [y0, y1] = [Math.min(...ys) * 0.96, Math.max(...ys) * 1.03];
  const X = (p: number) => L + ((p - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const floor = pts[1]!, cap = pts[2]!;
  const path = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Payoff of the ${m.base} collar at close against the ${m.base} price`}>
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--line-strong)" />
      <line x1={X(m.spot)} x2={X(m.spot)} y1={T} y2={H - B} stroke="var(--ink-3)" strokeDasharray="2 4" />
      <text x={X(m.spot) + 5} y={T + 8} fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-mono)">now {usd(m.spot)}</text>
      <path d={`M${X(x0)},${Y(hold(x0))}L${X(x1)},${Y(hold(x1))}`} stroke="var(--ink-3)" strokeDasharray="2 5" fill="none" />
      <text x={X(x1) - 4} y={Y(hold(x1)) - 8} textAnchor="end" fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-sans)">just holding</text>
      <path d={path} stroke="var(--accent)" strokeWidth="2.5" fill="none" />
      <g fontSize="11" fontFamily="var(--font-mono)">
        <circle cx={X(floor[0])} cy={Y(floor[1])} r="3.5" fill="var(--accent)" />
        <text x={X(floor[0]) - 6} y={Y(floor[1]) + 18} textAnchor="end" fill="var(--ink-2)">floor {usd(floor[1])}</text>
        <circle cx={X(cap[0])} cy={Y(cap[1])} r="3.5" fill="var(--accent)" />
        <text x={X(cap[0]) + 6} y={Y(cap[1]) - 9} fill="var(--ink-2)">cap {usd(cap[1])}</text>
        <text x={L} y={H - 10} fill="var(--ink-3)">{usd(x0)}</text>
        <text x={W - R} y={H - 10} textAnchor="end" fill="var(--ink-3)">{usd(x1)}</text>
        <text x={W / 2} y={H - 10} textAnchor="middle" fill="var(--ink-3)" fontFamily="var(--font-sans)">{m.base} price at close</text>
      </g>
    </svg>
  );
}

export function Example() {
  const units = m.holdings.base.toLocaleString("en-US");
  const now = m.holdings.base * m.spot;
  const floor = m.target[1]!, cap = m.target[2]!;
  const borrowed = m.legs.filter((l) => l.kind.startsWith("borrow"));
  const provided = m.legs.filter((l) => l.kind.startsWith("provide"));
  const cells = [
    { k: "You hold", v: `${units} ${m.base}`, s: `worth ${usd(now, 2)} at ${usd(m.spot)}` },
    {
      k: "Most you can lose",
      v: usd(now - floor[1]),
      s: `value never below ${usd(floor[1])}, even if ${m.base} falls under ${usd(floor[0])}; plus at most ${usd(m.premiumBudget)} premium`,
    },
    { k: "Most you can gain", v: usd(cap[1] - now), s: `value capped at ${usd(cap[1])} once ${m.base} is above ${usd(cap[0])}` },
    {
      k: "FORGE builds it from",
      v: `${m.legs.length} Orca ranges`,
      s: `${borrowed.length} borrowed from LPs below ${usd(Math.max(...borrowed.map((l) => l.priceUpper)))}, ${provided.length} of your own ${m.base} above ${usd(Math.min(...provided.map((l) => l.priceLower)))}. Max error ±${usd(m.certifiedBound, 2)}`,
    },
  ];
  return (
    <section id="example" className="scroll-mt-14">
      <div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-24 sm:px-8 lg:grid-cols-[1fr_1.15fr] lg:items-center lg:gap-16">
        <Reveal>
          <div className="num flex items-center gap-3 text-[12px] text-ink-3">
            <span className="text-ink">{m.market}</span>
            <span className="h-px w-8 bg-line-strong" />
            The example
          </div>
          <h2 className="mt-5 font-display text-[clamp(1.9rem,3.4vw,3rem)] font-semibold leading-[1.02] tracking-[-0.03em]">
            {units} {m.base}, a floor and a cap.
          </h2>
          <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-ink-2">
            Most Solana tokens trade on Orca but have no options market. {m.base} is one of them: there is nowhere to buy a {m.base} put.
            So you draw the payoff instead, and FORGE builds it from {m.base}&apos;s own liquidity, certifies the worst-case error and opens it
            on-chain.
          </p>
          <div className="mt-8 border border-line bg-panel/50 p-3 sm:p-4">
            <PayoffDiagram />
          </div>
        </Reveal>
        <Reveal delay={120}>
          <dl className="grid border border-line sm:grid-cols-2">
            {cells.map((c, i) => (
              <div key={c.k} className={`border-line p-6 ${i % 2 ? "sm:border-l" : ""} ${i >= 2 ? "border-t" : i === 1 ? "border-t sm:border-t-0" : ""}`}>
                <dt className="cap">{c.k}</dt>
                <dd className="num mt-2 text-[28px] font-medium leading-none tracking-tight">{c.v}</dd>
                <dd className="mt-3 text-[13px] leading-relaxed text-ink-2">{c.s}</dd>
              </div>
            ))}
          </dl>
          <a href="#how" className="mt-5 inline-flex items-center gap-2 text-[13px] text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
            Watch this example step by step <span aria-hidden>↓</span>
          </a>
        </Reveal>
      </div>
    </section>
  );
}
