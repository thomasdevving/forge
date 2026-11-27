"use client";

import { useEffect, useState } from "react";
import { api, type BucketInfo, type MarketInfo } from "@/lib/api";
import { ago, fmtCompact, fmtUsd } from "@/lib/format";
import { DEFAULT_MARKET, pickMarket } from "@/lib/market";

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
        const mk = pickMarket(ms, DEFAULT_MARKET);
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
      <div className="flex items-center gap-3 border border-line px-5 py-4 text-sm text-ink-2">
        <span className="size-1.5 bg-ink-3" /> Live fork data is unavailable. The demo fork may be restarting.
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
    { k: m ? `${m.name} pool` : "Pool price", v: m ? fmtUsd(m.poolPrice) : "…", sub: m ? "Orca Whirlpool, fork" : "" },
    { k: "Reference", v: m?.reference ? fmtUsd(m.reference.price) : "…", sub: m?.reference ? `Pyth pair · ${ago(m.reference.ageSeconds)}` : "" },
    { k: "Borrowable", v: buckets ? fmtUsd(borrowableValue, 0) : "…", sub: buckets ? `${buckets.length} buckets · ${openLegs} open legs` : "" },
    {
      k: "Out of range on Orca",
      v: stats ? `$${fmtCompact(stats.outOfRange.outOfRangeQuoteValue)}` : "…",
      sub: stats ? "earning nothing" : "",
    },
  ];

  return (
    <div className="grid grid-cols-2 border border-line bg-panel/60 lg:grid-cols-4">
      {items.map((it) => (
        <div key={it.k} className="border-line px-5 py-4 [&:nth-child(-n+2)]:border-b lg:[&:nth-child(-n+2)]:border-b-0 [&:nth-child(even)]:border-l lg:[&:not(:first-child)]:border-l">
          <div className="cap flex items-center gap-1.5">
            {!down && <span className="size-1.5 animate-pulse bg-good" aria-hidden />} {it.k}
          </div>
          <div className="num mt-1.5 text-xl font-medium sm:text-2xl">{it.v}</div>
          <div className="cap mt-0.5 truncate">{it.sub}</div>
        </div>
      ))}
    </div>
  );
}
