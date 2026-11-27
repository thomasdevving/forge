"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api, type BuiltTx, type MarketInfo, type StrategyView } from "@/lib/api";
import { USDC, WSOL } from "@/lib/config";
import { atoms, fmtNum, fmtPct, fmtUsd, short } from "@/lib/format";
import { greeks, KIND_LABEL, legPayoff } from "@/lib/payoff";
import { tokenAccount } from "@/lib/rpc";
import { useWallet } from "@/lib/wallet";

const STATE_STYLE: Record<string, string> = {
  PendingOpen: "border-warn/40 bg-warn-soft text-warn",
  Open: "border-good/40 bg-good-soft text-good",
  PendingClose: "border-warn/40 bg-warn-soft text-warn",
  Recovery: "border-bad/40 bg-bad-soft text-bad",
  Closed: "border-line text-ink-2",
  Cancelled: "border-line text-ink-3",
};
const STATE_NOTE: Record<string, string> = {
  PendingOpen: "Opening.",
  PendingClose: "Closing.",
  Recovery: "Restoration blocked. Escrow stays locked; top up or retry.",
};

function PositionCard({ s, m, onAction, busy }: { s: StrategyView; m: MarketInfo; onAction: (kind: "close" | "abort", s: StrategyView) => void; busy: boolean }) {
  const bd = m.baseDecimals, qd = m.quoteDecimals;
  const P = m.poolPrice;
  const legs = s.legs.map((l) => ({ kind: l.kind_tag, tickLower: l.tick_lower, tickUpper: l.tick_upper, liquidity: Number(BigInt(l.liquidity)) }));
  const g = greeks(legs, P);
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
    <article id={s.address} className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <span className={`pill ${STATE_STYLE[s.state]}`}>{s.state.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
        <span className="font-display font-semibold">{s.legs.map((l) => KIND_LABEL[l.kind_tag]).join(" + ")}</span>
        <span className="num text-xs text-ink-3">{short(s.address, 6)}</span>
        <div className="ml-auto flex items-center gap-2">
          {s.certificate_hash && !/^0+$/.test(s.certificate_hash) && (
            <a className="num text-xs text-ember hover:underline" href={`/api/compiler/certificates/${s.certificate_hash}`} target="_blank" rel="noreferrer">certificate {s.certificate_hash.slice(0, 10)}…</a>
          )}
          {(s.state === "Open" || s.state === "PendingClose" || s.state === "Recovery") && (
            <button className="btn btn-primary !py-1.5" disabled={busy} onClick={() => onAction("close", s)}>
              {s.state === "Open" ? "Close" : "Continue close"}
            </button>
          )}
          {s.state === "PendingOpen" && (
            <button className="btn btn-ghost !py-1.5" disabled={busy} onClick={() => onAction("abort", s)}>Cancel</button>
          )}
        </div>
      </header>
      {STATE_NOTE[s.state] && <p className="border-b border-line bg-sunk px-5 py-2 text-xs text-ink-2">{STATE_NOTE[s.state]} {s.state === "PendingOpen" ? `${executed}/${s.legs.length} legs done.` : s.state !== "Recovery" ? `${pendingClose} left.` : ""}</p>}

      <div className="grid gap-0 lg:grid-cols-[1fr_300px]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead className="text-left text-xs text-ink-3">
              <tr className="border-b border-line">
                {["Leg", "Range", "Escrow", "Buffer", "Premium", "Status"].map((h) => <th key={h} className="px-5 py-2 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="num">
              {s.legs.map((l, i) => {
                const pa = 1.0001 ** l.tick_lower * 10 ** (bd - qd), pb = 1.0001 ** l.tick_upper * 10 ** (bd - qd);
                const esc = l.kind_tag <= 1 ? `${fmtNum(atoms(l.escrow_quote, qd), 2)} USDC${BigInt(l.escrow_base) > 0n ? ` · ${fmtNum(atoms(l.escrow_base, bd), 4)} SOL` : ""}` : l.kind_tag === 2 ? `${fmtNum(atoms(l.provided_quote, qd), 2)} USDC` : `${fmtNum(atoms(l.provided_base, bd), 4)} SOL`;
                return (
                  <tr key={i} className="border-b border-line/60 last:border-0">
                    <td className="px-5 py-2.5 font-sans">{KIND_LABEL[l.kind_tag]}</td>
                    <td className="px-5 py-2.5">{fmtUsd(pa)}–{fmtUsd(pb)}</td>
                    <td className="px-5 py-2.5 text-ink-2">{esc}</td>
                    <td className="px-5 py-2.5 text-ink-2">{l.kind_tag <= 1 ? fmtNum(atoms(l.buffer, l.kind_tag === 0 ? qd : bd), l.kind_tag === 0 ? 2 : 4) : "—"}</td>
                    <td className="px-5 py-2.5">{l.kind_tag <= 1 ? fmtUsd(atoms(l.restored ? l.premium : l.estimate.premium, qd), 4) : "—"}</td>
                    <td className="px-5 py-2.5 font-sans text-xs text-ink-2">{l.restored ? (l.kind_tag <= 1 ? "restored" : "unwound") : l.executed ? (l.kind_tag <= 1 ? "borrowed" : "in pool") : "pending"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside className="space-y-4 border-t border-line p-5 lg:border-l lg:border-t-0">
          {!closed ? (
            <>
              <div>
                <div className="flex justify-between text-xs"><span className="text-ink-3">Premium / cap</span><span className="num">{fmtUsd(accrued, 4)} / {fmtUsd(cap, 2)}</span></div>
                <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-sunk">
                  <div className="h-full rounded-full bg-ember" style={{ width: `${Math.min(100, (accrued / Math.max(cap, 1e-9)) * 100)}%` }} />
                  <div className="absolute inset-y-0 w-px bg-ink-3" style={{ left: `${trigger * 100}%` }} title="keeper close trigger" />
                </div>
                <div className="mt-1 text-[11px] text-ink-3">Keeper close at {fmtPct(trigger, 0)}{s.cap_binding ? " · cap reached" : ""}</div>
              </div>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-sunk p-2"><dt className="text-[11px] text-ink-3">Delta</dt><dd className="num text-sm font-semibold">{fmtNum(g.delta, 3)}</dd></div>
                <div className="rounded-lg bg-sunk p-2"><dt className="text-[11px] text-ink-3">Gamma</dt><dd className="num text-sm font-semibold">{fmtNum(g.gamma, 4)}</dd></div>
                <div className="rounded-lg bg-sunk p-2"><dt className="text-[11px] text-ink-3">P&amp;L</dt><dd className={`num text-sm font-semibold ${pnl >= 0 ? "text-good" : "text-bad"}`}>{fmtUsd(pnl)}</dd></div>
              </dl>
              <p className="text-[11px] text-ink-3">At {fmtUsd(P)}</p>
            </>
          ) : (
            <div>
              <div className="label">Designed vs realized</div>
              <div className="mt-1 text-[11px] text-ink-3">at {fmtUsd(settleP)}</div>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between"><dt className="text-ink-2">Designed</dt><dd className="num">{fmtUsd(designed)}</dd></div>
                <div className="flex justify-between"><dt className="text-ink-2">Realized gross</dt><dd className="num font-semibold text-ember">{fmtUsd(realized)}</dd></div>
                <div className="flex justify-between text-xs"><dt className="text-ink-3">Execution cost</dt><dd className="num">{fmtUsd(designed - realized, 4)}</dd></div>
                <div className="flex justify-between text-xs"><dt className="text-ink-3">Premium paid</dt><dd className="num">−{fmtUsd(premiumPaid, 4)}</dd></div>
                {feeCredits > 0 && <div className="flex justify-between text-xs"><dt className="text-ink-3">Fee credits</dt><dd className="num text-good">+{fmtUsd(feeCredits, 4)}</dd></div>}
                <div className="flex justify-between border-t border-line pt-1.5"><dt className="text-ink-2">Realized net</dt><dd className="num font-semibold">{fmtUsd(realized - premiumPaid + feeCredits)}</dd></div>
              </dl>
              {atoms(s.lp_shortfall, qd) > 0 && <p className="mt-2 text-xs text-warn">LP shortfall {fmtUsd(atoms(s.lp_shortfall, qd), 4)}</p>}
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
  const [m, setM] = useState<MarketInfo | null>(null);
  const [list, setList] = useState<StrategyView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);

  const load = useCallback(async () => {
    const ms = await api<MarketInfo[]>("indexer/markets");
    setM(ms[0] ?? null);
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
      const userBase = await tokenAccount(wallet.address, WSOL);
      const userQuote = await tokenAccount(wallet.address, USDC);
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
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Positions</h1>
        </div>
        <Link href="/studio" className="btn btn-ghost ml-auto">New</Link>
      </div>
      {msg && (
        <div className={`card mb-4 px-4 py-3 text-sm ${msg.ok ? "text-good" : "text-bad"}`}>
          {msg.text} {msg.sig && <Link className="num ml-2 text-ember hover:underline" href={`/inspect?sig=${msg.sig}`}>inspect</Link>}
        </div>
      )}
      {!wallet.address ? (
        <div className="card p-8 text-center text-ink-2">Connect a wallet.</div>
      ) : !list || !m ? (
        <div className="card p-8 text-center text-ink-3">Loading…</div>
      ) : list.length === 0 ? (
        <div className="card p-8 text-center text-ink-2">No positions. <Link href="/studio" className="text-ember hover:underline">Open one</Link></div>
      ) : (
        <div className="space-y-4">{list.map((s) => <PositionCard key={s.address} s={s} m={m} onAction={act} busy={busy} />)}</div>
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
