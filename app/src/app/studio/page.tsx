"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { PayoffChart } from "@/components/studio/PayoffChart";
import { api, type BucketInfo, type BuiltTx, type CompileResponse, type Feasibility, type MarketInfo } from "@/lib/api";
import { USDC, WSOL } from "@/lib/config";
import { ago, fmtNum, fmtUsd, short } from "@/lib/format";
import { KIND_LABEL, kindTag, type Point, PRESETS } from "@/lib/payoff";
import { tokenAccount, tokenBalance } from "@/lib/rpc";
import { useWallet } from "@/lib/wallet";

const KIND_NAME: Record<string, string> = { borrow_put: "BorrowQuote", borrow_call: "BorrowBase", provide_put: "ProvideQuote", provide_call: "ProvideBase" };

type Step = { label: string; state: "todo" | "doing" | "done" | "error"; detail?: string; sig?: string };

export default function Studio() {
  const wallet = useWallet();
  const [market, setMarket] = useState<MarketInfo | null>(null);
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [preset, setPreset] = useState("collar");
  const [points, setPoints] = useState<Point[] | null>(null);
  const [baseHoldings, setBaseHoldings] = useState(10);
  const [quoteHoldings, setQuoteHoldings] = useState(2000);
  const [budget, setBudget] = useState(20);
  const [feas, setFeas] = useState<Feasibility | null>(null);
  const [compiled, setCompiled] = useState<CompileResponse | null>(null);
  const [curve, setCurve] = useState<Point[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scenario, setScenario] = useState(0);
  const [steps, setSteps] = useState<Step[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [walletBal, setWalletBal] = useState<{ sol: number; usdc: number } | null>(null);

  // market + buckets
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const ms = await api<MarketInfo[]>("indexer/markets");
        if (!alive || !ms[0]) return;
        setMarket(ms[0]);
        setBuckets(await api<BucketInfo[]>(`indexer/markets/${ms[0].address}/buckets`));
        setLoadErr(null);
      } catch (e) {
        if (alive) setLoadErr((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const spot = market?.poolPrice ?? null;
  useEffect(() => {
    if (!spot || points) return;
    setPoints(PRESETS[preset]!.make(baseHoldings, spot));
    setScenario(spot * 0.92);
  }, [spot, points, preset, baseHoldings]);

  useEffect(() => {
    if (!wallet.address) return setWalletBal(null);
    const addr = wallet.address;
    const read = () => void Promise.all([tokenBalance(addr, WSOL), tokenBalance(addr, USDC)]).then(([sol, usdc]) => setWalletBal({ sol, usdc })).catch(() => setWalletBal(null));
    read();
    const t = setInterval(read, 8_000);
    return () => clearInterval(t);
  }, [wallet.address, opened]);

  const request = useCallback(
    (pts: Point[], extra: Record<string, unknown> = {}) => {
      if (!market) return null;
      const borrowable: Record<string, string> = {};
      for (const b of buckets) borrowable[String(b.tickLower)] = b.borrowable;
      return {
        payoff: pts,
        spot: market.poolPrice,
        tick_spacing: market.tickSpacing,
        bucket_multiplier: market.bucketWidth / market.tickSpacing,
        n_each_side: Math.min(12, Math.ceil(buckets.length / 2) + 2),
        borrowable,
        limits: { base_holdings: baseHoldings, quote_holdings: quoteHoldings, premium_budget: budget, max_legs: market.params.max_buckets_per_strategy },
        market: { whirlpool: market.whirlpool, base_decimals: market.baseDecimals, quote_decimals: market.quoteDecimals },
        ...extra,
      };
    },
    [market, buckets, baseHoldings, quoteHoldings, budget],
  );

  // a compilation is only invalidated by the user's own edits, not by data refreshes
  useEffect(() => {
    setCompiled(null);
    setCurve(null);
    setSteps([]);
  }, [points, baseHoldings, quoteHoldings, budget]);

  // live feasibility while drawing (debounced); re-checked when market data refreshes
  const seq = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const ready = Boolean(market);
  useEffect(() => {
    if (!points || !ready) return;
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const f = await api<Feasibility>("compiler/feasibility", requestRef.current(points));
        if (id === seq.current) setFeas(f);
      } catch (e) {
        if (id === seq.current) setFeas({ status: "invalid", reasons: [(e as Error).message], sampled_max_error: NaN, tolerance: NaN, legs: 0, closest_feasible: null });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [points, ready, baseHoldings, quoteHoldings, budget]);

  const compile = async () => {
    if (!points) return;
    setBusy(true);
    setErr(null);
    setOpened(null);
    setSteps([]);
    try {
      const r = await api<CompileResponse>("compiler/compile", request(points));
      setCompiled(r);
      if (r.certificate) {
        const [lo, hi] = [points[0]![0], points[points.length - 1]![0]];
        const prices = Array.from({ length: 200 }, (_, i) => lo + ((hi - lo) * i) / 199);
        const ev = await api<{ fhat: number[] }>("compiler/evaluate", { certificate: r.certificate, prices });
        setCurve(prices.map((s, i) => [s, ev.fhat[i]!] as Point));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const legs = compiled?.result.construction?.legs ?? [];
  const borrowedLegs = legs.filter((l) => l.kind.startsWith("borrow"));
  const isCollar = legs.some((l) => l.kind === "borrow_put") && legs.some((l) => l.kind === "provide_call");
  const scale = market ? 10 ** (-(market.baseDecimals + market.quoteDecimals) / 2) : 0;

  const legRows = useMemo(() => {
    if (!market) return [];
    return legs.map((l) => {
      const b = buckets.find((x) => x.tickLower === l.tick_lower);
      const L = l.liquidity_onchain;
      let mult: number | null = null;
      if (l.kind.startsWith("borrow") && b && BigInt(b.totalLiquidity) > 0n) {
        const u = Math.min(0.8, (Number(BigInt(b.borrowed) + BigInt(b.reserved)) + L) / Number(BigInt(b.totalLiquidity)));
        const c = market.params.curve;
        mult = u <= c.kink_ppm / 1e6 ? 1 + (c.slope1_ppm / 1e6) * u : 1 + (c.slope1_ppm / 1e6) * (c.kink_ppm / 1e6) + (c.slope2_ppm / 1e6) * (u - c.kink_ppm / 1e6);
      }
      const ra = Math.sqrt(l.price_lower), rb = Math.sqrt(l.price_upper);
      const notional = l.kind.endsWith("put") ? L * scale * (rb - ra) : L * scale * (1 / ra - 1 / rb) * market.poolPrice;
      return { ...l, mult, notional };
    });
  }, [legs, buckets, market, scale]);

  const floorPerDay = market ? legRows.filter((l) => l.kind.startsWith("borrow")).reduce((a, l) => a + l.notional, 0) * (market.params.floor_rate_bps / 1e4) / 365 : 0;
  const cert = compiled?.certificate ?? null;
  const c = compiled?.result.construction;

  const open = async () => {
    if (!compiled?.result.construction || !market || !points || !wallet.address) return;
    setErr(null);
    setOpened(null);
    const plan: Step[] = [
      { label: "Simulate the open transaction on the fork", state: "doing" },
      { label: "Certify (simulation recorded) and store the certificate", state: "todo" },
      { label: "Build the transaction with the certificate hash", state: "todo" },
      { label: "Sign and execute", state: "todo" },
    ];
    setSteps(plan);
    const upd = (i: number, s: Partial<Step>) => setSteps((prev) => prev.map((x, j) => (j === i ? { ...x, ...s } : x)));
    try {
      const userBase = await tokenAccount(wallet.address, WSOL);
      const userQuote = await tokenAccount(wallet.address, USDC);
      if (!userBase || !userQuote) throw new Error("Your wallet needs SOL (wrapped) and USDC token accounts. Use “Get fork test funds” in the wallet menu.");
      const nonce = String(Date.now());
      const body = (hash: string) => ({
        owner: wallet.address,
        market: market.address,
        nonce,
        legs: compiled.result.construction!.legs.map((l) => ({ kind: KIND_NAME[l.kind], tickLower: l.tick_lower, liquidity: String(Math.round(l.liquidity_onchain)) })),
        premiumBudget: String(Math.round(budget * 10 ** market.quoteDecimals)),
        openReferencePrice: market.reference?.price ?? market.poolPrice,
        openToleranceBps: market.params.open_tolerance_bps,
        swapSlippageBps: market.params.swap_slippage_bps,
        certificateHash: hash,
        userBase,
        userQuote,
      });
      // simulate the first transaction of the plan (begin, or the whole open if it fits)
      const sim = await api<{ transactions: BuiltTx[]; steps: number }>("tx/build/open", { ...body("00".repeat(32)), nonce: String(Date.now() + 1) });
      const simulation = { ok: true, transactions: sim.steps, compute_units: sim.transactions.map((t) => t.computeUnits), bytes: sim.transactions.map((t) => t.bytes) };
      upd(0, { state: "done", detail: `${sim.steps} tx plan · first ${sim.transactions[0]!.computeUnits.toLocaleString()} CU` });
      upd(1, { state: "doing" });
      const final = await api<CompileResponse>("compiler/compile", request(points, { simulation }));
      if (!final.certificate) throw new Error("Certification failed.");
      await api("compiler/certificates", final.certificate);
      setCompiled(final);
      upd(1, { state: "done", detail: `hash ${final.certificate.hash.slice(0, 16)}…` });
      upd(2, { state: "done", detail: "each transaction is built and simulated just before you sign it" });
      upd(3, { state: "doing", detail: "Check the transaction in your wallet" });
      const built = await wallet.runPlan("tx/build/open", body(final.certificate.hash), (n, sig, of) => upd(3, { detail: `${n}/${of ?? n} confirmed`, sig }));
      upd(3, { state: "done", detail: `${built.sigs.length} transaction${built.sigs.length > 1 ? "s" : ""} confirmed`, sig: built.sigs[built.sigs.length - 1] });
      setOpened(built.strategy ?? null);
    } catch (e) {
      setSteps((prev) => prev.map((x) => (x.state === "doing" ? { ...x, state: "error", detail: (e as Error).message } : x)));
      setErr((e as Error).message);
    }
  };

  const status = feas?.status;
  return (
    <AppShell>
      {loadErr && !market && (
        <div className="card mb-4 border-bad/40 p-4 text-sm text-bad">Could not reach the fork indexer: {loadErr}</div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* left: editor */}
        <div className="space-y-5">
          <div className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="label">Design</div>
                <h1 className="font-display text-xl font-semibold">Draw the payoff you want at close</h1>
              </div>
              <div className="ml-auto flex flex-wrap gap-1.5">
                {Object.entries(PRESETS).map(([k, v]) => (
                  <button
                    key={k}
                    title={v.hint}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${preset === k ? "border-ember bg-ember-soft text-ember" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"}`}
                    onClick={() => {
                      setPreset(k);
                      if (spot) setPoints(v.make(baseHoldings, spot));
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4">
              {points && market ? (
                <PayoffChart
                  points={points}
                  onChange={setPoints}
                  compiled={curve}
                  closest={status === "infeasible" && feas?.closest_feasible ? (feas.closest_feasible as Point[]) : null}
                  unhedgedUnits={baseHoldings}
                  spot={spot}
                  buckets={buckets}
                  chosen={legs.map((l) => ({ kind: l.kind, priceLower: l.price_lower, priceUpper: l.price_upper }))}
                  scenario={scenario}
                  onScenario={setScenario}
                  liquidityScale={scale}
                />
              ) : (
                <div className="grid h-80 place-items-center text-sm text-ink-3">Loading the market…</div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-3">
              <span className="flex items-center gap-1.5"><span className="h-[3px] w-5 rounded bg-ember" /> target</span>
              <span className="flex items-center gap-1.5"><span className="h-[2px] w-5 rounded bg-ink" /> compiled</span>
              <span className="flex items-center gap-1.5"><span className="h-0 w-5 border-t border-dashed border-ink-3" /> just holding {fmtNum(baseHoldings, 1)} SOL</span>
              {status === "infeasible" && <span className="flex items-center gap-1.5"><span className="h-0 w-5 border-t-2 border-dashed border-warn" /> closest feasible</span>}
              <span className="ml-auto">Drag points · double-click to add · select and press Delete to remove</span>
            </div>
          </div>

          {/* legs */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <div className="label">Liquidity ranges used</div>
              {compiled && <span className="num text-xs text-ink-3">solved in {(compiled.result.solve_seconds * 1000).toFixed(0)} ms</span>}
            </div>
            {legRows.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="text-left text-xs text-ink-3">
                    <tr className="border-b border-line">
                      {["Leg", "Range", "Liquidity", "Notional", "Funding", "m(u)"].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {legRows.map((l, i) => (
                      <tr key={i} className="border-b border-line/60 last:border-0">
                        <td className="px-5 py-2.5">
                          <span className={`pill ${l.kind.startsWith("borrow") ? "border-ember/40 bg-ember-soft text-ember" : "border-steel/40 bg-steel-soft text-steel"}`}>{KIND_LABEL[kindTag(l.kind)]}</span>
                        </td>
                        <td className="num px-5 py-2.5">{fmtUsd(l.price_lower)} – {fmtUsd(l.price_upper)}</td>
                        <td className="num px-5 py-2.5 text-ink-2">{l.liquidity_onchain.toExponential(3)}</td>
                        <td className="num px-5 py-2.5">{fmtUsd(l.notional)}</td>
                        <td className="px-5 py-2.5 text-ink-2">{l.kind.startsWith("borrow") ? "borrowed from LPs, escrowed" : l.kind === "provide_call" ? "your SOL" : "your USDC"}</td>
                        <td className="num px-5 py-2.5">{l.mult ? `${l.mult.toFixed(2)}×` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-ink-3">Compile to see which ranges FORGE borrows or provides.</p>
            )}
          </div>
        </div>

        {/* right: market, inputs, results */}
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div className="label">Market</div>
              <span className="pill border-line text-ink-2">{market?.name ?? "…"}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-ink-3">Pool price</div>
                <div className="num text-lg font-semibold">{fmtUsd(market?.poolPrice)}</div>
              </div>
              <div>
                <div className="text-xs text-ink-3">Reference</div>
                <div className="num text-lg font-semibold">{fmtUsd(market?.reference?.price)}</div>
                <div className="text-[11px] text-ink-3">{market?.reference ? `${market.reference.kind === "PythPair" ? "Pyth pair" : "fork scenario"} · ${ago(market.reference.ageSeconds)}` : ""}</div>
              </div>
            </div>
            {(market?.borrowPaused || market?.opensPaused) && (
              <p className="mt-3 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">{market.opensPaused ? "New opens are paused." : "New borrowing is paused pending review of a recorded shortfall."}</p>
            )}
          </div>

          <div className="card p-5">
            <div className="label">Your constraints</div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs text-ink-3">SOL held</span>
                <input className="input mt-1" type="number" min={0} step={0.5} value={baseHoldings} onChange={(e) => setBaseHoldings(Math.max(0, Number(e.target.value)))} />
              </label>
              <label className="block">
                <span className="text-xs text-ink-3">USDC held</span>
                <input className="input mt-1" type="number" min={0} step={50} value={quoteHoldings} onChange={(e) => setQuoteHoldings(Math.max(0, Number(e.target.value)))} />
              </label>
              <label className="block">
                <span className="text-xs text-ink-3">Max premium</span>
                <input className="input mt-1" type="number" min={1} step={1} value={budget} onChange={(e) => setBudget(Math.max(0, Number(e.target.value)))} />
              </label>
            </div>
            {walletBal && (
              <p className="mt-2 text-[11px] text-ink-3">
                Wallet: <span className="num">{fmtNum(walletBal.sol, 3)}</span> wrapped SOL · <span className="num">{fmtNum(walletBal.usdc, 2)}</span> USDC
              </p>
            )}

            <div className={`mt-4 rounded-lg border px-3 py-2.5 text-sm ${status === "ok" ? "border-good/40 bg-good-soft" : status === "infeasible" ? "border-warn/40 bg-warn-soft" : "border-line bg-sunk"}`}>
              <div className="flex items-center gap-2 font-medium">
                <span className={`size-2 rounded-full ${status === "ok" ? "bg-good" : status === "infeasible" ? "bg-warn" : "bg-ink-3"}`} />
                {status === "ok" ? "Feasible" : status === "infeasible" ? "Not feasible as drawn" : feas ? "Checking…" : "Draw to check feasibility"}
                {feas && Number.isFinite(feas.sampled_max_error) && (
                  <span className="num ml-auto text-xs text-ink-2">err {fmtUsd(feas.sampled_max_error)} / tol {fmtUsd(feas.tolerance)}</span>
                )}
              </div>
              {status !== "ok" && feas?.reasons?.length ? (
                <ul className="mt-1.5 space-y-1 text-xs text-ink-2">{feas.reasons.map((r) => <li key={r}>· {r}</li>)}</ul>
              ) : null}
            </div>
            <button className="btn btn-primary mt-4 w-full" disabled={!points || busy || !market} onClick={compile}>
              {busy ? "Compiling…" : "Compile and certify"}
            </button>
            {err && <p className="mt-2 text-xs text-bad">{err}</p>}
          </div>

          {c && (
            <div className="card p-5">
              <div className="label">Collateral and premium</div>
              <dl className="mt-3 space-y-2 text-sm">
                {[
                  ["Your capital locked", fmtUsd(c.capital_locked), "cash, SOL, provided ranges and buffers, at spot"],
                  ["Restoration buffers", fmtUsd(c.buffer_quote + c.buffer_base * c.spot), "locked separately, returned unless used"],
                  ["Escrow from LPs", fmtUsd(c.escrow_quote + c.escrow_base * c.spot), "removed from borrowed ranges"],
                  ["Max premium (budget)", fmtUsd(budget), `1% keeper bounty reserve · LPs paid at most ${fmtUsd(budget * 0.99)}`],
                  ["Time-floor premium", borrowedLegs.length ? `${fmtUsd(floorPerDay)}/day` : "—", "the minimum; fee-driven premium can be higher"],
                ].map(([k, v, s]) => (
                  <div key={k} className="flex items-start justify-between gap-3">
                    <dt>
                      <div className="text-ink-2">{k}</div>
                      <div className="text-[11px] text-ink-3">{s}</div>
                    </dt>
                    <dd className="num shrink-0 font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              {isCollar && (
                <div className="mt-4 rounded-lg border border-steel/30 bg-steel-soft px-3 py-2.5 text-xs leading-relaxed text-ink">
                  <span className="font-semibold">Your upside cap pays for your downside protection.</span> Fees your covered-call range actually
                  collects are credited at close and netted against the put premium. Only collected fees count; the full budget is still locked,
                  and the offset can be all, part or none of the premium.
                </div>
              )}
            </div>
          )}

          {cert && (
            <div className="card p-5">
              <div className="flex items-center justify-between">
                <div className="label">Replication certificate</div>
                <a
                  className="text-xs font-medium text-ember hover:underline"
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(cert, null, 2))}`}
                  download={`forge-certificate-${cert.hash.slice(0, 12)}.json`}
                >
                  Download JSON
                </a>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="num text-3xl font-semibold">±{fmtUsd(cert.error.certified_bound)}</span>
                <span className="text-xs text-ink-3">certified max gross error</span>
              </div>
              <p className="mt-1 text-xs text-ink-3">
                exact maximum <span className="num">{fmtUsd(cert.error.max_gross_error, 4)}</span> at <span className="num">{fmtUsd(cert.error.at_price)}</span> + Orca rounding allowance <span className="num">{fmtUsd(cert.error.rounding_bound, 6)}</span>
              </p>
              <div className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-ink-3">Domain</span><span className="num">{fmtUsd(cert.target.domain[0], 0)} – {fmtUsd(cert.target.domain[1], 0)}</span></div>
                <div className="flex justify-between"><span className="text-ink-3">Liquidity check</span><span className={cert.liquidity_check.every((l) => l.ok) ? "text-good" : "text-bad"}>{cert.liquidity_check.length ? (cert.liquidity_check.every((l) => l.ok) ? `${cert.liquidity_check.length}/${cert.liquidity_check.length} ranges available` : "insufficient borrowable liquidity") : "no borrowed ranges"}</span></div>
                <div className="flex justify-between"><span className="text-ink-3">Fork simulation</span><span className="num">{cert.simulation ? `ok · ${(cert.simulation.compute_units as number[]).map((x) => x.toLocaleString()).join(" + ")} CU` : "recorded when you open"}</span></div>
                <div className="flex justify-between gap-3"><span className="text-ink-3">Hash</span><span className="num truncate">{cert.hash}</span></div>
              </div>
              <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-3">{cert.disclaimer}</p>
            </div>
          )}

          {c && (
            <div className="card p-5">
              <div className="label">Execute</div>
              {!wallet.address ? (
                <p className="mt-2 text-sm text-ink-2">Connect a wallet (or the demo wallet) to open this position on the fork.</p>
              ) : (
                <button className="btn btn-primary mt-3 w-full" disabled={compiled?.result.status !== "ok" || steps.some((s) => s.state === "doing")} onClick={open}>
                  Open position
                </button>
              )}
              {compiled?.result.status !== "ok" && <p className="mt-2 text-xs text-warn">This construction is outside the tolerance; adjust the payoff or your constraints.</p>}
              {steps.length > 0 && (
                <ol className="mt-4 space-y-2.5">
                  {steps.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-sm">
                      <span className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold ${s.state === "done" ? "bg-good text-bg" : s.state === "error" ? "bg-bad text-bg" : s.state === "doing" ? "animate-pulse bg-ember" : "bg-line"}`}>{s.state === "done" ? "✓" : s.state === "error" ? "!" : ""}</span>
                      <div className="min-w-0">
                        <div className={s.state === "todo" ? "text-ink-3" : ""}>{s.label}</div>
                        {s.detail && <div className={`num truncate text-[11px] ${s.state === "error" ? "text-bad" : "text-ink-3"}`}>{s.detail}</div>}
                        {s.sig && <Link className="num text-[11px] text-ember hover:underline" href={`/inspect?sig=${s.sig}`}>inspect {short(s.sig, 6)}</Link>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {opened && (
                <Link href={`/positions?focus=${opened}`} className="btn btn-ghost mt-4 w-full">View position →</Link>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
