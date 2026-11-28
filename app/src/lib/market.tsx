"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type MarketInfo } from "./api";
import { Select } from "@/components/Select";

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

type TokenHit = { address: string; symbol: string; name: string; image?: string; volume: number };
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const looksLikeMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());

/** Search tokens by name or symbol (Orca's public token API). Copycats share symbols, so volume decides order. */
async function searchTokens(q: string): Promise<TokenHit[]> {
  const r = await fetch(`https://api.orca.so/v2/solana/tokens/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  const { data } = (await r.json()) as {
    data: { address: string; tokenProgram: string; metadata?: { symbol?: string; name?: string; image?: string }; stats?: { "24h"?: { volume?: number | null } } }[];
  };
  return data
    .filter((x) => x.tokenProgram === SPL_TOKEN && x.metadata?.symbol)
    .map((x) => ({ address: x.address, symbol: x.metadata!.symbol!, name: x.metadata!.name ?? "", image: x.metadata!.image, volume: x.stats?.["24h"]?.volume ?? 0 }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 6);
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
    const busyJob = job?.state === "queued" || job?.state === "running";
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && !busyJob && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busyJob && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
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

  const [hits, setHits] = useState<TokenHit[]>([]);
  const [searching, setSearching] = useState(false);
  // the query the current hits answer (null: no search yet, or the search failed)
  const [searched, setSearched] = useState<string | null>(null);
  useEffect(() => {
    const q = mint.trim();
    if (q.length < 2 || looksLikeMint(q)) {
      setHits([]);
      setSearched(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const id = setTimeout(() => {
      searchTokens(q)
        .then((h) => live && (setHits(h), setSearched(q)))
        .catch(() => live && (setHits([]), setSearched(null)))
        .finally(() => live && setSearching(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [mint]);

  const start = async (address = mint.trim()) => {
    setErr(null);
    setHits([]);
    try {
      const j = await api<Job>("control/markets", { mint: address });
      setJob(j);
      if (j.state === "done" && j.market) onAdded(j.market);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const busy = job?.state === "queued" || job?.state === "running";
  // once the new market is live (and selected), the box has done its job
  useEffect(() => {
    if (job?.state !== "done") return;
    const t = setTimeout(() => {
      setOpen(false);
      setJob(null);
      setMint("");
    }, 1800);
    return () => clearTimeout(t);
  }, [job?.state]);
  return (
    <div className="relative" ref={box}>
      <button className="btn btn-ghost !px-2 !py-0.5 !text-[12px]" onClick={() => setOpen((o) => !o)} title="Add any token as a market">+ Add</button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 border border-line-strong bg-bg p-3 text-[12px]">
          <div className="cap">Token name, symbol or mint</div>
          <form
            className="mt-1 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              if (looksLikeMint(mint)) void start();
              else if (hits.length === 1) {
                setMint(hits[0]!.address);
                void start(hits[0]!.address);
              }
            }}
          >
            <input className="input" placeholder="e.g. Bonk or DezXAZ8z…" aria-label="Token name, symbol or mint" value={mint} onChange={(e) => setMint(e.target.value)} disabled={busy} autoFocus spellCheck={false} autoComplete="off" />
            <button type="submit" className="btn btn-primary !py-1" disabled={busy || !looksLikeMint(mint)} title={looksLikeMint(mint) ? "Set up this mint as a market" : "Pick a token from the list, or paste a mint address"}>{busy ? "…" : "Add"}</button>
          </form>
          {!searching && searched !== null && searched === mint.trim() && hits.length === 0 && (
            <p className="mt-2 text-ink-2">No SPL token on Orca matches “{searched}”. Try the symbol, or paste the mint address.</p>
          )}
          {(hits.length > 0 || searching) && (
            <ul className="mt-2 max-h-64 overflow-y-auto border border-line">
              {searching && !hits.length && <li className="cap px-2 py-2">Searching…</li>}
              {hits.map((h) => (
                <li key={h.address}>
                  <button
                    className="flex w-full items-center gap-2 border-b border-line px-2 py-1.5 text-left last:border-b-0 hover:bg-accent-soft"
                    onClick={() => {
                      setMint(h.address);
                      void start(h.address);
                    }}
                    disabled={busy}
                  >
                    {h.image ? <img src={h.image} alt="" referrerPolicy="no-referrer" className="size-5 shrink-0 rounded-full bg-line" /> : <span className="size-5 shrink-0 rounded-full bg-line" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{h.symbol} <span className="text-ink-3">{h.name}</span></span>
                      <span className="num block truncate text-[10px] text-ink-3">{h.address.slice(0, 6)}…{h.address.slice(-4)}</span>
                    </span>
                    <span className="num shrink-0 text-[10px] text-ink-3">{h.volume >= 1 ? `$${Math.round(h.volume).toLocaleString("en-US")} 24h` : "no volume"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
    <span className="flex items-center gap-2" data-tour="market">
      {markets.length > 3 ? (
        <Select
          className="[&>button]:!py-0.5 [&>button]:!text-[12px] [&>button]:min-w-[118px]"
          value={value?.name ?? ""}
          onChange={onChange}
          aria-label="Market"
          options={markets.map((m) => ({ value: m.name, label: m.name }))}
        />
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
