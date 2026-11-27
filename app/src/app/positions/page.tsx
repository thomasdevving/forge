"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppShell, Bar } from "@/components/AppShell";
import { api, type BuiltTx, type MarketInfo, type StrategyView } from "@/lib/api";
import { atoms, fmtNum, fmtPct, fmtPrice, fmtUsd, short } from "@/lib/format";
import { greeks, KIND_LABEL, legPayoff } from "@/lib/payoff";
import { tokenAccount } from "@/lib/rpc";
import { baseSymbol, quoteSymbol } from "@/lib/market";
import { useWallet } from "@/lib/wallet";

const STATE_STYLE: Record<string, string> = {
  PendingOpen: "!border-warn/50 !text-warn",
  Open: "!border-good/50 !text-good",
  PendingClose: "!border-warn/50 !text-warn",
  Recovery: "!border-bad/50 !text-bad",
  Closed: "",
  Cancelled: "!text-ink-3",
};
const STATE_NOTE: Record<string, string> = {
  PendingOpen: "Opening.",
  PendingClose: "Closing.",
  Recovery: "Restoration blocked. Escrow stays locked; top up or retry.",
};

function PositionCard({ s, m, onAction, busy, tour }: { s: StrategyView; m: MarketInfo; onAction: (kind: "close" | "abort", s: StrategyView) => void; busy: boolean; tour?: boolean }) {
  const t = (id: string) => (tour ? id : undefined); // walkthrough anchors, on one card only
  const bd = m.baseDecimals, qd = m.quoteDecimals;
  const P = m.poolPrice;
  const legs = s.legs.map((l) => ({ kind: l.kind_tag, tickLower: l.tick_lower, tickUpper: l.tick_upper, liquidity: Number(BigInt(l.liquidity)) }));
  const g = greeks(legs, P, bd, qd);
  const accrued = atoms(s.state === "Closed" ? s.premium_paid : s.accruedEstimate, qd);
  const cap = atoms(s.lpCap, qd);
  const trigger = s.keeper_trigger_bps / 1e4;
  const providedFunding = s.legs.reduce((a, l) => a + atoms(l.provided_quote, qd) + atoms(l.provided_base, bd) * P, 0);
  const pnl = g.value - providedFunding - accrued;
  const executed = s.legs.filter((l) => l.executed).length;
  const pendingClose = s.legs.filter((l) => l.executed && !l.restored).length;

  // settlement record (chain data) for designed vs realized
  const settleP = Number(BigInt(s.settlement_reference_x64)) / 2 ** 64 * 10 ** (bd - qd);
  const closed = s.state === "Closed" && settleP > 0;
  const designed = closed ? legs.reduce((a, l) => a + legPayoff(l.kind, l.tickLower, l.tickUpper, l.liquidity, settleP, bd, qd), 0) : 0;
  const buffers = s.legs.reduce((a, l) => a + (l.kind_tag === 0 ? atoms(l.buffer, qd) : l.kind_tag === 1 ? atoms(l.buffer, bd) * settleP : 0), 0);
  const feeCredits = atoms(s.fee_credit_quote, qd) + atoms(s.fee_credit_base, bd) * settleP;
  const realized = atoms(s.payout_quote, qd) + atoms(s.payout_base, bd) * settleP - buffers - feeCredits;
  const premiumPaid = atoms(s.premium_paid, qd) + atoms(s.keeper_bounty_paid, qd);

  return (
    <article id={s.address} className="scroll-mt-4 border-b border-line last:border-b-0">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <span className={`tag ${STATE_STYLE[s.state]}`}>{s.state.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
        <span className="num text-[12px] text-ink-2">{m.name}</span>
        <span className="text-[13px] font-medium">{s.legs.map((l) => KIND_LABEL[l.kind_tag]).join(" + ")}</span>
        <span className="num text-xs text-ink-3">{short(s.address, 6)}</span>
        <div className="ml-auto flex items-center gap-2">
          {s.certificate_hash && !/^0+$/.test(s.certificate_hash) && (
            <a className="num text-[12px] text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink" href={`/api/compiler/certificates/${s.certificate_hash}`} target="_blank" rel="noreferrer">certificate {s.certificate_hash.slice(0, 10)}…</a>
          )}
          {(s.state === "Open" || s.state === "PendingClose" || s.state === "Recovery") && (
            <button data-tour={t("pos-close")} className="btn btn-primary !py-1.5" disabled={busy} onClick={() => onAction("close", s)}>
              {s.state === "Open" ? "Close" : "Continue close"}
            </button>
          )}
          {s.state === "PendingOpen" && (
            <button className="btn btn-ghost !py-1.5" disabled={busy} onClick={() => onAction("abort", s)}>Cancel</button>
          )}
        </div>
      </header>
      {STATE_NOTE[s.state] && <p className="border-b border-line bg-sunk px-4 py-2 text-[12px] text-ink-2 sm:px-5">{STATE_NOTE[s.state]} {s.state === "PendingOpen" ? `${executed}/${s.legs.length} legs done.` : s.state !== "Recovery" ? `${pendingClose} left.` : ""}</p>}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
        <div data-tour={t("pos-legs")} className="overflow-x-auto">
          <table className="tbl min-w-[620px]">
            <thead>
              <tr>{["Leg", "Range", "Escrow", "Buffer", "Premium", "Status"].map((h) => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody className="num">
              {s.legs.map((l, i) => {
                const pa = 1.0001 ** l.tick_lower * 10 ** (bd - qd), pb = 1.0001 ** l.tick_upper * 10 ** (bd - qd);
                const esc = l.kind_tag <= 1 ? `${fmtNum(atoms(l.escrow_quote, qd), 2)} ${quoteSymbol(m)}${BigInt(l.escrow_base) > 0n ? ` · ${fmtNum(atoms(l.escrow_base, bd), 4)} ${baseSymbol(m)}` : ""}` : l.kind_tag === 2 ? `${fmtNum(atoms(l.provided_quote, qd), 2)} ${quoteSymbol(m)}` : `${fmtNum(atoms(l.provided_base, bd), 4)} ${baseSymbol(m)}`;
                return (
                  <tr key={i}>
                    <td className="font-sans"><span className="flex items-center gap-2"><span className={`h-2.5 w-[3px] ${l.kind_tag <= 1 ? "bg-accent" : "bg-steel"}`} />{KIND_LABEL[l.kind_tag]}</span></td>
                    <td>{fmtPrice(pa)}–{fmtPrice(pb)}</td>
                    <td className="text-ink-2">{esc}</td>
                    <td className="text-ink-2">{l.kind_tag <= 1 ? fmtNum(atoms(l.buffer, l.kind_tag === 0 ? qd : bd), l.kind_tag === 0 ? 2 : 4) : "—"}</td>
                    <td>{l.kind_tag <= 1 ? fmtUsd(atoms(l.restored ? l.premium : l.estimate.premium, qd), 4) : "—"}</td>
                    <td className="font-sans text-ink-2">{l.restored ? (l.kind_tag <= 1 ? "restored" : "unwound") : l.executed ? (l.kind_tag <= 1 ? "borrowed" : "in pool") : "pending"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="space-y-4 border-t border-line p-4 sm:p-5 lg:border-l lg:border-t-0">
          {!closed ? (
            <>
              <div data-tour={t("pos-premium")}>
                <div className="kv"><span>Premium / cap</span><span>{fmtUsd(accrued, 4)} / {fmtUsd(cap, 2)}</span></div>
                <div className="relative mt-1.5 h-1.5 overflow-hidden bg-line">
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, (accrued / Math.max(cap, 1e-9)) * 100)}%` }} />
                  <div className="absolute inset-y-0 w-px bg-ink" style={{ left: `${trigger * 100}%` }} title="keeper close trigger" />
                </div>
                <div className="cap mt-1.5">Keeper close at {fmtPct(trigger, 0)}{s.cap_binding ? " · cap reached" : ""}</div>
              </div>
              <div data-tour={t("pos-greeks")} className="border-t border-line pt-3">
                <div className="kv"><span>At</span><span>{fmtPrice(P)}</span></div>
                <div className="kv"><span>Delta</span><span>{fmtNum(g.delta, 3)} {baseSymbol(m)}</span></div>
                <div className="kv"><span>Gamma</span><span>{fmtNum(g.gamma, 4)}</span></div>
                <div className="kv"><span>P&amp;L</span><span className={pnl >= 0 ? "!text-good" : "!text-bad"}>{fmtUsd(pnl)}</span></div>
              </div>
            </>
          ) : (
            <div data-tour={t("pos-result")}>
              <div className="flex items-baseline justify-between">
                <div className="label">Designed vs realized</div>
                <span className="cap num">at {fmtPrice(settleP)}</span>
              </div>
              <div className="mt-2">
                <div className="kv"><span>Designed</span><span>{fmtUsd(designed)}</span></div>
                <div className="kv"><span>Realized gross</span><span className="font-medium">{fmtUsd(realized)}</span></div>
                <div className="kv"><span>Execution cost</span><span>{fmtUsd(designed - realized, 4)}</span></div>
                <div className="kv"><span>Premium paid</span><span>−{fmtUsd(premiumPaid, 4)}</span></div>
                {feeCredits > 0 && <div className="kv"><span>Fee credits</span><span className="!text-good">+{fmtUsd(feeCredits, 4)}</span></div>}
                <div className="kv mt-1 border-t border-line pt-2"><span className="!text-ink">Realized net</span><span className="text-base font-medium">{fmtUsd(realized - premiumPaid + feeCredits)}</span></div>
              </div>
              {atoms(s.lp_shortfall, qd) > 0 && <p className="mt-2 text-[12px] text-warn">LP shortfall {fmtUsd(atoms(s.lp_shortfall, qd), 4)}</p>}
            </div>
          )}
        </aside>
      </div>
    </article>
  );
}

function PositionsInner() {
  const wallet = useWallet();
  const focus = useSearchParams().get("focus");
  const [markets, setMarkets] = useState<MarketInfo[] | null>(null);
  const [list, setList] = useState<StrategyView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);

  const load = useCallback(async () => {
    const ms = await api<MarketInfo[]>("indexer/markets");
    setMarkets(ms);
    if (wallet.address) setList(await api<StrategyView[]>(`indexer/strategies?owner=${wallet.address}`));
    else setList(null);
  }, [wallet.address]);

  useEffect(() => {
    void load().catch((e) => setMsg({ ok: false, text: (e as Error).message }));
    const t = setInterval(() => void load().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (focus && list) document.getElementById(focus)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus, list]);

  const act = async (kind: "close" | "abort", s: StrategyView) => {
    if (!wallet.address) return;
    setBusy(true);
    setMsg(null);
    try {
      const mk = markets?.find((x) => x.address === s.market);
      if (!mk) throw new Error("Unknown market for this position.");
      const userBase = await tokenAccount(wallet.address, mk.baseMint);
      const userQuote = await tokenAccount(wallet.address, mk.quoteMint);
      const body = { owner: wallet.address, market: s.market, strategy: s.address, userBase, userQuote };
      let sigs: string[];
      if (kind === "close") {
        sigs = (await wallet.runPlan("tx/build/close", body)).sigs;
      } else {
        const built = await api<{ transactions: BuiltTx[] }>("tx/build/abort", body);
        sigs = await wallet.execute(built.transactions);
      }
      setMsg({ ok: true, text: kind === "close" ? "Settled." : "Cancelled. Continue close to unwind.", sig: sigs.at(-1) });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <Bar
        title="Positions"
        meta={list && <><span>{list.length} total</span><span>{list.filter((s) => s.state === "Open").length} open</span>{markets && markets.length > 1 && <span>{new Set(list.map((s) => s.market)).size} markets</span>}</>}
      >
        <Link data-tour="pos-new" href="/studio" className="btn btn-ghost !py-1.5">New</Link>
      </Bar>
      {msg && (
        <div className={`border-b border-line px-5 py-2.5 text-[13px] ${msg.ok ? "text-good" : "text-bad"}`}>
          {msg.text} {msg.sig && <Link className="num ml-2 text-ink-2 underline underline-offset-2 hover:text-ink" href={`/inspect?sig=${msg.sig}`}>inspect</Link>}
        </div>
      )}
      {!wallet.address ? (
        <div data-tour="positions-list" className="px-5 py-16 text-center text-sm text-ink-3">Connect a wallet.</div>
      ) : !list || !markets ? (
        <div data-tour="positions-list" className="px-5 py-16 text-center text-sm text-ink-3">Loading…</div>
      ) : list.length === 0 ? (
        <div data-tour="positions-list" className="px-5 py-16 text-center text-sm text-ink-3">No positions. <Link href="/studio" className="text-ink underline underline-offset-4">Open one</Link></div>
      ) : (
        <div data-tour="positions-list" className="min-h-0 flex-1 overflow-y-auto">{list.map((s) => {
          const mk = markets.find((x) => x.address === s.market);
          const featured = (list.find((x) => x.state === "Open") ?? list[0])?.address === s.address;
          return mk ? <PositionCard key={s.address} s={s} m={mk} onAction={act} busy={busy} tour={featured} /> : null;
        })}</div>
      )}
    </AppShell>
  );
}

export default function Positions() {
  return (
    <Suspense>
      <PositionsInner />
    </Suspense>
  );
}
