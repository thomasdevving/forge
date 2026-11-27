"use client";

import { useEffect, useState } from "react";
import { api, type BucketInfo, type MarketInfo } from "@/lib/api";
import { ago, fmtCompact, fmtUsd } from "@/lib/format";

type Stats = { price: number; outOfRange: { outOfRangeQuoteValue: number; window: { low: number; high: number } } };

/** Live numbers from the indexer. If the fork is unreachable, say so; never show placeholders. */
export function LiveStrip() {
  const [m, setM] = useState<MarketInfo | null>(null);
  const [buckets, setBuckets] = useState<BucketInfo[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const ms = await api<MarketInfo[]>("indexer/markets");
        const mk = ms[0];
        if (!mk || !alive) return;
        setM(mk);
        const [b, s] = await Promise.all([
          api<BucketInfo[]>(`indexer/markets/${mk.address}/buckets`),
          api<Stats>(`indexer/markets/${mk.address}/stats`),
        ]);
        if (!alive) return;
        setBuckets(b);
        setStats(s);
        setDown(false);
      } catch {
        if (alive) setDown(true);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (down && !m) {
    return (
      <div className="card flex items-center gap-3 px-5 py-4 text-sm text-ink-2">
        <span className="size-2 rounded-full bg-ink-3" /> Live fork data is unavailable right now. The demo fork may be restarting.
      </div>
    );
  }

  const scale = m ? 10 ** (-(m.baseDecimals + m.quoteDecimals) / 2) : 0;
  const borrowableValue = (buckets ?? []).reduce((a, b) => {
    const L = Number(BigInt(b.borrowable)) * scale;
    const v = b.side === "below"
      ? L * (Math.sqrt(b.priceUpper) - Math.sqrt(b.priceLower))
      : b.side === "above" && m
        ? L * (1 / Math.sqrt(b.priceLower) - 1 / Math.sqrt(b.priceUpper)) * m.poolPrice
        : 0;
    return a + v;
  }, 0);
  const openLegs = (buckets ?? []).reduce((a, b) => a + b.openLegs, 0);

  const items = [
    { k: m ? `${m.name} pool price` : "Pool price", v: m ? fmtUsd(m.poolPrice) : "…", sub: m ? "Orca Whirlpool on the fork" : "" },
    { k: "Independent reference", v: m?.reference ? fmtUsd(m.reference.price) : "…", sub: m?.reference ? `Pyth pair · ${ago(m.reference.ageSeconds)}` : "" },
    { k: "Borrowable in FORGE buckets", v: buckets ? fmtUsd(borrowableValue, 0) : "…", sub: buckets ? `${buckets.length} buckets · ${openLegs} open legs` : "" },
    {
      k: "Orca liquidity out of range",
      v: stats ? `$${fmtCompact(stats.outOfRange.outOfRangeQuoteValue)}` : "…",
      sub: stats ? `earning nothing · ${fmtUsd(stats.outOfRange.window.low, 0)}–${fmtUsd(stats.outOfRange.window.high, 0)} scanned` : "",
    },
  ];

  return (
    <div className="card grid grid-cols-2 divide-line overflow-hidden lg:grid-cols-4 lg:divide-x">
      {items.map((it) => (
        <div key={it.k} className="border-b border-line px-5 py-4 lg:border-b-0">
          <div className="label flex items-center gap-1.5">
            {!down && <span className="size-1.5 animate-pulse rounded-full bg-good" aria-hidden />} {it.k}
          </div>
          <div className="num mt-1.5 text-xl font-semibold sm:text-2xl">{it.v}</div>
          <div className="mt-0.5 truncate text-xs text-ink-3">{it.sub}</div>
        </div>
      ))}
    </div>
  );
}
