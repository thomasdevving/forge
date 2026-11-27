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
      if (!userBase || !userQuote) throw new Error("Your wallet needs wrapped SOL and USDC accounts. Use “Get fork test funds” in the wallet menu.");
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
        <div className="label">Earn</div>
        <h1 className="font-display text-2xl font-semibold">Provide liquidity that keeps earning while it is borrowed</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">Unborrowed liquidity stays in the Orca pool and keeps its fees. Borrowed liquidity is paid max(time floor, m(u) × forgone fees), measured from Orca&apos;s own fee growth. Borrowed liquidity has a {notice}-hour withdrawal notice.</p>
      </div>
      {msg && (
        <div className={`card mb-4 px-4 py-3 text-sm ${msg.ok ? "text-good" : "text-bad"}`}>
          {msg.text} {msg.sig && <Link className="num ml-2 text-ember hover:underline" href={`/inspect?sig=${msg.sig}`}>inspect</Link>}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-1">
          <div className="label">Orca liquidity out of range right now</div>
          <div className="num mt-2 text-3xl font-semibold">{stats ? `$${fmtCompact(stats.outOfRange.outOfRangeQuoteValue)}` : "…"}</div>
          <p className="mt-1 text-xs text-ink-3">
            {stats ? <>earning no fees in the {m?.name} pool · {fmtUsd(stats.outOfRange.belowPriceQuote, 0)} below and {fmtUsd(stats.outOfRange.abovePriceBaseValued, 0)} above the price · scanned {fmtUsd(stats.outOfRange.window.low, 0)}–{fmtUsd(stats.outOfRange.window.high, 0)}</> : "computed live from the pool's tick arrays"}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-ink-2">In FORGE, out-of-range liquidity is exactly what borrowers want: it can earn premiums instead of nothing.</p>
        </div>

        <div className="card p-5 lg:col-span-2">
          <div className="label">FORGE vs staying in Orca (your positions)</div>
          {wallet.address ? (
            mine.length ? (
              <div className="mt-3 grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-sunk p-3"><div className="text-xs text-ink-3">Idle fees (same in both)</div><div className="num mt-1 text-lg font-semibold">{fmtUsd(compare.fees, 4)}</div></div>
                <div className="rounded-lg bg-sunk p-3"><div className="text-xs text-ink-3">Fees forgone while borrowed (your share, measured)</div><div className="num mt-1 text-lg font-semibold">{fmtUsd(compare.forgone, 4)}</div></div>
                <div className="rounded-lg bg-sunk p-3"><div className="text-xs text-ink-3">Premium earned instead</div><div className="num mt-1 text-lg font-semibold text-good">{fmtUsd(compare.premium, 4)}</div></div>
                <p className="col-span-3 text-xs leading-relaxed text-ink-3">
                  Staying in Orca would have earned idle fees + the forgone fees. FORGE paid idle fees + premium: a difference of <span className="num">{fmtUsd(compare.premium - compare.forgone, 4)}</span>.
                  This compares measured compensation under the counterfactual that trading would have been the same with your liquidity present; it is not a claim about every market path.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-2">No LP positions yet. Deposit into a bucket below.</p>
            )
          ) : (
            <p className="mt-3 text-sm text-ink-2">Connect a wallet to see your comparison.</p>
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
                  {fmtUsd(b.priceLower)} – {fmtUsd(b.priceUpper)} · {b.side === "spot" ? "contains price" : b.side} · {fmtPct(b.utilization, 0)} used
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
            onClick={() => run("tx/build/deposit", { bucket: dep!.address, liquidity: depLiquidity.toString() }, "Deposited. Your liquidity is live in the bucket.")}
          >
            Deposit
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          {dep ? (dep.side === "below" ? "Below the price: you deposit USDC." : dep.side === "above" ? "Above the price: you deposit SOL." : "Contains the price: you deposit both tokens.") : ""} Liquidity units: <span className="num">{depLiquidity.toLocaleString()}</span>. Existing Orca positions on the bucket grid can be redeployed into the ladder with the staged deposit (SDK and CLI).
        </p>
      </div>

      {/* ladder */}
      <div className="card mt-5 overflow-hidden">
        <div className="border-b border-line px-5 py-3"><div className="label">Bucket ladder · {m?.name}</div></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr className="border-b border-line">
                {["Range", "Liquidity value", "Utilization", "Borrowable", "Premium paid", "Fees collected", "Forgone (measured)", "Your share", ""].map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}
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
                    <td className="num px-4 py-2.5">{lp ? fmtPct(lp.shareOfBucket, 1) : "—"}{noticeSince > 0 && <div className="font-sans text-[11px] text-warn">withdrawal notice</div>}</td>
                    <td className="px-4 py-2.5">
                      {lp && (
                        <div className="flex gap-1.5">
                          <button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={busy} onClick={() => run("tx/build/claim", { bucket: b.address }, "Claimed premium and fees.")}>Claim</button>
                          {BigInt(b.borrowed) + BigInt(b.reserved) === 0n ? (
                            <button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={busy} onClick={() => run("tx/build/withdraw", { bucket: b.address, liquidity: lp.liquidity }, "Withdrawn.")}>Withdraw</button>
                          ) : (
                            <button className="btn btn-ghost !px-2 !py-1 text-xs" disabled={busy || BigInt(lp.withdrawal_liquidity) > 0n} onClick={() => run("tx/build/request-withdrawal", { bucket: b.address, liquidity: lp.liquidity }, `Withdrawal requested. After ${notice} h, keepers may close positions borrowing this bucket.`)}>
                              {BigInt(lp.withdrawal_liquidity) > 0n ? "Requested" : "Request withdrawal"}
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
            Your owed now: <span className="num">{fmtUsd(mine.reduce((a, l) => a + atoms(l.premiumOwedNow, qd), 0), 4)}</span> premium ·{" "}
            <span className="num">{fmtNum(mine.reduce((a, l) => a + atoms(l.feesOwedBaseNow, bd), 0), 6)}</span> SOL and{" "}
            <span className="num">{fmtUsd(mine.reduce((a, l) => a + atoms(l.feesOwedQuoteNow, qd), 0), 4)}</span> in fees (fees collected so far; claim collects the rest).
          </p>
        )}
      </div>
    </AppShell>
  );
}
