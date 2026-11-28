"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, Bar } from "@/components/AppShell";
import { Architect, type Design } from "@/components/studio/Architect";
import { type Horizon, type Moves, PayoffChart } from "@/components/studio/PayoffChart";
import { api, type BucketInfo, type BuiltTx, type CompileResponse, type Feasibility, type MarketInfo } from "@/lib/api";
import { legUtilization, liquidityScale, sigmaFromMoves, suggestedBudget } from "@/lib/fairvalue";
import { ago, fmtNum, fmtPrice, fmtUsd, short } from "@/lib/format";
import { clampLevels, KIND_LABEL, kindTag, LEVEL_POINTS, levelsOf, type Point, PRESETS } from "@/lib/payoff";
import { DURATIONS, HedgeForm } from "@/components/studio/HedgeForm";
import { tokenAccount, tokenBalance } from "@/lib/rpc";
import { baseSymbol, defaultUnits, MarketPicker, pickMarket, quoteSymbol, useMarketChoice } from "@/lib/market";
import { BALANCES_EVENT, useWallet } from "@/lib/wallet";


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
  /** How long the cover runs: sets the position's on-chain expiry and the suggested budget. */
  const [days, setDays] = useState(7);
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
  const [funding, setFunding] = useState(false);
  const getFunds = async () => {
    setFunding(true);
    setErr(null);
    try {
      await wallet.fundDemo();
    } catch (e) {
      setErr(/funded recently/i.test((e as Error).message) ? "This wallet was funded in the last 10 minutes. Lower the size or try again later." : (e as Error).message);
    } finally {
      setFunding(false);
    }
  };
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [marketName, chooseMarket] = useMarketChoice();
  const [moves, setMoves] = useState<Moves | null>(null);
  const [architectOpen, setArchitectOpen] = useState(false);
  // /studio?architect=1 (from the landing) opens the Architect straight away
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("architect") === "1") setArchitectOpen(true);
  }, []);
  // a design handed over by the Architect, applied once its market has loaded
  const pendingDesign = useRef<Design | null>(null);
  // a design from the Architect is compiled as soon as it is on the chart, so it is one click from opening
  const autoCompile = useRef(false);
  const applyDesign = (d: Design) => {
    setBaseHoldings(d.limits.base);
    setQuoteHoldings(d.limits.quote);
    setBudget(d.limits.budget);
    // the closest duration the form offers to the holding period the Architect planned for
    if (d.days) setDays(DURATIONS.reduce((a, x) => (Math.abs(x - d.days!) < Math.abs(a - d.days!) ? x : a), 7));
    setPoints(d.payoff);
    autoCompile.current = true;
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
        // market and its ladder change together, so nothing compiles against another market's buckets
        const bs = await api<BucketInfo[]>(`indexer/markets/${pick.address}/buckets`);
        if (!alive) return;
        setMarkets(ms);
        setMarket(pick);
        setBuckets(bs);
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
    if (d && d.market.toUpperCase() === market.name.toUpperCase()) {
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
    window.addEventListener(BALANCES_EVENT, read);
    return () => {
      clearInterval(t);
      window.removeEventListener(BALANCES_EVENT, read);
    };
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
  // the market has loaded but its ladder is empty (buckets for a market arrive with it)
  const noLadder = Boolean(market) && buckets.length === 0 && !loadErr;
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

  useEffect(() => {
    if (!autoCompile.current || !points || !ready) return;
    autoCompile.current = false;
    void compile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, ready, baseHoldings, quoteHoldings, budget]);

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
        const base = c.base_ppm / 1e6;
        mult = u <= c.kink_ppm / 1e6 ? base + (c.slope1_ppm / 1e6) * u : base + (c.slope1_ppm / 1e6) * (c.kink_ppm / 1e6) + (c.slope2_ppm / 1e6) * (u - c.kink_ppm / 1e6);
      }
      const ra = Math.sqrt(l.price_lower), rb = Math.sqrt(l.price_upper);
      const notional = l.kind.endsWith("put") ? L * scale * (rb - ra) : L * scale * (1 / ra - 1 / rb) * market.poolPrice;
      return { ...l, mult, notional };
    });
  }, [legs, buckets, market, scale]);

  // suggested premium budget for the chosen duration: an estimate from the token's past moves (lib/fairvalue)
  const suggestion = useMemo(() => {
    if (!market || !moves || !legs.some((l) => l.kind.startsWith("borrow"))) return null;
    const q: Record<string, { p5?: number; p95?: number }> = {};
    for (const [h, v] of Object.entries(moves.horizons)) q[h] = v.quantiles;
    const s = sigmaFromMoves(q, days);
    if (!s) return null;
    const r = suggestedBudget({
      legs: legs.map((l) => ({ ...l, utilization: legUtilization(l, buckets, market.params.curve) })),
      spot: market.poolPrice, sigma: s.sigma, days, scale: liquidityScale(market.baseDecimals, market.quoteDecimals), params: market.params,
    });
    if (!(r.budget > 0)) return null;
    const m = moves as Moves & { from_ms?: number; to_ms?: number };
    const day = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "?");
    return { budget: Math.ceil(r.budget * 100) / 100, sigma: s.sigma, horizon: s.horizon, period: `${day(m.from_ms)} to ${day(m.to_ms)}` };
  }, [legs, buckets, market, moves, days]);

  // the form and the chart describe the same payoff: levels read back from the breakpoints (null = reshaped by hand)
  const levels = useMemo(() => (points ? levelsOf(preset, points, baseHoldings) : null), [points, preset, baseHoldings]);
  const fromLevels = (prices: number[], units = baseHoldings) => {
    if (spot) setPoints(PRESETS[preset]!.make(units, spot, prices.map((x) => x / spot)));
  };

  const floorPerDay = market ? legRows.filter((l) => l.kind.startsWith("borrow")).reduce((a, l) => a + l.notional, 0) * (market.params.floor_rate_bps / 1e4) / 365 : 0;
  const cert = compiled?.certificate ?? null;
  const c = compiled?.result.construction;

  const opening = useRef(false);
  const open = async () => {
    if (!compiled?.result.construction || !market || !points || !wallet.address || opening.current) return;
    opening.current = true;
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
        expiry: String(market.now + days * 86_400),
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
    } finally {
      opening.current = false;
    }
  };

  const status = feas?.status;
  const certOk = cert ? (cert.liquidity_check.length ? cert.liquidity_check.every((l) => l.ok) : null) : null;
  const busyOpen = steps.some((s) => s.state === "doing");
  // what opening takes from the wallet: the premium budget, the restoration buffers and the provided ranges
  const B = baseSymbol(market), Q = quoteSymbol(market);
  const needQuote = c ? budget + c.buffer_quote + c.provided_quote : 0;
  const needBase = c ? c.buffer_base + c.provided_base : 0;
  const refAge = market?.reference?.ageSeconds ?? 0;
  const refStale = Boolean(market?.reference) && refAge > (market?.params.ref_max_age_s ?? Infinity) * 2;
  const blocker: string | null = !c
    ? null
    : market?.opensPaused
      ? "New opens are paused in this market."
      : market?.borrowPaused && borrowedLegs.length
        ? "Borrowing is paused in this market pending a shortfall review. Pick another market."
        : refStale
          ? `The price reference is ${ago(refAge)} old, so the program refuses to open. Try again once it refreshes.`
          : borrowedLegs.length && budget <= 0
            ? "Set a max premium above $0: borrowed ranges pay LPs a premium."
            : walletBal && (walletBal.quote + 1e-9 < needQuote || walletBal.base + 1e-9 < needBase)
              ? `Needs ${fmtNum(needBase, needBase < 10 ? 4 : 0)} ${B} and ${fmtNum(needQuote, 2)} ${Q}; the wallet has ${fmtNum(walletBal.base, walletBal.base < 10 ? 4 : 0)} ${B} and ${fmtNum(walletBal.quote, 2)} ${Q}.`
              : null;
  // the compiler speaks of base and quote; say the token names, and say which limit to change
  const say = (r: string) => {
    const t = r
      .replace(/quote holdings \(after the premium budget\) are fully used/, `all of ${Q} held (after the max premium) is used: raise ${Q} held or lower the curve`)
      .replace(/base holdings are fully used/, `all of ${B} held is used: raise ${B} held or lower the curve`)
      .replace(/\bquote holdings\b/g, `${Q} held`)
      .replace(/\bbase holdings\b/g, `${B} held`);
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const walletEmpty = walletBal !== null && walletBal.base === 0 && walletBal.quote === 0;
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
            {refStale && <span className="text-warn" title="The program only opens against a fresh reference price">Reference stale</span>}
          </>
        }
      >
        <button data-tour="architect" className="btn btn-ghost !py-1 text-[12px]" aria-pressed={architectOpen} onClick={() => setArchitectOpen((x) => !x)} title="Describe what you want; the Architect compiles alternatives">
          Architect
        </button>
      </Bar>
      {loadErr && !market && <div className="shrink-0 border-b border-line px-5 py-2 text-sm text-bad" role="alert">Market data is unreachable right now, retrying every 15 s. <span className="text-ink-3">({loadErr})</span></div>}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)_auto]">
        {/* chart */}
        <section data-tour="chart" className="flex min-h-0 min-w-0 flex-col border-line lg:border-r">
          <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 px-4 pt-3 sm:px-5">
            <div className="label">Payoff at close</div>
            <div className="cap">{levels ? "Drag a point to move its level · double-click to add a point for a custom shape" : "Drag · double-click to add · Delete to remove"}</div>
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
                onChange={(next) => {
                  // with a strategy active, dragging one of its level points slides that level along the
                  // strategy's shape (the form follows); end points and added points reshape freely
                  if (levels && spot && points && next.length === points.length) {
                    const i = next.findIndex((q, k) => q[0] !== points[k]![0] || q[1] !== points[k]![1]);
                    const li = (LEVEL_POINTS[preset] ?? []).indexOf(i);
                    if (li >= 0) {
                      const prices = [...levels];
                      prices[li] = next[i]![0];
                      return fromLevels(clampLevels(preset, prices, spot));
                    }
                  }
                  setPoints(next);
                }}
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
        <aside className="flex min-h-0 flex-col border-t border-line text-sm lg:row-span-2 lg:overflow-y-auto lg:border-t-0">
          <div className="border-b border-line p-4 sm:p-5">
            <div className="label">Your hedge</div>
            <div className="mt-3">
              <HedgeForm
                preset={preset}
                levels={levels}
                ready={!!points && !!spot}
                spot={spot}
                onPreset={(k) => {
                  if (!PRESETS[k]) return;
                  setPreset(k);
                  if (spot) setPoints(PRESETS[k]!.make(baseHoldings, spot));
                }}
                onLevels={(prices) => fromLevels(prices)}
                days={days}
                onDays={setDays}
                budget={budget}
                onBudget={setBudget}
                quote={Q}
                suggestion={suggestion ? {
                  budget: suggestion.budget,
                  title: `Estimate from ${baseSymbol(market)}'s past ${suggestion.horizon} moves (Binance, ${suggestion.period}; volatility about ${(suggestion.sigma * 100).toFixed(0)}%/yr): for each borrowed range, the larger of the time floor and m(u) × the range's expected payoff over ${days} days, plus the keeper's share. Actual premium depends on trading. The keeper closes the position when the budget is used, so a smaller budget can end the cover early. Click to use it.`,
                } : null}
              />
            </div>
          </div>
          <div data-tour="limits" className="border-b border-line p-4 sm:p-5">
            <div className="grid grid-cols-2 gap-2">
              {([
                [`${baseSymbol(market)} held`, baseHoldings, market && market.poolPrice < 1 ? 100 : 0.5, (n: number) => {
                  // a preset shape keeps its levels and scales with what you hold
                  if (levels) fromLevels(levels, n);
                  setBaseHoldings(n);
                }],
                [`${quoteSymbol(market)} held`, quoteHoldings, 50, setQuoteHoldings],
              ] as const).map(([k, v, step, set]) => (
                <label key={k} className="block">
                  <span className="cap block truncate">{k}</span>
                  <input className="input mt-1 !px-2 !py-1" type="number" inputMode="decimal" min={0} step={step} value={v} onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))} />
                </label>
              ))}
            </div>
            <div className="kv mt-2">
              <span>Wallet</span>
              <span>
                {!wallet.address ? "not connected" : walletBal ? `${fmtNum(walletBal.base, 2)} ${B} · ${fmtNum(walletBal.quote, 0)} ${Q}` : "…"}
              </span>
            </div>
            {wallet.kind === "demo" && walletEmpty && (
              <button className="mt-1 block w-full text-right text-[11px] text-ink-2 underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-50" disabled={funding} onClick={getFunds}>
                {funding ? "Funding…" : "Empty. Get test funds"}
              </button>
            )}
            <div className="kv">
              <span className="flex items-center gap-2">
                <span className={`size-1.5 ${status === "ok" ? "bg-good" : status === "infeasible" ? "bg-warn" : "bg-ink-3"}`} />
                <span className={status === "ok" ? "text-good" : status === "infeasible" ? "text-warn" : status === "invalid" ? "text-bad" : ""}>{status === "ok" ? "Feasible" : status === "infeasible" ? "Not feasible" : status === "invalid" ? "Cannot check" : noLadder ? "No funded ranges" : points && market ? "Checking…" : "—"}</span>
              </span>
              <span>{feas && Number.isFinite(feas.sampled_max_error) ? `${fmtUsd(feas.sampled_max_error)} / ${fmtUsd(feas.tolerance)}` : ""}</span>
            </div>
            {noLadder && (
              <p className="mt-1 text-[12px] text-ink-2">
                Nobody has deposited liquidity in {market?.name} yet, so there is nothing to borrow. <Link href="/earn" className="underline underline-offset-2 hover:text-ink">Add some in Earn</Link> or pick another market.
              </p>
            )}
            {status !== "ok" && feas?.reasons?.length ? <p className="mt-1 line-clamp-2 text-[12px] text-ink-2" title={feas.reasons.map(say).join("\n")}>{say(feas.reasons[0]!)}</p> : null}
            <button data-tour="compile" className="btn btn-primary mt-3 w-full" disabled={!points || busy || !market} onClick={compile}>
              {busy ? "Compiling…" : "Compile"}
            </button>
            {err && <p className="mt-2 line-clamp-2 text-[12px] text-bad" title={err}>{err}</p>}
          </div>

          <div data-tour="open" className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
            <div className="label">Open</div>
            {!c ? (
              <p className="cap mt-2">Compile first.</p>
            ) : !wallet.address ? (
              <p className="cap mt-2">Connect a wallet to open (top right).</p>
            ) : (
              <button className="btn btn-primary mt-3 w-full" disabled={compiled?.result.status !== "ok" || busyOpen || Boolean(opened) || (Boolean(blocker) && !busyOpen)} onClick={open}>
                {busyOpen ? "Opening…" : opened ? "Opened" : "Open position"}
              </button>
            )}
            {c && compiled?.result.status !== "ok" && <p className="mt-2 text-[12px] text-warn">Outside tolerance. Adjust the payoff or limits.</p>}
            {c && wallet.address && compiled?.result.status === "ok" && blocker && !busyOpen && !opened && (
              <p className="mt-2 text-[12px] text-warn" role="status">
                {blocker}
                {wallet.kind === "demo" && /wallet has/.test(blocker) && (
                  <>
                    {" "}
                    <button className="underline underline-offset-2 hover:text-ink disabled:opacity-50" disabled={funding} onClick={getFunds}>{funding ? "Funding…" : "Get test funds"}</button>
                  </>
                )}
              </p>
            )}
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
        <div data-tour="results" className="grid min-w-0 border-t border-line md:grid-cols-[minmax(0,1fr)_220px_250px] lg:h-[200px] lg:border-r">
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
              <p className="cap px-4 pb-4 pt-1 sm:px-5">{compiled ? "No ranges: this result is just what you hold." : "Compile to see the ranges."}</p>
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
        usdc={quoteHoldings}
        hint={
          !wallet.address ? (
            <>No wallet connected. Connect one (top right) so the Architect can read your balances; opening a position needs one too.</>
          ) : wallet.kind === "demo" && walletEmpty ? (
            <>
              Your demo wallet is empty, so nothing can be built for it yet.{" "}
              <button className="underline underline-offset-2 hover:text-ink disabled:opacity-50" disabled={funding} onClick={getFunds}>{funding ? "Funding…" : "Get test funds"}</button>
            </>
          ) : null
        }
        onLoad={(d) => {
          setArchitectOpen(false);
          if (market && d.market.toUpperCase() === market.name.toUpperCase()) applyDesign(d);
          else {
            pendingDesign.current = d;
            chooseMarket(d.market);
          }
        }}
      />
    </AppShell>
  );
}
