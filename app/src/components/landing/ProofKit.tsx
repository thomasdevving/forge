import type { ReactNode } from "react";

/** Program pricing parameters as recorded by a benchmark run (programs/forge defaults at the time of the run). */
export type Curve = { base_ppm: number; slope1_ppm: number; kink_ppm: number; slope2_ppm: number; cap_ppm: number };
export type Pricing = ({ floor_rate_bps?: number; curve?: Curve } & Record<string, unknown>) | null | undefined;

const num = (x: number) => String(Number(x.toFixed(3)));

/** m(u), the multiplier on the LPs' forgone fees, in words: "1 + u to 60%, then +6 per unit of utilization to the 80% cap". */
export function describeCurve(c: Curve) {
  const base = c.base_ppm / 1e6, s1 = c.slope1_ppm / 1e6, s2 = c.slope2_ppm / 1e6;
  const kink = Math.round(c.kink_ppm / 1e4), cap = Math.round(c.cap_ppm / 1e4);
  const head = s1 === 0 ? `flat ${num(base)}×` : `${num(base)} + ${s1 === 1 ? "" : num(s1)}u`;
  if (s2 === s1) return `${head} to the ${cap}% cap`;
  return `${head} to ${kink}% utilization, then ${s2 > s1 ? "steeper" : "flatter"} (${s2 === 0 ? "flat" : `+${num(s2)} per unit`}) to the ${cap}% cap`;
}

/** One line naming the pricing a run used, read from its recorded parameters. Unknown fee fields are shown as recorded. */
export function describePricing(p: Pricing) {
  if (!p) return null;
  const parts: string[] = [];
  if (typeof p.floor_rate_bps === "number") parts.push(`floor ${num(p.floor_rate_bps / 100)}%/yr`);
  if (p.curve) parts.push(`multiplier ${describeCurve(p.curve)}`);
  const fees = Object.entries(p).filter(([k]) => /protocol/i.test(k));
  if (fees.length) {
    for (const [k, v] of fees) {
      if (typeof v === "number" && /bps/i.test(k)) parts.push(`protocol fee ${num(v / 100)}%${/excess|above/i.test(k) ? " of premium above the LPs' forgone fees" : ""}`);
      else parts.push(`${k.replace(/_/g, " ")} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  } else parts.push("no protocol fee");
  return parts.join(" · ");
}

export function PricingNote({ pricing, run }: { pricing: Pricing; run?: string | null }) {
  const d = describePricing(pricing);
  if (!d) return null;
  return (
    <p className="cap mt-3 leading-relaxed">
      Pricing in this run{run ? ` (${run})` : ""}: <span className="text-ink-2">{d}</span>.
    </p>
  );
}

/** Method / result / caveats, the same three parts for every piece of evidence. */
export function Part({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="py-4">
      <div className="num text-[11px] uppercase tracking-[0.18em] text-ink-3">{label}</div>
      <div className={`mt-2.5 min-w-0 text-[14px] leading-relaxed text-ink-2 ${wide ? "" : "max-w-3xl"}`}>{children}</div>
    </div>
  );
}

export function Caveats({ items }: { items: ReactNode[] }) {
  return (
    <Part label="Caveats">
      <ul className="space-y-2">
        {items.map((t, i) => (
          <li key={i} className="grid grid-cols-[12px_1fr] gap-2"><span className="text-ink-3" aria-hidden>–</span><span>{t}</span></li>
        ))}
      </ul>
    </Part>
  );
}

export function ProofHead({ id, n, kicker, title, lead }: { id: string; n: string; kicker: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <header id={id} className="scroll-mt-24">
      <div className="num flex items-center gap-3 text-[12px] text-ink-3">
        <span className="text-ink">{n}</span>
        <span className="h-px w-8 bg-line-strong" />
        {kicker}
      </div>
      <h2 className="mt-4 font-display text-[clamp(1.7rem,3vw,2.5rem)] font-semibold leading-[1.04] tracking-[-0.03em]">{title}</h2>
      {lead && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-2">{lead}</p>}
    </header>
  );
}

/** Large figure with a caption, for the result of each part. */
export function Stat({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="border-line p-5">
      <div className={`num text-[clamp(1.8rem,3vw,2.6rem)] font-medium leading-none tracking-tight ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink"}`}>{value}</div>
      <div className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">{label}</div>
    </div>
  );
}
