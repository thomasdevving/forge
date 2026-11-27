// Extract benchmark summaries for one market from the newest committed results folder that has each file.
// The landing page shows only these measured numbers; nothing is typed in by hand.
// Market: --market NAME or FORGE_PROOF_MARKET (default JUP/USDC). Files without a market field are SOL/USDC.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const results = resolve(here, "../../benchmarks/results");
const out = resolve(here, "../src/data/benchmarks.json");
if (!existsSync(results)) {
  console.log("no benchmarks/results folder; keeping existing src/data/benchmarks.json");
} else {
  syncBenchmarks();
}
syncResearch();

// The program's pricing parameters a benchmark ran under (floor rate, utilization curve, any protocol fee), as recorded.
function pricingOf(data) {
  const p = data?.program_params ?? data?.simulator?.program_parity ?? data?.program_parity ?? null;
  return p?.used ?? null;
}

function syncBenchmarks() {
const argi = process.argv.indexOf("--market");
const market = argi > 0 ? process.argv[argi + 1] : (process.env.FORGE_PROOF_MARKET ?? "JUP/USDC");
const runs = readdirSync(results).sort().reverse();
const latest = (file) => {
  for (const run of runs) {
    const path = resolve(results, run, file);
    if (!existsSync(path)) continue;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const rowsOk = !("rows" in data) || data.rows.length > 0;
    const name = typeof data.market === "object" && data.market ? data.market.name : (data.market ?? "SOL/USDC");
    if (name === market && rowsOk) return { run, data };
  }
  return null;
};
const rep = latest("replication.json");
const real = latest("realized.json");
const lp = latest("lp_guarantee.json");
const prof = latest("lp_profitability.json");
const doc = {
  market,
  replication: rep && {
    run: rep.run,
    summary: rep.data.summary,
    boundViolations: rep.data.bound_violations.length,
    spot: rep.data.spot ?? null,
    units: rep.data.units ?? null,
    payoffs: rep.data.summary["optimizer/deep"].payoffs,
  },
  realized: real && {
    run: real.run,
    refused: real.data.rows.filter((r) => r.status === "refused").map((r) => ({ payoff: r.payoff, move: r.move, guard: r.guard })),
    rows: real.data.rows.filter((r) => r.status !== "refused").map((r) => ({
      units: r.units ?? null, slippageBps: r.swap_slippage_bps ?? null, payoff: r.payoff, move: r.move, close: r.close_price, target: r.target, construction: r.construction,
      bound: r.certified_bound, gross: r.realized_full_gross, net: r.realized_net, premium: r.premium,
      feeCredits: r.fee_credits, swapCost: r.restoration_swap_cost, gap: r.gap_to_construction,
      spot: r.spot, legs: r.legs, detail: r.construction_detail ?? null, breakpoints: r.target_breakpoints ?? null,
    })),
  },
  // Benchmark 4: historical windows, conservative fee model (arbitrage only), per utilization level
  lpProfit: prof && (() => {
    const rows = prof.data.summary.filter((r) => r.regime === "hist-all" && r.fee_mode === "arb-band");
    const pick = (demand, budget) => rows.find((r) => r.demand === demand && r.budget === budget) ?? null;
    const slim = (r) => r && {
      n: r.n, shareBgeA: r.share_B_ge_A, extraMedianBps: r.extra_bps_median, extraP5Bps: r.extra_bps_p5, extraMinBps: r.extra_bps_min,
      shareBgtHodl: r.share_B_gt_HODL, shareAgtHodl: r.share_A_gt_HODL, aprA: r.apr_a_median, aprB: r.apr_b_median,
    };
    return {
      run: prof.run,
      capitalUsd: prof.data.capital_usd,
      none: slim(pick("none", "-")),
      keeper: Object.fromEntries(["u20-long", "u50-long", "u80-long"].map((d) => [d, slim(pick(d, "realistic+keeper"))])),
      noKeeper: Object.fromEntries(["u20-long", "u50-long", "u80-long"].map((d) => [d, slim(pick(d, "realistic"))])),
    };
  })(),
  lpGuarantee: lp && {
    run: lp.run,
    seed: lp.data.seed,
    history: lp.data.history ?? null,
    claim: lp.data.claim ?? null,
    pricing: pricingOf(lp.data),
    summary: lp.data.summary,
  },
};
if (doc.lpProfit) {
  doc.lpProfit.pricing = pricingOf(prof.data);
  doc.lpProfit.history = prof.data.history ?? null;
  doc.lpProfit.notReplay = prof.data.not_a_replay ?? null;
}
writeFileSync(out, JSON.stringify(doc, null, 1) + "\n");
console.log(`wrote ${out} for ${market} (replication ${rep?.run}, realized ${real?.run}, lp ${lp?.run})`);
}

// The recent-regime research study (benchmarks/research/<newest>/results.json, report.md): a compact summary for
// the /proof page. Every number is read from results.json; the only inputs added here are the labeled
// assumptions for the revenue illustration (TVL levels and take rates), as in the study's report.
function syncResearch() {
  const root = resolve(here, "../../benchmarks/research");
  const target = resolve(here, "../src/data/research.json");
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => existsSync(resolve(root, d, "results.json"))).sort().reverse() : [];
  if (!dirs.length) {
    console.log("no benchmarks/research/*/results.json; keeping existing src/data/research.json");
    return;
  }
  const dir = dirs[0];
  // Python writes NaN for empty medians; JSON has no NaN.
  const R = JSON.parse(readFileSync(resolve(root, dir, "results.json"), "utf8").replace(/\bNaN\b/g, "null"));
  const reportPath = resolve(root, dir, "report.md");
  const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  const bullets = (heading) => {
    const m = report.split(/^## /m).find((sec) => sec.startsWith(heading));
    if (!m) return [];
    const items = [];
    for (const line of m.split("\n").slice(1)) {
      if (line.startsWith("- ")) items.push(line.slice(2).trim());
      else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += " " + line.trim();
    }
    return items.map((t) => t.replace(/\*\*/g, "").replace(/`/g, ""));
  };

  const tokens = Object.keys(R.regimes);
  const lp = R.lp_summary;
  const row = (t, hz, mode, cfg, floor = 0.05, curve = "default", budget = "realistic+keeper") =>
    lp.find((r) => r.token === t && r.horizon === hz && r.fee_mode === mode && r.config === cfg &&
      (cfg === "none" || (r.floor === floor && r.curve === curve && r.budget === budget))) ?? null;
  const demand = ["u20-short", "u50-short", "u80-short", "u20-long", "u50-long", "u80-long"];
  const horizons = [...new Set(lp.map((r) => r.horizon))].sort((a, b) => parseInt(a) - parseInt(b));
  const modes = [...new Set(lp.map((r) => r.fee_mode))];

  // Keeper, default pricing: worst share of windows where FORGE LPs ended >= plain Orca, over every cell.
  const keeperCells = lp.filter((r) => r.config !== "none" && r.curve === "default" && r.floor === 0.05 && r.budget === "realistic+keeper");
  const noKeeperLong7d = lp.filter((r) => r.config.endsWith("-long") && r.horizon === "7d" && r.curve === "default" && r.floor === 0.05 && r.budget === "realistic");

  const iv = R.deribit?.sol_iv_daily_atm ?? {};
  const ivStart = R.regimes.SOL?.start?.slice(0, 10);
  const ivWin = Object.entries(iv).filter(([d]) => ivStart && d >= ivStart).map(([d, v]) => ({ d, v: v.median_iv })).sort((a, b) => a.v - b.v);

  const hedge = (t, tn) => {
    const S = R.hedge_summary[`${t}/${tn}`];
    if (!S) return null;
    const d = S["default/arb-band/u50"], o = S.outcome_default_arbband_u50;
    const g = R.gbm_exante[`${t}/${tn}/rv30_end`]?.grid;
    const ks = R.hedges.filter((h) => h.token === t && h.tenor === tn).map((h) => h.strike_put / h.S0).sort((a, b) => a - b);
    return {
      token: t, tenor: tn, starts: S.n_starts, strikeOverSpotMedian: ks.length ? ks[Math.floor(ks.length / 2)] : null,
      floorUsd: d.floor_usd, premiumMedianUsd: d.premium_usd_median,
      fairRv30MedianUsd: d.vs_rv_trailing30?.fair_usd_median ?? null,
      ratioRv30: d.vs_rv_trailing30?.ratio_median ?? null,
      ratioIv: d.vs_deribit_iv?.ratio_median ?? null,
      ratioExpost: d.vs_rv_expost?.ratio_median ?? null,
      exanteU50: g?.["arb-band/0.05/default/u50"]?.ratio_to_fair ?? null,
      exanteU80: g?.["arb-band/0.05/default/u80"]?.ratio_to_fair ?? null,
      payoffMeanUsd: o?.payoff_usd_mean ?? null, premiumMeanUsd: o?.premium_usd_mean ?? null,
      netMeanUsd: o?.net_usd_mean ?? null, shareNetPositive: o?.share_net_positive ?? null,
    };
  };

  // Revenue illustration: premium flow (median % of LP capital a year, 7-day windows, 50% utilization) x assumed take x assumed TVL.
  const TVL = [1e6, 1e7, 5e7];
  const rev = (label, curve, kind, take) => {
    const r = row("SOL", "7d", "arb-band", "u50-short", 0.05, curve);
    if (!r) return null;
    const perUsd = kind === "premium" ? r.premium_apr_median * take : ((r.takes_on_excess?.[take.toFixed(2)]?.revenue_bps_median ?? NaN) / 1e4) * (365 / 7);
    return { pricing: label, take: kind === "premium" ? `${Math.round(take * 100)}% of premium` : `${Math.round(take * 100)}% of premium above forgone fees`, perYearUsd: TVL.map((v) => v * perUsd) };
  };
  const premiumFlowVsSol = tokens.filter((t) => t !== "SOL").map((t) => ({ token: t, ratio: (row(t, "7d", "arb-band", "u50-short")?.premium_apr_median ?? NaN) / (row("SOL", "7d", "arb-band", "u50-short")?.premium_apr_median ?? NaN) }));

  const band = (mode) => {
    const B = R.pricing_band?.[mode] ?? {};
    const all = Object.values(B);
    return {
      tested: all.length,
      passing: all.filter((b) => b.in_band).map((b) => ({ token: b.token, floor: b.floor, curve: b.curve, lpMaxTake: b.lp_max_take_95pct, lpMaxTakeOnExcess: b.lp_max_take_on_excess_95pct, lpExtra7dBps: b.lp_extra_bps_median_7d_u50_short, borrowerExante7d: b.borrower_exante_ratio?.["7d/rv30_end"] ?? null })),
      defaultCurvePassing: all.filter((b) => b.in_band && b.curve === "default").length,
    };
  };

  const doc = {
    study: R.study,
    folder: `benchmarks/research/${dir}`,
    generatedAt: R.generated_at_utc,
    windowDays: R.window_days,
    window: { start: R.regimes[tokens[0]].start, end: R.regimes[tokens[0]].end },
    source: R.data_manifest?.source ?? null,
    pricing: R.program_parity?.used ?? null,
    curves: R.assumptions?.curves ?? null,
    assumptions: {
      feeModels: { "arb-band": "fees from arbitrage only (conservative)", "band+noise": "arbitrage plus assumed extra trading volume" },
      budgets: R.assumptions?.budgets ?? null,
      hedgeUsd: R.assumptions?.hedge_usd ?? null,
      fairValue: R.assumptions?.fair_value ?? null,
      pools: R.assumptions?.bonk_kmno_pool ?? null,
      revenueTvlUsd: TVL,
    },
    regimes: tokens.map((t) => {
      const g = R.regimes[t];
      return { token: t, open: g.open, close: g.close, low: g.low, return: g.return, maxDrawdown: g.max_drawdown, troughDate: g.drawdown_trough?.slice(0, 10), vol1d: g.vol_1d, volJanOct: g.context_jan_oct?.vol_1d ?? null, daysAbsMoveGt5: g.days_abs_move_gt_5pct, weeksDown: g.weekly_returns.filter((w) => w.return < 0).length, weeks: g.weekly_returns.length };
    }),
    solIv: ivWin.length ? { days: ivWin.length, median: ivWin[Math.floor(ivWin.length / 2)].v, max: ivWin[ivWin.length - 1].v, maxDate: ivWin[ivWin.length - 1].d } : null,
    lp: {
      keeperShareMin: keeperCells.length ? Math.min(...keeperCells.map((r) => r.share_B_ge_A)) : null,
      keeperCells: keeperCells.length,
      noKeeperLong7dShare: noKeeperLong7d.length ? [Math.min(...noKeeperLong7d.map((r) => r.share_B_ge_A)), Math.max(...noKeeperLong7d.map((r) => r.share_B_ge_A))] : null,
      horizons, modes,
      rows: tokens.flatMap((t) => horizons.map((hz) => {
        const r = row(t, hz, "arb-band", "u50-short"), nk = row(t, hz, "arb-band", "u50-long", 0.05, "default", "realistic"), none = row(t, hz, "arb-band", "none");
        return r && { token: t, horizon: hz, n: r.n, shareBgeA: r.share_B_ge_A, extraMedianBps: r.extra_bps_median, extraMinBps: r.extra_bps_min, aHodlBps: none?.a_hodl_bps_median ?? r.a_hodl_bps_median, bHodlBps: r.b_hodl_bps_median, noKeeperLongShareBgeA: nk?.share_B_ge_A ?? null };
      })).filter(Boolean),
      demand,
    },
    borrowers: tokens.flatMap((t) => ["7d", "30d"].map((tn) => hedge(t, tn))).filter(Boolean),
    protocol: {
      revenue: [rev("Default (5%, 1 + u)", "default", "premium", 0.1), rev("Band (5%, flat 1.1)", "flat m=1.1", "premium", 0.05), rev("Band (5%, flat 1.1)", "flat m=1.1", "excess", 0.2)].filter(Boolean),
      premiumFlowVsSol,
    },
    band: { "arb-band": band("arb-band"), "band+noise": band("band+noise") },
    recommendation: bullets("Recommendation"),
    caveats: bullets("Caveats"),
  };
  writeFileSync(target, JSON.stringify(doc, null, 1) + "\n");
  console.log(`wrote ${target} from ${doc.folder}`);
}
