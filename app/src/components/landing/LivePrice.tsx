"use client";

import { useEffect, useState } from "react";
import { interp, type Point } from "@/lib/payoff";

const ORCA_API = "https://api.orca.so/v2/solana";

/**
 * Live card for the hero: the current price of the token's deepest Orca Whirlpool on mainnet (Orca's
 * public API) and the example collar evaluated at that price. Shows the snapshot until it loads.
 */
export function LivePrice({ base, quote, pool, units, spot, target }: { base: string; quote: string; pool: string; units: number; spot: number; target: Point[] }) {
  const [price, setPrice] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      setNow(Date.now());
      try {
        const r = (await (await fetch(`${ORCA_API}/pools/${pool}`)).json()) as { data: { price: string; updatedAt: string } };
        const p = Number(r.data.price);
        if (alive && p > 0) {
          setPrice(p);
          setAt(Date.parse(r.data.updatedAt));
        }
      } catch {
        /* keep the last value; the snapshot shows until the first live one arrives */
      }
    };
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pool]);

  const usd = (n: number, d = Math.abs(n) < 1 ? 4 : 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const P = price ?? spot;
  const lo = target[0]![0], hi = target[target.length - 1]![0];
  const collar = interp(target, Math.min(hi, Math.max(lo, P)));
  return (
    <>
      <div className="cap flex items-center gap-1.5">
        <span className={`size-1.5 ${price ? "animate-pulse bg-good" : "bg-ink-3"}`} />
        {price ? `${base}/${quote} live · Orca` : `${base}/${quote} at snapshot`}
      </div>
      <div className="num mt-1 text-[22px] font-medium leading-none">{usd(P)}</div>
      <div className="cap mt-1.5 leading-snug">
        Collar worth <span className="num text-ink-2">{usd(collar)}</span>
        <br />
        holding <span className="num">{usd(units * P)}</span>
        {at && <span title={new Date(at).toLocaleString()}> · {Math.max(0, Math.round((now - at) / 1000))}s ago</span>}
      </div>
    </>
  );
}
