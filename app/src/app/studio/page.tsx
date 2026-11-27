"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, Bar } from "@/components/AppShell";
import { Architect, type Design } from "@/components/studio/Architect";
import { type Horizon, type Moves, PayoffChart } from "@/components/studio/PayoffChart";
import { api, type BucketInfo, type BuiltTx, type CompileResponse, type Feasibility, type MarketInfo } from "@/lib/api";
import { ago, fmtNum, fmtPrice, fmtUsd, short } from "@/lib/format";
import { KIND_LABEL, kindTag, type Point, PRESETS } from "@/lib/payoff";
import { tokenAccount, tokenBalance } from "@/lib/rpc";
import { baseSymbol, defaultUnits, MarketPicker, pickMarket, quoteSymbol, useMarketChoice } from "@/lib/market";
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
  const [horizon, setHorizon] = useState<Horizon>("7d");
  const [steps, setSteps] = useState<Step[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [walletBal, setWalletBal] = useState<{ base: number; quote: number } | null>(null);
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [marketName, chooseMarket] = useMarketChoice();
  const [moves, setMoves] = useState<Moves | null>(null);
  const [architectOpen, setArchitectOpen] = useState(false);
  // a design handed over by the Architect, applied once its market has loaded
  const pendingDesign = useRef<Design | null>(null);
  const applyDesign = (d: Design) => {
    setBaseHoldings(d.limits.base);
    setQuoteHoldings(d.limits.quote);
    setBudget(d.limits.budget);
    setPoints(d.payoff);
  };

  // market + buckets
  useEffect(() => {
    if (!marketName) return;
    let alive = true;
    const load = async () => {
      try {
        const ms = await api<MarketInfo[]>("indexer/markets");
        const pick = pickMarket(ms, marketName);
        if (!alive || !pick) return;
        setMarkets(ms);
        setMarket(pick);
        setBuckets(await api<BucketInfo[]>(`indexer/markets/${pick.address}/buckets`));
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
  }, [marketName]);

  // switching market starts a fresh design at a comparable size
  const marketAddr = market?.address;
  useEffect(() => {
    if (!market) return;
    const units = defaultUnits(market);
    setFeas(null);
    const d = pendingDesign.current;
    if (d && d.market === market.name) {
      pendingDesign.current = null;
      applyDesign(d);
    } else {
      setBaseHoldings(units);
      setPoints(PRESETS[preset]!.make(units, market.poolPrice));
    }
    setScenario(market.poolPrice * 0.92);
    const sym = baseSymbol(market).toLowerCase();
    fetch(`/moves/${sym}.json`).then((r) => (r.ok ? r.json() : null)).then(setMoves).catch(() => setMoves(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketAddr]);

  const spot = market?.poolPrice ?? null;

  useEffect(() => {
    if (!wallet.address) return setWalletBal(null);
    const addr = wallet.address;
    if (!market) return;
    const read = () => void Promise.all([tokenBalance(addr, market.baseMint), tokenBalance(addr, market.quoteMint)]).then(([base, quote]) => setWalletBal({ base, quote })).catch(() => setWalletBal(null));
    read();
    const t = setInterval(read, 8_000);
    return () => clearInterval(t);
  }, [wallet.address, opened, marketAddr]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const ready = Boolean(market) && buckets.length > 0;
  // re-check when the ladder changes (it arrives after the market, and borrowable liquidity moves)
  const ladderKey = buckets.map((b) => b.borrowable).join(",");
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
  }, [points, ready, ladderKey, baseHoldings, quoteHoldings, budget]);

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
      const userBase = await tokenAccount(wallet.address, market.baseMint);
      const userQuote = await tokenAccount(wallet.address, market.quoteMint);
      if (!userBase || !userQuote) throw new Error(`No ${market.name} token accounts. Get test funds from the wallet menu.`);
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
  const busyOpen = steps.some((s) => s.state === "doing");
  return (
    <AppShell>
      <Bar
        title="Studio"
        meta={
          <>
            <MarketPicker markets={markets} value={market} onChange={chooseMarket} />
            <span>Pool <span className="num text-ink">{fmtPrice(market?.poolPrice)}</span></span>
            <span>
              Ref <span className="num text-ink">{fmtPrice(market?.reference?.price)}</span>
              {market?.reference && <span className="ml-1.5">{market.reference.kind === "PythPair" ? "Pyth" : "scenario"} · {ago(market.reference.ageSeconds)}</span>}
            </span>
            {(market?.borrowPaused || market?.opensPaused) && <span className="text-warn">{market.opensPaused ? "Opens paused" : "Borrowing paused"}</span>}
          </>
        }
      >
        <button className="btn btn-ghost !py-1 text-[12px]" aria-pressed={architectOpen} onClick={() => setArchitectOpen((x) => !x)} title="Describe what you want; the Architect compiles alternatives">
          Architect
        </button>
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
      {loadErr && !market && <div className="shrink-0 border-b border-line px-5 py-2 text-sm text-bad">Indexer unreachable: {loadErr}</div>}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)_auto]">
        {/* chart */}
        <section className="flex min-h-0 min-w-0 flex-col border-line lg:border-r">
          <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 px-4 pt-3 sm:px-5">
            <div className="label">Payoff at close</div>
            <div className="cap">Drag · double-click to add · Delete to remove</div>
            <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
              <span className="flex items-center gap-1.5"><span className="h-[2px] w-4 bg-accent" /> Target</span>
              <span className="flex items-center gap-1.5"><span className="h-px w-4 bg-ink" /> Compiled</span>
              <span className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-ink-3" /> Hold {fmtNum(baseHoldings, 1)} {baseSymbol(market)}</span>
              {status === "infeasible" && <span className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-warn" /> Closest</span>}
              {moves && <span className="flex items-center gap-2" title={`How far ${market?.name} moved over this horizon in the Binance history, centred on today's price`}>
                <span className="h-2.5 w-4 bg-accent/25" /> Past moves
                <span className="seg !text-[11px]">
                  {(["off", "1d", "7d", "30d"] as const).map((h) => (
                    <button key={h} aria-pressed={horizon === h} onClick={() => setHorizon(h)} className="!px-1.5 !py-0.5">{h}</button>
                  ))}
                </span>
              </span>}
            </div>
          </div>
          <div className="h-[380px] min-h-0 px-2 pb-2 pt-1 sm:px-3 lg:h-auto lg:flex-1">
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
                horizon={horizon}
                moves={moves}
                liquidityScale={scale}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-ink-3">Loading market…</div>
            )}
          </div>
        </section>

        {/* controls column, full height */}
        <aside className="flex min-h-0 flex-col border-t border-line text-sm lg:row-span-2 lg:border-t-0">
          <div className="border-b border-line p-4 sm:p-5">
            <div className="label">Limits</div>
            <div className="mt-2.5 grid grid-cols-3 gap-2">
              {[
                [`${baseSymbol(market)} held`, baseHoldings, market && market.poolPrice < 1 ? 100 : 0.5, setBaseHoldings],
                [`${quoteSymbol(market)} held`, quoteHoldings, 50, setQuoteHoldings],
                ["Max premium", budget, 1, setBudget],
              ].map(([k, v, step, set]) => (
                <label key={k as string} className="block">
                  <span className="cap">{k as string}</span>
                  <input className="input mt-1" type="number" min={0} step={step as number} value={v as number} onChange={(e) => (set as (n: number) => void)(Math.max(0, Number(e.target.value)))} />
                </label>
              ))}
            </div>
            <div className="kv mt-2"><span>Wallet</span><span>{walletBal ? `${fmtNum(walletBal.base, 2)} ${baseSymbol(market)} · ${fmtNum(walletBal.quote, 0)} ${quoteSymbol(market)}` : "—"}</span></div>
            <div className="kv">
              <span className="flex items-center gap-2">
                <span className={`size-1.5 ${status === "ok" ? "bg-good" : status === "infeasible" ? "bg-warn" : "bg-ink-3"}`} />
                <span className={status === "ok" ? "text-good" : status === "infeasible" ? "text-warn" : ""}>{status === "ok" ? "Feasible" : status === "infeasible" ? "Not feasible" : feas ? "Checking" : "—"}</span>
              </span>
              <span>{feas && Number.isFinite(feas.sampled_max_error) ? `${fmtUsd(feas.sampled_max_error)} / ${fmtUsd(feas.tolerance)}` : ""}</span>
            </div>
            {status !== "ok" && feas?.reasons?.length ? <p className="mt-1 line-clamp-2 text-[12px] text-ink-2" title={feas.reasons.join("\n")}>{feas.reasons[0]}</p> : null}
            <button className="btn btn-primary mt-3 w-full" disabled={!points || busy || !market} onClick={compile}>
              {busy ? "Compiling…" : "Compile"}
            </button>
            {err && <p className="mt-2 line-clamp-2 text-[12px] text-bad" title={err}>{err}</p>}
          </div>

          <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
            <div className="label">Open</div>
            {!c ? (
              <p className="cap mt-2">Compile first.</p>
            ) : !wallet.address ? (
              <p className="cap mt-2">Connect a wallet to open.</p>
            ) : (
              <button className="btn btn-primary mt-3 w-full" disabled={compiled?.result.status !== "ok" || busyOpen} onClick={open}>
                Open position
              </button>
            )}
            {c && compiled?.result.status !== "ok" && <p className="mt-2 text-[12px] text-warn">Outside tolerance. Adjust the payoff or limits.</p>}
            <ol className="mt-3 min-h-0 overflow-y-auto">
              {(steps.length ? steps : [{ label: "Simulate", state: "todo" }, { label: "Certify", state: "todo" }, { label: "Build", state: "todo" }, { label: "Sign and send", state: "todo" }] as Step[]).map((s, i) => (
                <li key={i} className="flex gap-3 border-t border-line py-2 first:border-t-0">
                  <span className={`num w-5 shrink-0 text-[12px] ${s.state === "done" ? "text-good" : s.state === "error" ? "text-bad" : s.state === "doing" ? "animate-pulse text-ink" : "text-ink-3"}`}>{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] ${s.state === "todo" ? "text-ink-3" : ""}`}>{s.label}</div>
                    {s.detail && <div className={`num truncate text-[11px] ${s.state === "error" ? "text-bad" : "text-ink-3"}`} title={s.detail}>{s.detail}</div>}
                    {s.sig && <Link className="num text-[11px] text-ink-2 underline underline-offset-2 hover:text-ink" href={`/inspect?sig=${s.sig}`}>{short(s.sig, 6)}</Link>}
                  </div>
                </li>
              ))}
            </ol>
            {opened && <Link href={`/positions?focus=${opened}`} className="btn btn-ghost mt-auto w-full">View position</Link>}
          </div>
        </aside>

        {/* result strip under the chart: ranges, cost, certificate */}
        <div className="grid min-w-0 border-t border-line md:grid-cols-[minmax(0,1fr)_220px_250px] lg:h-[200px] lg:border-r">
          <section className="min-w-0">
            <div className="flex items-center justify-between px-4 pb-1 pt-3 sm:px-5">
              <div className="label">Ranges</div>
              {compiled && <span className="num text-[11px] text-ink-3">solved {(compiled.result.solve_seconds * 1000).toFixed(0)} ms</span>}
            </div>
            {legRows.length ? (
              <div className="max-h-[156px] overflow-auto">
                <table className="tbl tbl-dense">
                  <thead>
                    <tr>{["Leg", "Range", "Notional", "Funding", "m(u)"].map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {legRows.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <span className="flex items-center gap-2 whitespace-nowrap">
                            <span className={`h-2.5 w-[3px] ${l.kind.startsWith("borrow") ? "bg-accent" : "bg-steel"}`} />
                            {KIND_LABEL[kindTag(l.kind)]}
                          </span>
                        </td>
                        <td className="num whitespace-nowrap">{fmtPrice(l.price_lower)} – {fmtPrice(l.price_upper)}</td>
                        <td className="num">{fmtUsd(l.notional)}</td>
                        <td className="whitespace-nowrap text-ink-2">{l.kind.startsWith("borrow") ? "LP escrow" : l.kind === "provide_call" ? `Your ${baseSymbol(market)}` : `Your ${quoteSymbol(market)}`}</td>
                        <td className="num">{l.mult ? `${l.mult.toFixed(2)}×` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="cap px-4 pb-4 pt-1 sm:px-5">Compile to see the ranges.</p>
            )}
          </section>

          <section className="border-t border-line px-4 py-3 md:border-l md:border-t-0 sm:px-5">
            <div className="label">Cost</div>
            {c ? (
              <div className="mt-1">
                <div className="kv"><span>Capital locked</span><span>{fmtUsd(c.capital_locked)}</span></div>
                <div className="kv"><span>Buffers</span><span>{fmtUsd(c.buffer_quote + c.buffer_base * c.spot)}</span></div>
                <div className="kv"><span>LP escrow</span><span>{fmtUsd(c.escrow_quote + c.escrow_base * c.spot)}</span></div>
                <div className="kv"><span>Max premium</span><span>{fmtUsd(budget)}</span></div>
                <div className="kv"><span>Min premium</span><span>{borrowedLegs.length ? `${fmtUsd(floorPerDay)}/day` : "—"}</span></div>
              </div>
            ) : (
              <p className="cap mt-1">After compile.</p>
            )}
          </section>

          <section className="border-t border-line px-4 py-3 md:border-l md:border-t-0 sm:px-5">
            <div className="flex items-center justify-between">
              <div className="label">Certificate</div>
              {cert && (
                <a
                  className="text-[12px] text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink"
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(cert, null, 2))}`}
                  download={`forge-certificate-${cert.hash.slice(0, 12)}.json`}
                  title={cert.disclaimer}
                >
                  JSON
                </a>
              )}
            </div>
            {cert ? (
              <div className="mt-1">
                <div className="kv"><span>Max error</span><span className="text-[15px] font-medium">±{fmtUsd(cert.error.certified_bound)}</span></div>
                <div className="kv"><span>Domain</span><span>{fmtPrice(cert.target.domain[0])} – {fmtPrice(cert.target.domain[1])}</span></div>
                <div className="kv"><span>Liquidity</span><span className={certOk === false ? "!text-bad" : ""}>{certOk == null ? "—" : certOk ? "available" : "insufficient"}</span></div>
                <div className="kv"><span>Simulation</span><span>{cert.simulation ? `${(cert.simulation.compute_units as number[]).map((x) => x.toLocaleString()).join(" + ")} CU` : "at open"}</span></div>
                <div className="kv"><span>Hash</span><span className="truncate pl-4" title={cert.hash}>{cert.hash.slice(0, 14)}…</span></div>
              </div>
            ) : (
              <p className="cap mt-1">After compile.</p>
            )}
          </section>
        </div>
      </div>
      <Architect
        open={architectOpen}
        onClose={() => setArchitectOpen(false)}
        owner={wallet.address ?? null}
        onLoad={(d) => {
          if (market && d.market === market.name) applyDesign(d);
          else {
            pendingDesign.current = d;
            chooseMarket(d.market);
          }
        }}
      />
    </AppShell>
  );
}
