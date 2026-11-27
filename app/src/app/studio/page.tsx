"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, Bar } from "@/components/AppShell";
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
      { label: "Simulate", state: "doing" },
      { label: "Certify", state: "todo" },
      { label: "Build", state: "todo" },
      { label: "Sign and send", state: "todo" },
    ];
    setSteps(plan);
    const upd = (i: number, s: Partial<Step>) => setSteps((prev) => prev.map((x, j) => (j === i ? { ...x, ...s } : x)));
    try {
      const userBase = await tokenAccount(wallet.address, WSOL);
      const userQuote = await tokenAccount(wallet.address, USDC);
      if (!userBase || !userQuote) throw new Error("No SOL/USDC token accounts. Get test funds from the wallet menu.");
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
      upd(2, { state: "done", detail: "simulated before each signature" });
      upd(3, { state: "doing", detail: "check your wallet" });
      const built = await wallet.runPlan("tx/build/open", body(final.certificate.hash), (n, sig, of) => upd(3, { detail: `${n}/${of ?? n} confirmed`, sig }));
      upd(3, { state: "done", detail: `${built.sigs.length} transaction${built.sigs.length > 1 ? "s" : ""} confirmed`, sig: built.sigs[built.sigs.length - 1] });
      setOpened(built.strategy ?? null);
    } catch (e) {
      setSteps((prev) => prev.map((x) => (x.state === "doing" ? { ...x, state: "error", detail: (e as Error).message } : x)));
      setErr((e as Error).message);
    }
  };

  const status = feas?.status;
  const certOk = cert ? (cert.liquidity_check.length ? cert.liquidity_check.every((l) => l.ok) : null) : null;
  return (
    <AppShell>
      <Bar
        title="Studio"
        meta={
          <>
            <span>{market?.name ?? "…"}</span>
            <span>Pool <span className="num text-ink">{fmtUsd(market?.poolPrice)}</span></span>
            <span>
              Ref <span className="num text-ink">{fmtUsd(market?.reference?.price)}</span>
              {market?.reference && <span className="ml-1.5">{market.reference.kind === "PythPair" ? "Pyth" : "scenario"} · {ago(market.reference.ageSeconds)}</span>}
            </span>
            {(market?.borrowPaused || market?.opensPaused) && <span className="text-warn">{market.opensPaused ? "Opens paused" : "Borrowing paused"}</span>}
          </>
        }
      >
        <div className="seg">
          {Object.entries(PRESETS).map(([k, v]) => (
            <button
              key={k}
              title={v.hint}
              aria-pressed={preset === k}
              onClick={() => {
                setPreset(k);
                if (spot) setPoints(v.make(baseHoldings, spot));
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </Bar>
      {loadErr && !market && <div className="border-b border-line px-5 py-3 text-sm text-bad">Indexer unreachable: {loadErr}</div>}

      <div className="grid xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* chart */}
        <section className="min-w-0 border-line xl:border-r">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 pt-4 sm:px-5">
            <div>
              <div className="label">Payoff at close</div>
              <div className="cap">Drag · double-click to add · Delete to remove</div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
              <span className="flex items-center gap-1.5"><span className="h-[2px] w-4 bg-accent" /> Target</span>
              <span className="flex items-center gap-1.5"><span className="h-px w-4 bg-ink" /> Compiled</span>
              <span className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-ink-3" /> Hold {fmtNum(baseHoldings, 1)} SOL</span>
              {status === "infeasible" && <span className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-warn" /> Closest</span>}
            </div>
          </div>
          <div className="px-2 pb-3 pt-2 sm:px-3">
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
              <div className="grid h-80 place-items-center text-sm text-ink-3">Loading market…</div>
            )}
          </div>
        </section>

        {/* statistics column */}
        <aside className="divide-y divide-line border-t border-line text-sm xl:border-t-0">
          <div className="p-5">
            <div className="label">Limits</div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                ["SOL held", baseHoldings, 0.5, setBaseHoldings],
                ["USDC held", quoteHoldings, 50, setQuoteHoldings],
                ["Max premium", budget, 1, setBudget],
              ].map(([k, v, step, set]) => (
                <label key={k as string} className="block">
                  <span className="cap">{k as string}</span>
                  <input className="input mt-1" type="number" min={0} step={step as number} value={v as number} onChange={(e) => (set as (n: number) => void)(Math.max(0, Number(e.target.value)))} />
                </label>
              ))}
            </div>
            {walletBal && (
              <div className="kv mt-2"><span>Wallet</span><span>{fmtNum(walletBal.sol, 3)} SOL · {fmtNum(walletBal.usdc, 2)} USDC</span></div>
            )}
            <div className="mt-3 border-t border-line pt-3">
              <div className="kv">
                <span className="flex items-center gap-2">
                  <span className={`size-1.5 ${status === "ok" ? "bg-good" : status === "infeasible" ? "bg-warn" : "bg-ink-3"}`} />
                  <span className={status === "ok" ? "text-good" : status === "infeasible" ? "text-warn" : ""}>{status === "ok" ? "Feasible" : status === "infeasible" ? "Not feasible" : feas ? "Checking" : "—"}</span>
                </span>
                <span>{feas && Number.isFinite(feas.sampled_max_error) ? `${fmtUsd(feas.sampled_max_error)} / ${fmtUsd(feas.tolerance)}` : ""}</span>
              </div>
              {status !== "ok" && feas?.reasons?.length ? <ul className="mt-1 space-y-0.5 text-[12px] text-ink-2">{feas.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            </div>
            <button className="btn btn-primary mt-3 w-full" disabled={!points || busy || !market} onClick={compile}>
              {busy ? "Compiling…" : "Compile"}
            </button>
            {err && <p className="mt-2 text-[12px] text-bad">{err}</p>}
          </div>

          <div className="p-5">
            <div className="label">Cost</div>
            {c ? (
              <div className="mt-2">
                <div className="kv"><span>Capital locked</span><span>{fmtUsd(c.capital_locked)}</span></div>
                <div className="kv"><span>Buffers</span><span>{fmtUsd(c.buffer_quote + c.buffer_base * c.spot)}</span></div>
                <div className="kv"><span>LP escrow</span><span>{fmtUsd(c.escrow_quote + c.escrow_base * c.spot)}</span></div>
                <div className="kv"><span>Max premium</span><span>{fmtUsd(budget)}</span></div>
                <div className="kv"><span>Min premium</span><span>{borrowedLegs.length ? `${fmtUsd(floorPerDay)}/day` : "—"}</span></div>
                {isCollar && <p className="mt-2 text-[12px] text-ink-2">Covered-call fees are netted against the put premium at close.</p>}
              </div>
            ) : (
              <p className="cap mt-2">Compile to price it.</p>
            )}
          </div>

          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="label">Certificate</div>
              {cert && (
                <a
                  className="text-[12px] text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(cert, null, 2))}`}
                  download={`forge-certificate-${cert.hash.slice(0, 12)}.json`}
                >
                  JSON
                </a>
              )}
            </div>
            {cert ? (
              <div className="mt-2">
                <div className="flex items-baseline justify-between">
                  <span className="cap">Max error</span>
                  <span className="num text-2xl font-medium">±{fmtUsd(cert.error.certified_bound)}</span>
                </div>
                <div className="kv"><span>At</span><span>{fmtUsd(cert.error.at_price)}</span></div>
                <div className="kv"><span>Domain</span><span>{fmtUsd(cert.target.domain[0], 0)} – {fmtUsd(cert.target.domain[1], 0)}</span></div>
                <div className="kv"><span>Liquidity</span><span className={certOk === false ? "!text-bad" : ""}>{certOk == null ? "—" : certOk ? "available" : "insufficient"}</span></div>
                <div className="kv"><span>Simulation</span><span>{cert.simulation ? `${(cert.simulation.compute_units as number[]).map((x) => x.toLocaleString()).join(" + ")} CU` : "at open"}</span></div>
                <div className="kv"><span>Hash</span><span className="truncate pl-6">{cert.hash.slice(0, 20)}…</span></div>
                <p className="cap mt-2" title={cert.disclaimer}>Excludes premium, fees and settlement swap costs.</p>
              </div>
            ) : (
              <p className="cap mt-2">Issued on compile.</p>
            )}
          </div>

          {c && (
            <div className="p-5">
              <div className="label">Execute</div>
              {!wallet.address ? (
                <p className="cap mt-2">Connect a wallet to open.</p>
              ) : (
                <button className="btn btn-primary mt-3 w-full" disabled={compiled?.result.status !== "ok" || steps.some((s) => s.state === "doing")} onClick={open}>
                  Open position
                </button>
              )}
              {compiled?.result.status !== "ok" && <p className="mt-2 text-[12px] text-warn">Outside tolerance. Adjust the payoff or limits.</p>}
              {steps.length > 0 && (
                <ol className="mt-3">
                  {steps.map((s, i) => (
                    <li key={i} className="flex gap-3 border-t border-line py-2 first:border-t-0">
                      <span className={`num w-5 shrink-0 text-[12px] ${s.state === "done" ? "text-good" : s.state === "error" ? "text-bad" : s.state === "doing" ? "animate-pulse text-ink" : "text-ink-3"}`}>{String(i + 1).padStart(2, "0")}</span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-[13px] ${s.state === "todo" ? "text-ink-3" : ""}`}>{s.label}</div>
                        {s.detail && <div className={`num truncate text-[11px] ${s.state === "error" ? "text-bad" : "text-ink-3"}`}>{s.detail}</div>}
                        {s.sig && <Link className="num text-[11px] text-ink-2 underline underline-offset-2 hover:text-ink" href={`/inspect?sig=${s.sig}`}>{short(s.sig, 6)}</Link>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {opened && <Link href={`/positions?focus=${opened}`} className="btn btn-ghost mt-3 w-full">View position</Link>}
            </div>
          )}
        </aside>
      </div>

      {/* ranges */}
      <section className="border-t border-line">
        <div className="flex items-center justify-between px-4 py-3 sm:px-5">
          <div className="label">Ranges</div>
          {compiled && <span className="num text-[12px] text-ink-3">solved {(compiled.result.solve_seconds * 1000).toFixed(0)} ms</span>}
        </div>
        {legRows.length ? (
          <div className="overflow-x-auto border-t border-line">
            <table className="tbl min-w-[640px]">
              <thead>
                <tr>{["Leg", "Range", "Liquidity", "Notional", "Funding", "m(u)"].map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {legRows.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <span className="flex items-center gap-2">
                        <span className={`h-2.5 w-[3px] ${l.kind.startsWith("borrow") ? "bg-accent" : "bg-steel"}`} />
                        {KIND_LABEL[kindTag(l.kind)]}
                      </span>
                    </td>
                    <td className="num">{fmtUsd(l.price_lower)} – {fmtUsd(l.price_upper)}</td>
                    <td className="num text-ink-2">{l.liquidity_onchain.toExponential(3)}</td>
                    <td className="num">{fmtUsd(l.notional)}</td>
                    <td className="text-ink-2">{l.kind.startsWith("borrow") ? "LP escrow" : l.kind === "provide_call" ? "Your SOL" : "Your USDC"}</td>
                    <td className="num">{l.mult ? `${l.mult.toFixed(2)}×` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cap px-5 pb-4">Compile to see the ranges.</p>
        )}
      </section>
    </AppShell>
  );
}
