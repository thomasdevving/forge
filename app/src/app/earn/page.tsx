"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell, Bar } from "@/components/AppShell";
import { api, type BucketInfo, type BuiltTx, type LpView, type MarketInfo } from "@/lib/api";
import { atoms, fmtCompact, fmtNum, fmtPct, fmtPrice, fmtUsd } from "@/lib/format";
import { tokenAccount } from "@/lib/rpc";
import { baseSymbol, MarketPicker, pickMarket, quoteSymbol, useMarketChoice } from "@/lib/market";
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
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [marketName, chooseMarket] = useMarketChoice();
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [mine, setMine] = useState<LpView[]>([]);
  const [depBucket, setDepBucket] = useState<string>("");
  const [depValue, setDepValue] = useState(500);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);

  const load = useCallback(async () => {
    if (!marketName) return;
    const ms = await api<MarketInfo[]>("indexer/markets");
    const mk = pickMarket(ms, marketName);
    if (!mk) return;
    setMarkets(ms);
    setM(mk);
    // the out-of-range scan is slow; never let it hold up the ladder
    void api<Stats>(`indexer/markets/${mk.address}/stats`).then(setStats).catch(() => {});
    setBuckets(await api<BucketInfo[]>(`indexer/markets/${mk.address}/buckets`));
    if (wallet.address) setMine((await api<LpView[]>(`indexer/lp?owner=${wallet.address}`)).filter((l) => l.market === mk.address));
  }, [wallet.address, marketName]);

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
      const userBase = await tokenAccount(wallet.address, m.baseMint);
      const userQuote = await tokenAccount(wallet.address, m.quoteMint);
      if (!userBase || !userQuote) throw new Error(`No ${m.name} token accounts. Get test funds from the wallet menu.`);
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

  // what you receive per unit of fees you forgo when lent at a bucket's current utilization: the
  // program's m(u), less the protocol's share of the part above 1x (programs/forge premium.rs)
  const multiplier = (u: number) => {
    if (!m) return 1;
    const c = m.params.curve, k = c.kink_ppm / 1e6, base = c.base_ppm / 1e6;
    const mu = u <= k ? base + (c.slope1_ppm / 1e6) * u : base + (c.slope1_ppm / 1e6) * k + (c.slope2_ppm / 1e6) * (u - k);
    return mu - ((m.params.protocol_fee_bps ?? 0) / 1e4) * Math.max(0, mu - 1);
  };
  const floorPct = m ? m.params.floor_rate_bps / 100 : 5;
  const B = baseSymbol(m), Q = quoteSymbol(m);
  const earnedTotal = compare.fees + compare.premium;
  const depTokens = dep && P > 0 ? (dep.side === "below" ? `${fmtNum(depValue, 2)} ${Q}` : dep.side === "above" ? `${fmtNum(depValue / P, P < 1 ? 0 : 4)} ${B}` : `${B} and ${Q}`) : "";

  return (
    <AppShell>
      <Bar
        title="Earn"
        meta={
          <>
            <MarketPicker markets={markets} value={m} onChange={chooseMarket} />
            <span>Pool <span className="num text-ink">{fmtPrice(m?.poolPrice)}</span></span>
          </>
        }
      />
      {msg && (
        <div className={`border-b border-line px-5 py-2.5 text-[13px] ${msg.ok ? "text-good" : "text-bad"}`}>
          {msg.text} {msg.sig && <Link className="num ml-2 text-ink-2 underline underline-offset-2 hover:text-ink" href={`/inspect?sig=${msg.sig}`}>inspect</Link>}
        </div>
      )}

      {/* how it works, in one line each */}
      <div data-tour="earn-how" className="grid shrink-0 border-b border-line lg:grid-cols-[1fr_1fr_1fr_minmax(0,0.9fr)]">
        {[
          ["1", "Pick a price range", `Deposit into a range of the ${B}/${Q} Orca pool, like any Orca LP position.`],
          ["2", "Earn Orca fees", `While nobody borrows it, your liquidity trades in the pool and earns normal fees.`],
          ["3", "Get paid when it's borrowed", `A trader who borrows it pays you at least the fees you miss, times a multiplier, and never under ${floorPct}% a year.`],
        ].map(([n, h, s], i) => (
          <div key={n} className={`flex gap-3 border-line px-4 py-3 sm:px-5 ${i ? "border-t lg:border-l lg:border-t-0" : ""}`}>
            <span className="num text-[12px] text-ink-3">{n}</span>
            <div>
              <div className="text-[13px] font-medium text-ink">{h}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{s}</div>
            </div>
          </div>
        ))}
        <div className="border-t border-line px-4 py-3 sm:px-5 lg:border-l lg:border-t-0">
          <div className="cap">Idle on Orca right now</div>
          <div className="num mt-0.5 text-lg font-medium">{stats ? `$${fmtCompact(stats.outOfRange.outOfRangeQuoteValue)}` : "…"}</div>
          <div className="cap">out of range, earning nothing</div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ranges */}
        <div data-tour="earn-table" className="flex min-h-0 min-w-0 flex-col xl:border-r xl:border-line">
          <div className="flex shrink-0 items-center justify-between px-4 py-2.5 sm:px-5">
            <div className="label">Choose a price range</div>
            <div className="flex items-center gap-4 text-[12px] text-ink-3">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-[3px] bg-accent" /> below the price: you add {Q}</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-[3px] bg-steel" /> above: you add {B}</span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto border-t border-line">
            <table className="tbl tbl-dense min-w-[860px]">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr>{["Price range", "In the pool", "Lent out", "You receive when lent", "Paid to LPs", "Yours", ""].map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {buckets.map((b) => {
                  const lp = mine.find((x) => x.bucket === b.address);
                  const totalV = m ? Number(BigInt(b.totalLiquidity)) * valuePerUnit(m, b, P) : 0;
                  const paid = atoms(b.premiumDistributed, qd) + atoms(b.feesCollectedQuote, qd) + atoms(b.feesCollectedBase, bd) * P;
                  const noticeSince = Number(b.withdrawalNoticeStart);
                  const selected = dep?.address === b.address;
                  return (
                    <tr
                      key={b.address}
                      onClick={() => setDepBucket(b.address)}
                      className={`cursor-pointer ${selected ? "bg-accent-soft" : b.side === "spot" ? "bg-sunk" : ""}`}
                      aria-selected={selected}
                    >
                      <td className="num">
                        <span className="flex items-center gap-2">
                          <span className={`h-2.5 w-[3px] ${b.side === "below" ? "bg-accent" : b.side === "above" ? "bg-steel" : "bg-line-strong"}`} />
                          {fmtPrice(b.priceLower)}–{fmtPrice(b.priceUpper)}
                          {b.side === "spot" && <span className="font-sans text-[11px] text-ink-3">at the price</span>}
                        </span>
                      </td>
                      <td className="num">{fmtUsd(totalV, 0)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1 w-14 bg-line"><div className="h-full bg-accent" style={{ width: `${Math.min(100, b.utilization * 125)}%` }} /></div>
                          <span className="num text-[12px]">{fmtPct(b.utilization, 0)}</span>
                        </div>
                      </td>
                      <td className="num text-ink-2">{b.side === "spot" ? "not lendable" : `${multiplier(b.utilization).toFixed(2)}× fees`}</td>
                      <td className="num">{fmtUsd(paid, 2)}</td>
                      <td className="num">{lp ? fmtPct(lp.shareOfBucket, 1) : "—"}{noticeSince > 0 && <div className="font-sans text-[11px] text-warn">withdrawal requested</div>}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {lp && (
                          <div data-tour="earn-claim" className="flex gap-1.5">
                            <button className="btn btn-ghost !px-2 !py-1 !text-[12px]" disabled={busy} onClick={() => run("tx/build/claim", { bucket: b.address }, "Claimed.")}>Claim</button>
                            {BigInt(b.borrowed) + BigInt(b.reserved) === 0n ? (
                              <button className="btn btn-ghost !px-2 !py-1 !text-[12px]" disabled={busy} onClick={() => run("tx/build/withdraw", { bucket: b.address, liquidity: lp.liquidity }, "Withdrawn.")}>Withdraw</button>
                            ) : (
                              <button className="btn btn-ghost !px-2 !py-1 !text-[12px]" disabled={busy || BigInt(lp.withdrawal_liquidity) > 0n} title={`Lent-out liquidity needs ${notice}h notice`} onClick={() => run("tx/build/request-withdrawal", { bucket: b.address, liquidity: lp.liquidity }, `Requested. Withdrawable after ${notice}h.`)}>
                                {BigInt(lp.withdrawal_liquidity) > 0n ? "Requested" : `Withdraw (${notice}h)`}
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

        {/* deposit + earnings */}
        <aside className="min-h-0 divide-y divide-line overflow-y-auto border-t border-line text-sm xl:border-t-0">
          <div data-tour="earn-deposit" className="p-5">
            <div className="flex items-baseline justify-between">
              <div className="label">Deposit</div>
              <span className="cap">click a range to change</span>
            </div>
            {dep ? (
              <>
                <div className="num mt-2 text-[17px] font-medium">{fmtPrice(dep.priceLower)} – {fmtPrice(dep.priceUpper)}</div>
                <ul className="mt-2 space-y-1.5 text-[12.5px] leading-snug text-ink-2">
                  {dep.side === "below" && <li>Below today&apos;s price: you add <span className="text-ink">{Q}</span>. If {B} falls into this range your {Q} gradually turns into {B}, like any Orca position.</li>}
                  {dep.side === "above" && <li>Above today&apos;s price: you add <span className="text-ink">{B}</span>. If {B} rises into this range your {B} gradually turns into {Q}, like any Orca position.</li>}
                  {dep.side === "spot" && <li>Contains today&apos;s price: you add both tokens and earn fees right away. This range cannot be lent out.</li>}
                  {dep.side !== "spot" && <li>When lent out, you receive <span className="text-ink">{multiplier(dep.utilization).toFixed(2)}×</span> the fees you would have earned (at least {floorPct}% a year), after the protocol&apos;s share of the extra. It rises once more than 60% is lent.</li>}
                  <li>Withdraw any time while it&apos;s not lent out; lent-out liquidity needs {notice}h notice.</li>
                </ul>
                <label className="mt-3 block">
                  <span className="cap">Amount (USD)</span>
                  <input className="input mt-1" type="number" min={1} value={depValue} onChange={(e) => setDepValue(Math.max(0, Number(e.target.value)))} />
                </label>
                <div className="kv mt-1"><span>You add</span><span>{depTokens}</span></div>
                <button
                  className="btn btn-primary mt-3 w-full"
                  disabled={!wallet.address || busy || depLiquidity <= 0n}
                  onClick={() => run("tx/build/deposit", { bucket: dep.address, liquidity: depLiquidity.toString() }, "Deposited. Your liquidity is in the pool and earning fees.")}
                >
                  {wallet.address ? "Deposit" : "Connect a wallet to deposit"}
                </button>
              </>
            ) : (
              <p className="cap mt-2">Loading ranges…</p>
            )}
          </div>

          <div data-tour="earn-earnings" className="p-5">
            <div className="label">Your earnings</div>
            {!wallet.address ? (
              <p className="cap mt-2">Connect a wallet to see what you&apos;ve earned.</p>
            ) : !mine.length ? (
              <p className="cap mt-2">Nothing deposited in {m?.name ?? "this market"} yet.</p>
            ) : (
              <div className="mt-2">
                <div className="flex items-baseline justify-between">
                  <span className="cap">Earned so far</span>
                  <span className="num text-xl font-medium">{fmtUsd(earnedTotal, 2)}</span>
                </div>
                <div className="kv"><span>Orca fees</span><span>{fmtUsd(compare.fees, 4)}</span></div>
                <div className="kv"><span>Premium from borrowers</span><span className="!text-good">{fmtUsd(compare.premium, 4)}</span></div>
                <div className="kv"><span>Fees you missed while lent</span><span>{fmtUsd(compare.forgone, 4)}</span></div>
                <div className="kv mt-1 border-t border-line pt-2">
                  <span className="!text-ink">Extra vs plain Orca</span>
                  <span className={`font-medium ${compare.premium - compare.forgone >= 0 ? "!text-good" : "!text-bad"}`}>{compare.premium - compare.forgone >= 0 ? "+" : ""}{fmtUsd(compare.premium - compare.forgone, 4)}</span>
                </div>
                <div className="mt-3 border-t border-line pt-2">
                  <div className="cap">Ready to claim</div>
                  <div className="kv"><span>Premium</span><span>{fmtUsd(claimPremium, 4)}</span></div>
                  <div className="kv"><span>Fees in {B}</span><span>{fmtNum(claimBase, 6)}</span></div>
                  <div className="kv"><span>Fees in {Q}</span><span>{fmtUsd(claimQuote, 4)}</span></div>
                  <p className="cap mt-1">Claim per range in the table.</p>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
