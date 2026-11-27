"""Benchmark 1: replication accuracy, baseline vs FORGE optimizer (section 12.2).

Realistic payoffs at varied levels and widths on a ts64 Whirlpool grid (bucket = 4 x 64 ticks,
about 2.6% wide); SOL/USDC by default, any market in benchmarks/markets.py with --market. For each
payoff and compiler: feasibility, certified max error from the independent verifier, legs, locked
capital and solve time. Every certificate's bound is checked against a dense out-of-sample
evaluation; a violation fails the run.

Market scaling (see markets.py): SOL/USDC keeps its pinned spot 73.23, 10 SOL units and raw
liquidity 4e13 (deep) / 6e10 (thin). Other markets use the last close of their Binance history as
spot, units and base holdings with the same USD notional, and raw liquidity with the same USD of
quote per bucket.

Usage: uv run python benchmarks/replication.py [--quick] [--out DIR] [--market JUP/USDC]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from forge_compiler import presets
from forge_compiler.baseline import compile_baseline
from forge_compiler.model import UserLimits, grid_for_market
from forge_compiler.optimizer import compile_optimizer
from forge_verifier.certificate import build_certificate, construction_from_dict, verify_certificate
from forge_verifier.exact import construction_value

sys.path.insert(0, str(Path(__file__).resolve().parent))
import markets  # noqa: E402
from lp_guarantee import run_id  # noqa: E402


def payoff_set(quick: bool, s: float, units: float):
    out = []
    for fl in (0.6, 0.7, 0.8, 0.9):
        out.append((f"protective_put/{fl}", presets.protective_put(units, fl * s, s)))
    for fl, cap in ((0.75, 1.15), (0.75, 1.3), (0.85, 1.15), (0.85, 1.3)):
        out.append((f"collar/{fl}-{cap}", presets.collar(units, fl * s, cap * s, s)))
    for up, low in ((0.9, 0.75), (0.85, 0.65), (0.92, 0.8)):
        out.append((f"put_spread/{up}-{low}", presets.put_spread(units, up * s, low * s, s)))
    for low, up in ((1.1, 1.3), (1.2, 1.45), (1.08, 1.2)):
        out.append((f"call_spread/{low}-{up}", presets.call_spread(units / 2, low * s, up * s, s)))
    for k in (1.0, 0.9, 1.1):
        out.append((f"straddle/{k}", presets.straddle(units, k * s, s)))
    for p, c in ((0.85, 1.15), (0.75, 1.3), (0.9, 1.1)):
        out.append((f"strangle/{p}-{c}", presets.strangle(units, p * s, c * s, s)))
    for lo, mid, hi in ((1.1, 1.2, 1.3), (1.05, 1.15, 1.25), (1.15, 1.3, 1.45)):
        out.append((f"butterfly/{lo}-{mid}-{hi}", presets.butterfly(units / 4, lo * s, mid * s, hi * s, s)))
    return out[::3] if quick else out


def dense_error(cert: dict, payoff, n: int = 20_000) -> float:
    m = cert["market"]
    vc = construction_from_dict(cert["construction"], m["base_decimals"], m["quote_decimals"])
    lo, hi = payoff.domain
    rng = np.random.default_rng(7)
    s = np.concatenate([np.linspace(lo, hi, n), rng.uniform(lo, hi, n)])
    f = payoff(s)
    return max(abs(construction_value(vc, float(x)) - float(y)) for x, y in zip(s, f))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--market", default=markets.DEFAULT, choices=sorted(markets.MARKETS))
    args = ap.parse_args(argv)
    mk = markets.get(args.market)
    spot, spot_source = markets.spot(mk)
    scale = markets.notional_scale(mk)
    units = markets.REF_UNITS * scale
    liquidity = markets.liquidity_raw(mk)
    bd, qd = mk.base_decimals, mk.quote_decimals
    limits = UserLimits(base_holdings=markets.REF_BASE_HOLDINGS * scale, quote_holdings=5_000.0,
                        premium_budget=25.0, max_legs=8)
    rows, violations = [], []
    t_all = time.time()
    ts, mult = mk.tick_spacing, mk.bucket_multiplier
    for liq_name, liq in liquidity.items():
        g0 = grid_for_market(spot, ts, mult, 14, base_decimals=bd, quote_decimals=qd)
        grid = grid_for_market(spot, ts, mult, 14, borrowable={b.tick_lower: liq for b in g0.buckets},
                               base_decimals=bd, quote_decimals=qd)
        for name, payoff in payoff_set(args.quick, spot, units):
            for method, fn in (("baseline", compile_baseline), ("optimizer", compile_optimizer)):
                res = fn(payoff, grid, limits)
                row = {"payoff": name, "liquidity": liq_name, "method": method, "status": res.status,
                       "reasons": res.reasons, "solve_seconds": res.solve_seconds,
                       "tolerance": payoff.default_tolerance(), "notional": payoff.notional_scale()}
                if res.construction is not None and res.construction.legs:
                    cert = build_certificate(
                        market={"whirlpool": mk.label, "base_decimals": bd, "quote_decimals": qd, "spot": spot},
                        target=list(payoff.breakpoints), construction=res.construction.to_dict(),
                        premium_budget=limits.premium_budget, liquidity_check=[])
                    assert verify_certificate(cert)
                    dense = dense_error(cert, payoff)
                    bound = cert["error"]["certified_bound"]
                    if dense > bound + 1e-9:
                        violations.append((name, liq_name, method, dense, bound))
                    row.update(certified_bound=bound, relative_error=bound / payoff.notional_scale(),
                               dense_error=dense, legs=len(res.construction.legs),
                               capital_locked=res.construction.capital_locked, certificate_hash=cert["hash"])
                rows.append(row)

    def stats(method, liq):
        rs = [r for r in rows if r["method"] == method and r["liquidity"] == liq]
        ok = [r for r in rs if r["status"] == "ok"]
        errs = [r["relative_error"] for r in ok]
        return {
            "payoffs": len(rs),
            "feasible": len(ok),
            "feasibility_rate": len(ok) / max(1, len(rs)),
            "median_relative_error_bps": float(np.median(errs) * 1e4) if errs else None,
            "max_relative_error_bps": float(np.max(errs) * 1e4) if errs else None,
            "mean_legs": float(np.mean([r["legs"] for r in ok])) if ok else None,
            "mean_solve_ms": float(np.mean([r["solve_seconds"] for r in rs]) * 1e3),
        }

    summary = {f"{m}/{liq}": stats(m, liq) for liq in liquidity for m in ("baseline", "optimizer")}
    out_dir = args.out or Path(__file__).resolve().parent / "results" / markets.results_name(run_id(), mk)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "replication.json").write_text(json.dumps({
        "benchmark": "replication", "market": mk.to_dict(), "spot": spot, "spot_source": spot_source,
        "units": units, "grid": f"{mk.label}, bucket {mk.bucket_ticks} ticks",
        "sizing": "units and base holdings carry the SOL/USDC reference USD notional "
                  f"({markets.REF_UNITS:g} SOL at {markets.MARKETS[markets.REF].pinned_spot}); liquidity "
                  "scenarios carry the same USD of quote in the bucket just below spot",
        "limits": limits.__dict__, "liquidity_scenarios": liquidity,
        "liquidity_usd_per_bucket": markets.liquidity_usd(), "summary": summary,
        "bound_violations": violations, "rows": rows, "seconds": round(time.time() - t_all, 1),
    }, indent=1) + "\n")
    lines = [f"# Benchmark 1: replication accuracy ({mk.name})", "",
             f"Spot {spot:g} ({spot_source}); payoff units {units:.6g} {mk.base}; borrowable liquidity "
             + ", ".join(f"{k} {v} raw L (~${u:,.0f} quote per bucket)"
                         for (k, v), u in zip(liquidity.items(), markets.liquidity_usd().values())) + ".", "",
             "| method / liquidity | payoffs | feasible | median error (bps of notional) | max error (bps) "
             "| mean legs | mean solve (ms) |", "|---|---|---|---|---|---|---|"]
    for k, s in summary.items():
        fmt = lambda v, d=1: "-" if v is None else f"{v:.{d}f}"  # noqa: E731
        lines.append(f"| {k} | {s['payoffs']} | {s['feasible']} | {fmt(s['median_relative_error_bps'])} | "
                     f"{fmt(s['max_relative_error_bps'])} | {fmt(s['mean_legs'])} | {fmt(s['mean_solve_ms'])} |")
    lines += ["", f"Certificate bound violations on dense checks: {len(violations)}"]
    (out_dir / "replication.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {out_dir}")
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
