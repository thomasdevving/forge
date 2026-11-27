"""Benchmark 3: the conditional LP guarantee (sections 4.6, 12.4).

Paired simulation over historical and synthetic SOL/USDC paths. Historical inputs are Binance
SOL/USDC 1-minute bars (benchmarks/data/manifest.json); they drive a controlled pool
simulation (arbitrage to each price plus optional noise volume) and are labelled
"historical-price-driven", not a replay of Orca swaps. OHLC bars do not record intra-bar
order, so every window runs with both high-first and low-first orderings.

Every path is reported, including ineligible ones (premium shortfall or restoration failure)
and counterexamples to final-value dominance. Nothing is filtered.

Usage: uv run python benchmarks/lp_guarantee.py [--quick] [--out DIR]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from forge_math.lpsim import SimParams, gbm_path, ohlc_path, simulate_path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data" / "SOLUSDC-1m.npz"
WINDOW_MINUTES = 7 * 24 * 60
SEED = 20261127


def run_id() -> str:
    sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                         cwd=HERE).stdout.strip() or "nogit"
    return f"{datetime.now(UTC):%Y%m%d-%H%M%S}-{sha}"


def historical_paths(quick: bool):
    if not DATA.exists():
        print("missing price data: run benchmarks/fetch_history.py first", file=sys.stderr)
        return []
    d = np.load(DATA)
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


def synthetic_paths(quick: bool):
    out = []
    seeds = 3 if quick else 20
    for vol in (0.5, 0.9, 1.4):
        for i in range(seeds):
            s = SEED + int(vol * 1000) + i
            out.append((f"gbm-vol{vol}-s{s}", gbm_path(70.0, WINDOW_MINUTES, vol, seed=s), 60.0,
                        "synthetic-gbm"))
    return out


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
            "eligible": len(elig),
            "guarantee_holds_on_eligible": sum(r["guarantee_holds"] for r in elig),
            "guarantee_violations_on_eligible": [r["path_id"] for r in elig if not r["guarantee_holds"]],
            "ineligible_shortfall": sum(r["shortfall"] > 0 for r in rs),
            "ineligible_restoration_failure": sum(r["restoration_failures"] > 0 for r in rs),
            "restoration_failures_total": sum(r["restoration_failures"] for r in rs),
            "final_value_dominance_counterexamples": sum(not r["final_value_dominates"] for r in rs),
            "borrows": sum(r["borrows"] for r in rs),
            "lp_fees_world_a": sum(r["lp_fees_world_a"] for r in rs),
            "lp_idle_plus_premium_world_b": sum(r["lp_idle_fees_world_b"] + r["premium_paid"] for r in rs),
            "premium_shortfall_total": sum(r["shortfall"] for r in rs),
        }

    out = {}
    variants = list(dict.fromkeys(r["variant"] for r in rows))
    for kind in ("historical-price-driven", "synthetic-gbm"):
        for v in variants:
            out[f"{kind}/{v}"] = agg(lambda r, k=kind, vv=v: r["source"] == k and r["variant"] == vv)
    out["all"] = agg(lambda r: True)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="few paths, for CI")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    base = SimParams()
    variants = {
        "base": base,
        "base+noise": replace(base, noise_volume_per_step=0.0005),
        "fully-funded": replace(base, budget_cap_prob=0.0, budget_notional_frac=1.0),
        # thin buffer and costly restoration swaps: shows where settlement is blocked
        "stress-restoration": replace(base, restoration_buffer=0.0005, restore_cost_bps_mean=30.0,
                                      restore_cost_bps_max=120.0),
    }
    paths = historical_paths(args.quick) + synthetic_paths(args.quick)
    rows = []
    t0 = time.time()
    for i, (pid, prices, step_s, source) in enumerate(paths):
        for variant, params in variants.items():
            r = simulate_path(prices, replace(params, step_seconds=step_s), seed=SEED + i, path_id=pid)
            d = r.to_dict()
            d.update(source=source, variant=variant)
            rows.append({k: (v.item() if isinstance(v, np.generic) else v) for k, v in d.items()})
    summary = summarize(rows)
    out_dir = args.out or HERE / "results" / run_id()
    out_dir.mkdir(parents=True, exist_ok=True)
    params_dict = asdict(base)
    params_dict["curve"] = asdict(base.curve)
    (out_dir / "lp_guarantee.json").write_text(json.dumps({
        "benchmark": "lp_guarantee",
        "claim": "Conditional on successful restoration and sufficient premium funding, idle fees "
                 "plus premium paid >= fees from staying in Orca under the measured-fee "
                 "counterfactual. Not an unconditional dominance claim.",
        "seed": SEED, "params": params_dict,
        "variants": {k: {f: getattr(v, f) for f in ("noise_volume_per_step", "budget_cap_prob",
                         "budget_notional_frac", "restoration_buffer", "restore_cost_bps_mean",
                         "restore_cost_bps_max")} for k, v in variants.items()},
        "seconds": round(time.time() - t0, 1), "summary": summary, "paths": rows,
    }, indent=1) + "\n")
    lines = ["# Benchmark 3: conditional LP guarantee", "",
             "Per borrow (the guarantee is per borrowed range): eligible = restored and fully funded.", "",
             "| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration failures |",
             "|---|---|---|---|---|---|---|"]
    for k, s in summary.items():
        lines.append(f"| {k} | {s['borrows']} | {s['borrows_eligible']} | {s['borrows_guarantee_holds']} | "
                     f"{s['borrows_guarantee_violations']} | {s['borrows_premium_shortfall']} | "
                     f"{s['restoration_failures_total']} |")
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
