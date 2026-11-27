"""Benchmark 3: the conditional LP guarantee (sections 4.6, 12.4).

Paired simulation over historical and synthetic paths for one market (SOL/USDC by default, any
market in benchmarks/markets.py with --market). Historical inputs are the market's Binance 1-minute
bars (benchmarks/data/<SYMBOL>-1m.npz, manifest.json for SOLUSDC, manifest-<SYMBOL>.json otherwise);
the pool fee rate comes from the market table and synthetic GBM paths start at the market spot
(SOL/USDC keeps its original 70.0). They drive a controlled pool simulation and are labelled
"historical-price-driven", not a replay of Orca swaps. OHLC bars do not record intra-bar order, so
every window runs with both high-first and low-first orderings.

Simulator: forge_math.lpsim.simulate_path with SimParams.from_program() (program defaults read from
programs/forge, mismatch fails loudly). The pool follows the price only outside the fee's
no-arbitrage band; noise volume is a multiple of the LP ladder's value; the time floor uses the
notional stored at open; refused restorations (slippage cap, escrow margin) are retried after 1 h.
The "base+keeper" variant adds keeper closes at the on-chain trigger (80% of the LP cap, 5 min delay).
"legacy-fee-model" reruns base with the old arbitrage-to-every-price fee model for comparison only and
is excluded from "all".

Every path is reported, including ineligible ones (premium shortfall) and counterexamples to
final-value dominance. Nothing is filtered.

Usage: uv run python benchmarks/lp_guarantee.py [--quick] [--out DIR] [--market JUP/USDC] [--workers N]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from forge_math.lpsim import SimParams, gbm_path, ohlc_path, program_parity, simulate_path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import markets  # noqa: E402

WINDOW_MINUTES = 7 * 24 * 60
SEED = 20261127
NOISE_PER_DAY = 1.0          # round-trip noise volume per day, x the LP ladder's starting value
COMPARISON_ONLY = ("legacy-fee-model",)


def run_id() -> str:
    sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                         cwd=HERE).stdout.strip() or "nogit"
    return f"{datetime.now(UTC):%Y%m%d-%H%M%S}-{sha}"


def historical_paths(quick: bool, mk: markets.Market):
    data = mk.history_path()
    if not data.exists():
        print(f"missing price data: run benchmarks/fetch_history.py --symbol {mk.symbol} first", file=sys.stderr)
        return []
    d = np.load(data)
    o, h, low, c = d["open"], d["high"], d["low"], d["close"]
    n = len(c) // WINDOW_MINUTES
    if quick:
        n = min(n, 4)
    out = []
    for w in range(n):
        sl = slice(w * WINDOW_MINUTES, (w + 1) * WINDOW_MINUTES)
        start = datetime.fromtimestamp(int(d["open_ms"][sl.start]) / 1000, UTC).date()
        for hf in (True, False):
            out.append((f"hist-{start}-{'HL' if hf else 'LH'}", ohlc_path(o[sl], h[sl], low[sl], c[sl], hf),
                        15.0, "historical-price-driven"))
    return out


def synthetic_paths(quick: bool, start: float):
    out = []
    seeds = 3 if quick else 20
    for vol in (0.5, 0.9, 1.4):
        for i in range(seeds):
            s = SEED + int(vol * 1000) + i
            out.append((f"gbm-vol{vol}-s{s}", gbm_path(start, WINDOW_MINUTES, vol, seed=s), 60.0,
                        "synthetic-gbm"))
    return out


def _run(job: tuple) -> dict:
    i, pid, prices, source, variant, params = job
    r = simulate_path(prices, params, seed=SEED + i, path_id=pid)
    d = r.to_dict()
    d.update(source=source, variant=variant)
    return {k: (v.item() if isinstance(v, np.generic) else v) for k, v in d.items()}


def summarize(rows: list[dict]) -> dict:
    def agg(sel):
        rs = [r for r in rows if sel(r)]
        elig = [r for r in rs if r["eligible"]]
        return {
            "paths": len(rs),
            "borrows_eligible": sum(r["borrows_eligible"] for r in rs),
            "borrows_guarantee_holds": sum(r["borrows_holding"] for r in rs),
            "borrows_guarantee_violations": sum(len(r["borrow_violations"]) for r in rs),
            "borrows_premium_shortfall": sum(r["borrows_shortfall"] for r in rs),
            "borrows_with_restoration_refusals": sum(r["borrows_with_refusals"] for r in rs),
            "keeper_closes": sum(r["keeper_closes"] for r in rs),
            "eligible": len(elig),
            "guarantee_holds_on_eligible": sum(r["guarantee_holds"] for r in elig),
            "guarantee_violations_on_eligible": [r["path_id"] for r in elig if not r["guarantee_holds"]],
            "ineligible_shortfall": sum(r["shortfall"] > 0 for r in rs),
            "ineligible_restoration_failure": 0,   # refused restorations are retried, never dropped
            "paths_with_restoration_refusals": sum(r["restoration_failures"] > 0 for r in rs),
            "restoration_failures_total": sum(r["restoration_failures"] for r in rs),
            "final_value_dominance_counterexamples": sum(not r["final_value_dominates"] for r in rs),
            "borrows": sum(r["borrows"] for r in rs),
            "lp_fees_world_a": sum(r["lp_fees_world_a"] for r in rs),
            "lp_idle_plus_premium_world_b": sum(r["lp_idle_fees_world_b"] + r["premium_paid"] for r in rs),
            "premium_shortfall_total": sum(r["shortfall"] for r in rs),
            "fee_apr_world_a_median": float(np.median([r["fee_apr_a"] for r in rs])) if rs else 0.0,
        }

    out = {}
    variants = list(dict.fromkeys(r["variant"] for r in rows))
    for kind in ("historical-price-driven", "synthetic-gbm"):
        for v in variants:
            out[f"{kind}/{v}"] = agg(lambda r, k=kind, vv=v: r["source"] == k and r["variant"] == vv)
    out["all"] = agg(lambda r: r["variant"] not in COMPARISON_ONLY)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="few paths, for CI")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--market", default=markets.DEFAULT, choices=sorted(markets.MARKETS))
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args(argv)
    mk = markets.get(args.market)
    spot, spot_source = markets.spot(mk)
    gbm_start = mk.gbm_start if mk.gbm_start is not None else spot
    base = SimParams.from_program(fee_rate=mk.fee_rate, bucket_width_ticks=mk.bucket_ticks)
    parity = program_parity(base)
    variants = {
        "base": base,
        "base+noise": replace(base, noise_volume_per_step=NOISE_PER_DAY),   # per day; scaled per step below
        "fully-funded": replace(base, budget_cap_prob=0.0, budget_notional_frac=1.0),
        "base+keeper": replace(base, keeper=True),
        # thin buffer and costly restoration swaps: shows where settlement is refused and delayed
        "stress-restoration": replace(base, restoration_buffer=0.0005, restore_cost_bps_mean=30.0,
                                      restore_cost_bps_max=120.0),
        "legacy-fee-model": replace(base, fee_model="legacy-every-price"),
    }
    paths = historical_paths(args.quick, mk) + synthetic_paths(args.quick, gbm_start)
    jobs = []
    for i, (pid, prices, step_s, source) in enumerate(paths):
        for variant, params in variants.items():
            noise = params.noise_volume_per_step * step_s / 86_400
            jobs.append((i, pid, prices, source, variant,
                         replace(params, step_seconds=step_s, noise_volume_per_step=noise)))
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        rows = list(ex.map(_run, jobs, chunksize=2))
    summary = summarize(rows)
    out_dir = args.out or HERE / "results" / markets.results_name(run_id(), mk)
    out_dir.mkdir(parents=True, exist_ok=True)
    params_dict = asdict(base)
    params_dict["curve"] = asdict(base.curve)
    (out_dir / "lp_guarantee.json").write_text(json.dumps({
        "benchmark": "lp_guarantee",
        "market": mk.to_dict(),
        "history": {"path": str(mk.history_path().relative_to(HERE)),
                    "manifest": str(markets.manifest_path(mk.symbol).relative_to(HERE)),
                    "label": f"Binance {mk.symbol} 1m bars"},
        "spot": spot, "spot_source": spot_source, "gbm_start": gbm_start,
        "claim": "Conditional on sufficient premium funding, idle fees plus premium paid >= fees from staying "
                 "in Orca under the measured-fee counterfactual, per borrowed range, over the whole time the "
                 "liquidity was out (including refused-restoration delays). Not an unconditional dominance claim.",
        "simulator": {"fee_model": base.fee_model, "noise_per_day_x_ladder_value": NOISE_PER_DAY,
                      "program_parity": parity, "comparison_only_variants": list(COMPARISON_ONLY),
                      "eligible": "fully funded; restorations always complete (refused ones are retried "
                                  f"after {base.restore_retry_s:.0f} s)"},
        "seed": SEED, "params": params_dict,
        "variants": {k: {f: getattr(v, f) for f in ("fee_model", "noise_volume_per_step", "budget_cap_prob",
                         "budget_notional_frac", "keeper", "restoration_buffer", "restore_cost_bps_mean",
                         "restore_cost_bps_max")} for k, v in variants.items()},
        "seconds": round(time.time() - t0, 1), "summary": summary, "paths": rows,
    }, indent=1) + "\n")
    lines = [f"# Benchmark 3: conditional LP guarantee ({mk.name})", "",
             f"Historical paths: Binance {mk.symbol} 1m bars. Synthetic GBM start {gbm_start:g}. "
             f"Pool fee {mk.fee_rate:.2%}. Program defaults read from programs/forge (parity checked). The pool "
             "follows the price outside the fee's no-arbitrage band; noise volume (base+noise) is "
             f"{NOISE_PER_DAY:g}x the LP ladder's value per day; base+keeper closes positions 5 min after accrued "
             "premium reaches 80% of the LP cap. legacy-fee-model (fee on every path point, the model of earlier "
             "runs) is shown for comparison and excluded from 'all'.", "",
             "Per borrow (the guarantee is per borrowed range): eligible = fully funded. Refused restorations "
             "are retried after 1 h with premium still accruing; they are counted, not dropped.", "",
             "| slice | borrows | eligible | guarantee holds | violations | premium shortfalls "
             "| restoration refusals | keeper closes | median fee APR (world A) |",
             "|---|---|---|---|---|---|---|---|---|"]
    for k, s in summary.items():
        lines.append(f"| {k} | {s['borrows']} | {s['borrows_eligible']} | {s['borrows_guarantee_holds']} | "
                     f"{s['borrows_guarantee_violations']} | {s['borrows_premium_shortfall']} | "
                     f"{s['restoration_failures_total']} | {s['keeper_closes']} | "
                     f"{s['fee_apr_world_a_median']:.1%} |")
    lines += ["", "Per path (all borrows on the path eligible):", "",
              "| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |",
              "|---|---|---|---|---|"]
    for k, s in summary.items():
        lines.append(f"| {k} | {s['paths']} | {s['eligible']} | {s['guarantee_holds_on_eligible']} | "
                     f"{s['final_value_dominance_counterexamples']} |")
    (out_dir / "lp_guarantee.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {out_dir}")
    viol = summary["all"]["guarantee_violations_on_eligible"]
    bviol = summary["all"]["borrows_guarantee_violations"]
    if viol or bviol:
        print(f"GUARANTEE VIOLATED: paths {viol}, borrows {bviol}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
