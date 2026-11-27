"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api, type BucketInfo, type BuiltTx, type LpView, type MarketInfo } from "@/lib/api";
import { USDC, WSOL } from "@/lib/config";
import { atoms, fmtCompact, fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { tokenAccount } from "@/lib/rpc";
import { useWallet } from "@/lib/wallet";

type Stats = { price: number; outOfRange: { outOfRangeQuoteValue: number; belowPriceQuote: number; abovePriceBaseValued: number; window: { low: number; high: number } } };

/** Quote value of one on-chain liquidity unit in a range at price P (human units). */
function valuePerUnit(m: MarketInfo, b: { priceLower: number; priceUpper: number }, P: number) {
  const scale = 10 ** (-(m.baseDecimals + m.quoteDecimals) / 2);
  const ra = Math.sqrt(b.priceLower), rb = Math.sqrt(b.priceUpper);
  const s = Math.min(Math.max(Math.sqrt(P), ra), rb);
  return scale * ((1 / s - 1 / rb) * P + (s - ra));
}

export default function Earn() {
  const wallet = useWallet();
  const [m, setM] = useState<MarketInfo | null>(null);
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [mine, setMine] = useState<LpView[]>([]);
  const [depBucket, setDepBucket] = useState<string>("");
  const [depValue, setDepValue] = useState(500);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);

  const load = useCallback(async () => {
    const ms = await api<MarketInfo[]>("indexer/markets");
    const mk = ms[0];
    if (!mk) return;
    setM(mk);
    const [b, st] = await Promise.all([
      api<BucketInfo[]>(`indexer/markets/${mk.address}/buckets`),
      api<Stats>(`indexer/markets/${mk.address}/stats`).catch(() => null),
    ]);
    setBuckets(b);
    if (st) setStats(st);
    if (wallet.address) setMine(await api<LpView[]>(`indexer/lp?owner=${wallet.address}`));
  }, [wallet.address]);

  useEffect(() => {
    void load().catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    const t = setInterval(() => void load().catch(() => {}), 12_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (path: string, body: Record<string, unknown>, done: string) => {
    if (!wallet.address || !m) return;
    setBusy(true);
    setMsg(null);
    try {
      const userBase = await tokenAccount(wallet.address, WSOL);
      const userQuote = await tokenAccount(wallet.address, USDC);
      if (!userBase || !userQuote) throw new Error("No SOL/USDC token accounts. Get test funds from the wallet menu.");
      const built = await api<{ transactions: BuiltTx[] }>(path, { owner: wallet.address, market: m.address, userBase, userQuote, ...body });
      const sigs = await wallet.execute(built.transactions);
      setMsg({ ok: true, text: done, sig: sigs.at(-1) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const qd = m?.quoteDecimals ?? 6, bd = m?.baseDecimals ?? 9;
  const P = m?.poolPrice ?? 0;
  const byAddr = useMemo(() => new Map(buckets.map((b) => [b.address, b])), [buckets]);

  // FORGE vs staying in Orca, from chain data only
  const compare = useMemo(() => {
    let premium = 0, forgone = 0, fees = 0;
    for (const lp of mine) {
      const b = byAddr.get(lp.bucket);
      premium += atoms(lp.premiumOwedNow, qd) + atoms(lp.premium_claimed, qd);
      fees += atoms(lp.feesOwedQuoteNow, qd) + atoms(lp.fees_claimed_quote, qd) + (atoms(lp.feesOwedBaseNow, bd) + atoms(lp.fees_claimed_base, bd)) * P;
      if (b) forgone += atoms(b.forgoneMeasured, qd) * lp.shareOfBucket;
    }
    return { premium, forgone, fees };
  }, [mine, byAddr, qd, bd, P]);

  const dep = buckets.find((b) => b.address === depBucket) ?? buckets.find((b) => b.side === "below");
  const depLiquidity = m && dep ? BigInt(Math.floor(depValue / valuePerUnit(m, dep, P))) : 0n;
  const notice = m ? m.params.notice_period_s / 3600 : 24;

  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold">Earn</h1>
        <p className="mt-1 text-sm text-ink-2">Idle liquidity keeps its Orca fees. Borrowed liquidity earns premium. {notice}h notice to withdraw borrowed liquidity.</p>
      </div>
      {msg && (
        <div className={`card mb-4 px-4 py-3 text-sm ${msg.ok ? "text-good" : "text-bad"}`}>
          {msg.text} {msg.sig && <Link className="num ml-2 text-ember hover:underline" href={`/inspect?sig=${msg.sig}`}>inspect</Link>}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-1">
          <div className="label">Orca liquidity out of range</div>
          <div className="num mt-2 text-3xl font-semibold">{stats ? `$${fmtCompact(stats.outOfRange.outOfRangeQuoteValue)}` : "…"}</div>
          <p className="mt-1 text-xs text-ink-3">
            {stats ? <>earning nothing · {fmtUsd(stats.outOfRange.belowPriceQuote, 0)} below, {fmtUsd(stats.outOfRange.abovePriceBaseValued, 0)} above</> : "live"}
          </p>
        </div>

        <div className="card p-5 lg:col-span-2">
          <div className="label">FORGE vs Orca</div>
          {wallet.address ? (
            mine.length ? (
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-sunk p-3"><div className="text-xs text-ink-3">Idle fees</div><div className="num mt-1 text-lg font-semibold">{fmtUsd(compare.fees, 4)}</div></div>
                <div className="rounded-lg bg-sunk p-3"><div className="text-xs text-ink-3">Fees forgone</div><div className="num mt-1 text-lg font-semibold">{fmtUsd(compare.forgone, 4)}</div></div>
                <div className="rounded-lg bg-sunk p-3"><div className="text-xs text-ink-3">Premium earned</div><div className="num mt-1 text-lg font-semibold text-good">{fmtUsd(compare.premium, 4)}</div></div>
                <p className="col-span-3 text-xs text-ink-3">
                  Difference <span className="num">{fmtUsd(compare.premium - compare.forgone, 4)}</span> · measured fees, same-trading assumption
                </p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-2">No positions yet.</p>
            )
          ) : (
            <p className="mt-3 text-sm text-ink-2">Connect a wallet.</p>
          )}
        </div>
      </div>

      {/* deposit */}
      <div className="card mt-5 p-5">
        <div className="label">Deposit</div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block min-w-56 flex-1">
            <span className="text-xs text-ink-3">Bucket</span>
            <select className="input mt-1" value={dep?.address ?? ""} onChange={(e) => setDepBucket(e.target.value)}>
              {buckets.map((b) => (
                <option key={b.address} value={b.address}>
                  {fmtUsd(b.priceLower)} – {fmtUsd(b.priceUpper)} · {fmtPct(b.utilization, 0)} used
                </option>
              ))}
            </select>
          </label>
          <label className="block w-40">
            <span className="text-xs text-ink-3">Value (USD)</span>
            <input className="input mt-1" type="number" min={1} value={depValue} onChange={(e) => setDepValue(Math.max(0, Number(e.target.value)))} />
          </label>
          <button
            className="btn btn-primary"
            disabled={!wallet.address || busy || depLiquidity <= 0n}
            onClick={() => run("tx/build/deposit", { bucket: dep!.address, liquidity: depLiquidity.toString() }, "Deposited.")}
          >
            Deposit
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {dep ? (dep.side === "below" ? "Pays in USDC." : dep.side === "above" ? "Pays in SOL." : "Pays in SOL and USDC.") : ""}
        </p>
      </div>

      {/* ladder */}
      <div className="card mt-5 overflow-hidden">
        <div className="border-b border-line px-5 py-3"><div className="label">Buckets · {m?.name}</div></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr className="border-b border-line">
                {["Range", "Liquidity", "Used", "Borrowable", "Premium", "Fees", "Forgone", "Yours", ""].map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => {
                const lp = mine.find((x) => x.bucket === b.address);
                const totalV = m ? Number(BigInt(b.totalLiquidity)) * valuePerUnit(m, b, P) : 0;
                const borrowV = m ? Number(BigInt(b.borrowable)) * valuePerUnit(m, b, P) : 0;
                const fees = atoms(b.feesCollectedQuote, qd) + atoms(b.feesCollectedBase, bd) * P;
                const noticeSince = Number(b.withdrawalNoticeStart);
                return (
                  <tr key={b.address} className={`border-b border-line/60 last:border-0 ${b.side === "spot" ? "bg-sunk/60" : ""}`}>
                    <td className="num px-4 py-2.5">
                      <span className={`mr-2 inline-block size-2 rounded-full ${b.side === "below" ? "bg-ember" : b.side === "above" ? "bg-steel" : "bg-ink-3"}`} />
                      {fmtUsd(b.priceLower)}–{fmtUsd(b.priceUpper)}
                    </td>
                    <td className="num px-4 py-2.5">{fmtUsd(totalV, 0)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-sunk"><div className="h-full rounded-full bg-ember" style={{ width: `${Math.min(100, b.utilization * 125)}%` }} /></div>
                        <span className="num text-xs">{fmtPct(b.utilization, 0)}</span>
                      </div>
                    </td>
                    <td className="num px-4 py-2.5 text-ink-2">{b.side === "spot" ? "—" : fmtUsd(borrowV, 0)}</td>
                    <td className="num px-4 py-2.5">{fmtUsd(atoms(b.premiumDistributed, qd), 4)}</td>
                    <td className="num px-4 py-2.5">{fmtUsd(fees, 4)}</td>
                    <td className="num px-4 py-2.5 text-ink-2">{fmtUsd(atoms(b.forgoneMeasured, qd), 4)}</td>
                    <td className="num px-4 py-2.5">{lp ? fmtPct(lp.shareOfBucket, 1) : "—"}{noticeSince > 0 && <div className="font-sans text-[11px] text-warn">notice</div>}</td>
                    <td className="px-4 py-2.5">
                      {lp && (
                        <div className="flex gap-1.5">
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={busy} onClick={() => run("tx/build/claim", { bucket: b.address }, "Claimed.")}>Claim</button>
                          {BigInt(b.borrowed) + BigInt(b.reserved) === 0n ? (
                            <button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={busy} onClick={() => run("tx/build/withdraw", { bucket: b.address, liquidity: lp.liquidity }, "Withdrawn.")}>Withdraw</button>
                          ) : (
                            <button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={busy || BigInt(lp.withdrawal_liquidity) > 0n} onClick={() => run("tx/build/request-withdrawal", { bucket: b.address, liquidity: lp.liquidity }, `Requested. Withdrawable after ${notice}h.`)}>
                              {BigInt(lp.withdrawal_liquidity) > 0n ? "Requested" : "Request"}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {mine.length > 0 && (
          <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
            Claimable: <span className="num">{fmtUsd(mine.reduce((a, l) => a + atoms(l.premiumOwedNow, qd), 0), 4)}</span> premium ·{" "}
            <span className="num">{fmtNum(mine.reduce((a, l) => a + atoms(l.feesOwedBaseNow, bd), 0), 6)}</span> SOL +{" "}
            <span className="num">{fmtUsd(mine.reduce((a, l) => a + atoms(l.feesOwedQuoteNow, qd), 0), 4)}</span> fees
          </p>
        )}
      </div>
    </AppShell>
  );
}
