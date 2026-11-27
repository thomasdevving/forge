"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, Bar } from "@/components/AppShell";
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
    // the out-of-range scan is slow; never let it hold up the ladder
    void api<Stats>(`indexer/markets/${mk.address}/stats`).then(setStats).catch(() => {});
    setBuckets(await api<BucketInfo[]>(`indexer/markets/${mk.address}/buckets`));
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

  const claimPremium = mine.reduce((a, l) => a + atoms(l.premiumOwedNow, qd), 0);
  const claimBase = mine.reduce((a, l) => a + atoms(l.feesOwedBaseNow, bd), 0);
  const claimQuote = mine.reduce((a, l) => a + atoms(l.feesOwedQuoteNow, qd), 0);

  return (
    <AppShell>
      <Bar
        title="Earn"
        meta={
          <>
            <span>{m?.name ?? "…"}</span>
            <span>Pool <span className="num text-ink">{fmtUsd(m?.poolPrice)}</span></span>
            <span>{notice}h notice on borrowed liquidity</span>
          </>
        }
      />
      {msg && (
        <div className={`border-b border-line px-5 py-2.5 text-[13px] ${msg.ok ? "text-good" : "text-bad"}`}>
          {msg.text} {msg.sig && <Link className="num ml-2 text-ink-2 underline underline-offset-2 hover:text-ink" href={`/inspect?sig=${msg.sig}`}>inspect</Link>}
        </div>
      )}

      <div className="grid xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 xl:border-r xl:border-line">
          {/* headline numbers */}
          <div className="grid grid-cols-2 border-b border-line lg:grid-cols-4">
            {[
              ["Out of range on Orca", stats ? `$${fmtCompact(stats.outOfRange.outOfRangeQuoteValue)}` : "…", "earning nothing"],
              ["Below price", stats ? fmtUsd(stats.outOfRange.belowPriceQuote, 0) : "…", "USDC"],
              ["Above price", stats ? fmtUsd(stats.outOfRange.abovePriceBaseValued, 0) : "…", "SOL, valued"],
              ["Buckets", String(buckets.length), `${buckets.reduce((a, b) => a + b.openLegs, 0)} open legs`],
            ].map(([k, v, s], i) => (
              <div key={k} className={`px-4 py-4 sm:px-5 ${i % 2 ? "border-l" : ""} border-line ${i >= 2 ? "border-t lg:border-t-0" : ""} ${i === 2 ? "lg:border-l" : ""}`}>
                <div className="cap">{k}</div>
                <div className="num mt-1 text-xl font-medium">{v}</div>
                <div className="cap mt-0.5">{s}</div>
              </div>
            ))}
          </div>

          {/* ladder */}
          <div className="flex items-center justify-between px-4 py-3 sm:px-5">
            <div className="label">Buckets</div>
            <div className="flex items-center gap-4 text-[12px] text-ink-3">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-[3px] bg-accent" /> USDC, below</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-[3px] bg-steel" /> SOL, above</span>
            </div>
          </div>
          <div className="overflow-x-auto border-t border-line">
            <table className="tbl min-w-[880px]">
              <thead>
                <tr>{["Range", "Liquidity", "Used", "Borrowable", "Premium", "Fees", "Forgone", "Yours", ""].map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {buckets.map((b) => {
                  const lp = mine.find((x) => x.bucket === b.address);
                  const totalV = m ? Number(BigInt(b.totalLiquidity)) * valuePerUnit(m, b, P) : 0;
                  const borrowV = m ? Number(BigInt(b.borrowable)) * valuePerUnit(m, b, P) : 0;
                  const fees = atoms(b.feesCollectedQuote, qd) + atoms(b.feesCollectedBase, bd) * P;
                  const noticeSince = Number(b.withdrawalNoticeStart);
                  return (
                    <tr key={b.address} className={b.side === "spot" ? "bg-sunk" : ""}>
                      <td className="num">
                        <span className="flex items-center gap-2">
                          <span className={`h-2.5 w-[3px] ${b.side === "below" ? "bg-accent" : b.side === "above" ? "bg-steel" : "bg-line-strong"}`} />
                          {fmtUsd(b.priceLower)}–{fmtUsd(b.priceUpper)}
                        </span>
                      </td>
                      <td className="num">{fmtUsd(totalV, 0)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1 w-16 bg-line"><div className="h-full bg-accent" style={{ width: `${Math.min(100, b.utilization * 125)}%` }} /></div>
                          <span className="num text-[12px]">{fmtPct(b.utilization, 0)}</span>
                        </div>
                      </td>
                      <td className="num text-ink-2">{b.side === "spot" ? "—" : fmtUsd(borrowV, 0)}</td>
                      <td className="num">{fmtUsd(atoms(b.premiumDistributed, qd), 4)}</td>
                      <td className="num">{fmtUsd(fees, 4)}</td>
                      <td className="num text-ink-2">{fmtUsd(atoms(b.forgoneMeasured, qd), 4)}</td>
                      <td className="num">{lp ? fmtPct(lp.shareOfBucket, 1) : "—"}{noticeSince > 0 && <div className="font-sans text-[11px] text-warn">notice</div>}</td>
                      <td>
                        {lp && (
                          <div className="flex gap-1.5">
                            <button className="btn btn-ghost !px-2 !py-1 !text-[12px]" disabled={busy} onClick={() => run("tx/build/claim", { bucket: b.address }, "Claimed.")}>Claim</button>
                            {BigInt(b.borrowed) + BigInt(b.reserved) === 0n ? (
                              <button className="btn btn-ghost !px-2 !py-1 !text-[12px]" disabled={busy} onClick={() => run("tx/build/withdraw", { bucket: b.address, liquidity: lp.liquidity }, "Withdrawn.")}>Withdraw</button>
                            ) : (
                              <button className="btn btn-ghost !px-2 !py-1 !text-[12px]" disabled={busy || BigInt(lp.withdrawal_liquidity) > 0n} onClick={() => run("tx/build/request-withdrawal", { bucket: b.address, liquidity: lp.liquidity }, `Requested. Withdrawable after ${notice}h.`)}>
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
        </div>

        {/* side column */}
        <aside className="divide-y divide-line border-t border-line text-sm xl:border-t-0">
          <div className="p-5">
            <div className="label">Deposit</div>
            <label className="mt-3 block">
              <span className="cap">Bucket</span>
              <select className="input mt-1" value={dep?.address ?? ""} onChange={(e) => setDepBucket(e.target.value)}>
                {buckets.map((b) => (
                  <option key={b.address} value={b.address}>
                    {fmtUsd(b.priceLower)} – {fmtUsd(b.priceUpper)} · {fmtPct(b.utilization, 0)} used
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-2 block">
              <span className="cap">Value (USD)</span>
              <input className="input mt-1" type="number" min={1} value={depValue} onChange={(e) => setDepValue(Math.max(0, Number(e.target.value)))} />
            </label>
            <div className="kv mt-2"><span>Pays in</span><span>{dep ? (dep.side === "below" ? "USDC" : dep.side === "above" ? "SOL" : "SOL + USDC") : "—"}</span></div>
            <button
              className="btn btn-primary mt-3 w-full"
              disabled={!wallet.address || busy || depLiquidity <= 0n}
              onClick={() => run("tx/build/deposit", { bucket: dep!.address, liquidity: depLiquidity.toString() }, "Deposited.")}
            >
              Deposit
            </button>
          </div>

          <div className="p-5">
            <div className="label">FORGE vs Orca</div>
            {!wallet.address ? (
              <p className="cap mt-2">Connect a wallet.</p>
            ) : !mine.length ? (
              <p className="cap mt-2">No positions yet.</p>
            ) : (
              <div className="mt-2">
                <div className="kv"><span>Idle fees</span><span>{fmtUsd(compare.fees, 4)}</span></div>
                <div className="kv"><span>Fees forgone</span><span>{fmtUsd(compare.forgone, 4)}</span></div>
                <div className="kv"><span>Premium earned</span><span className="!text-good">{fmtUsd(compare.premium, 4)}</span></div>
                <div className="kv mt-1 border-t border-line pt-2"><span className="!text-ink">Difference</span><span className="font-medium">{fmtUsd(compare.premium - compare.forgone, 4)}</span></div>
                <p className="cap mt-2">Measured fees, same-trading assumption.</p>
              </div>
            )}
          </div>

          {mine.length > 0 && (
            <div className="p-5">
              <div className="label">Claimable</div>
              <div className="mt-2">
                <div className="kv"><span>Premium</span><span>{fmtUsd(claimPremium, 4)}</span></div>
                <div className="kv"><span>Fees, SOL</span><span>{fmtNum(claimBase, 6)}</span></div>
                <div className="kv"><span>Fees, USDC</span><span>{fmtUsd(claimQuote, 4)}</span></div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </AppShell>
  );
}
