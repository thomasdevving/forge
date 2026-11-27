"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MarketInfo } from "./api";

/** Every market is an Orca Whirlpool; SOL/USDC is only the default the app opens on. */
export const DEFAULT_MARKET = "SOL/USDC";
const KEY = "forge.market";

export const baseSymbol = (m: Pick<MarketInfo, "name"> | null | undefined) => m?.name.split("/")[0] ?? "base";
export const quoteSymbol = (m: Pick<MarketInfo, "name"> | null | undefined) => m?.name.split("/")[1] ?? "quote";

export function pickMarket(ms: MarketInfo[], name: string | null): MarketInfo | null {
  const same = (a: string, b: string | null) => a.toUpperCase() === b?.toUpperCase(); // on-chain symbols vary in case (Bonk vs BONK)
  return ms.find((m) => same(m.name, name)) ?? ms.find((m) => m.name === DEFAULT_MARKET) ?? ms[0] ?? null;
}

/** The selected market name: `?market=` in the URL wins, then the last choice in this browser. */
export function useMarketChoice(): [string | null, (name: string) => void] {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("market");
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* storage unavailable */
    }
    setName(fromUrl ?? saved ?? DEFAULT_MARKET);
  }, []);
  const choose = useCallback((n: string) => {
    setName(n);
    try {
      localStorage.setItem(KEY, n);
    } catch {
      /* storage unavailable */
    }
    const u = new URL(window.location.href);
    u.searchParams.set("market", n);
    window.history.replaceState(null, "", u);
  }, []);
  return [name, choose];
}

/** Base units for a default position of roughly the same USD size in every market (10 SOL on SOL/USDC). */
export function defaultUnits(m: MarketInfo): number {
  if (m.name === DEFAULT_MARKET) return 10;
  const raw = 700 / Math.max(m.poolPrice, 1e-9);
  const mag = 10 ** Math.floor(Math.log10(raw));
  return Math.round(raw / mag) * mag;
}

type Job = { id: string | null; state: "queued" | "running" | "done" | "failed"; log: string[]; market?: string; error?: string };

/** Onboard any token: the fork service finds its Orca pools and Pyth feeds and sets up a market. */
function AddMarket({ onAdded }: { onAdded: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mint, setMint] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && !job?.id && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [job]);
  useEffect(() => {
    if (!job?.id || job.state === "done" || job.state === "failed") return;
    const t = setInterval(async () => {
      try {
        const j = await api<Job>(`control/markets/jobs/${job.id}`);
        setJob(j);
        if (j.state === "done" && j.market) onAdded(j.market);
      } catch (e) {
        setErr((e as Error).message);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [job, onAdded]);

  const start = async () => {
    setErr(null);
    try {
      const j = await api<Job>("control/markets", { mint: mint.trim() });
      setJob(j);
      if (j.state === "done" && j.market) onAdded(j.market);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const busy = job?.state === "queued" || job?.state === "running";
  return (
    <div className="relative" ref={box}>
      <button className="btn btn-ghost !px-2 !py-0.5 !text-[12px]" onClick={() => setOpen((o) => !o)} title="Add any token as a market">+ Add</button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 border border-line-strong bg-bg p-3 text-[12px]">
          <div className="cap">Token mint</div>
          <div className="mt-1 flex gap-2">
            <input className="input" placeholder="e.g. DezXAZ8z…B263" value={mint} onChange={(e) => setMint(e.target.value)} disabled={busy} />
            <button className="btn btn-primary !py-1" disabled={busy || mint.trim().length < 32} onClick={start}>{busy ? "…" : "Add"}</button>
          </div>
          <p className="cap mt-2">Needs two Orca Whirlpools against USDC and a Pyth price feed. Pools and feeds are found automatically.</p>
          {job && (
            <div className="mt-2 border-t border-line pt-2">
              <div className={job.state === "failed" ? "text-bad" : job.state === "done" ? "text-good" : "text-ink-2"}>
                {job.state === "failed" ? job.error : job.state === "done" ? `${job.market} is live` : "Setting up on the fork…"}
              </div>
              {job.log.length > 0 && <div className="num mt-1 truncate text-[11px] text-ink-3" title={job.log.join("\n")}>{job.log[job.log.length - 1]}</div>}
            </div>
          )}
          {err && <p className="mt-2 text-bad">{err}</p>}
        </div>
      )}
    </div>
  );
}

export function MarketPicker({ markets: all, value, onChange }: { markets: MarketInfo[]; value: MarketInfo | null; onChange: (name: string) => void }) {
  const markets = [...all].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return (
    <span className="flex items-center gap-2">
      {markets.length > 3 ? (
        <select className="input !w-auto !py-0.5 !text-[12px]" value={value?.name ?? ""} onChange={(e) => onChange(e.target.value)} aria-label="Market">
          {markets.map((m) => <option key={m.address} value={m.name}>{m.name}</option>)}
        </select>
      ) : markets.length > 1 ? (
        <span className="seg !text-[12px]" role="group" aria-label="Market">
          {markets.map((m) => (
            <button key={m.address} aria-pressed={m.address === value?.address} onClick={() => onChange(m.name)} className="!px-2 !py-0.5">
              {m.name}
            </button>
          ))}
        </span>
      ) : (
        <span>{value?.name ?? "…"}</span>
      )}
      <AddMarket onAdded={onChange} />
    </span>
  );
}
