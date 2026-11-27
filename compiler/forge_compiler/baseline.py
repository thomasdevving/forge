"""Baseline compiler: direct replication at the nearest allowed range around each kink.

For each kink with slope change ds at price K, take the grid bucket containing K and size one
leg so its slope change across the bucket equals ds (a range's base exposure changes by
x_full = L (1/sqrt(pa) - 1/sqrt(pb)) across it):

* convex kink (ds > 0)  -> borrowed range (long put below spot, long call above)
* concave kink (ds < 0) -> provided range (cash-secured put below, covered call above)

Cash and base are then fitted by a small LP (minimax over the grid within the holdings). The
baseline exists so the benchmark can show whether the optimizer is needed.
"""

from __future__ import annotations

import time

import numpy as np
from scipy.optimize import linprog

from forge_compiler.basis import Candidate, evaluation_grid
from forge_compiler.build import build_construction, construction_payoff
from forge_compiler.model import CompileResult, MarketGrid, Payoff, UserLimits


def compile_baseline(payoff: Payoff, grid: MarketGrid, limits: UserLimits,
                     tolerance: float | None = None, n_grid: int = 600) -> CompileResult:
    t0 = time.perf_counter()
    reasons: list[str] = []
    chosen: list[tuple[Candidate, float]] = []
    for k, ds in payoff.kinks():
        b = next((b for b in grid.buckets if b.price_lower <= k < b.price_upper), None)
        if b is None:
            reasons.append(f"kink at {k:g} is outside the bucket grid")
            continue
        side = grid.side(b)
        if side is None:
            reasons.append(f"kink at {k:g} lies in the range containing the current price")
            continue
        if ds > 0:
            kind = "borrow_put" if side == "below" else "borrow_call"
        else:
            kind = "provide_put" if side == "below" else "provide_call"
        cand = Candidate(b, kind)
        liq = abs(ds) / cand.x_full
        if kind.startswith("borrow"):
            avail = b.borrowable_liquidity * grid.liquidity_scale
            if liq > avail:
                reasons.append(f"kink at {k:g} needs more borrowable liquidity than the bucket has")
                liq = avail
        chosen.append((cand, liq))
    if len(chosen) > limits.max_legs:
        reasons.append(f"{len(chosen)} kinks exceed the leg limit ({limits.max_legs})")
        chosen = sorted(chosen, key=lambda t: -t[1] * t[0].x_full)[: limits.max_legs]

    lo, hi = payoff.domain
    edges = [b.price_lower for b in grid.buckets] + [b.price_upper for b in grid.buckets]
    S = evaluation_grid(lo, hi, [b[0] for b in payoff.breakpoints] + edges, n_grid)
    f = payoff(S)
    tol = tolerance if tolerance is not None else payoff.default_tolerance()
    legs_only = build_construction(grid, 0.0, 0.0, chosen)
    by_kind = {(c.bucket.tick_lower, c.kind): c for c, _ in chosen}
    g = construction_payoff(legs_only, S, by_kind)
    # quote/base already consumed by the legs
    used_q = legs_only.provided_quote + legs_only.buffer_quote
    used_b = legs_only.provided_base + legs_only.buffer_base
    q_cap = limits.quote_holdings - limits.premium_budget - used_q
    b_cap = limits.base_holdings - used_b
    if q_cap < 0 or b_cap < 0:
        reasons.append("holdings do not cover the provided legs and buffers")
        return CompileResult("infeasible", "baseline", legs_only, float("inf"), reasons, None,
                             time.perf_counter() - t0)
    # minimize eps s.t. |f - g - c - d S| <= eps, 0 <= c <= q_cap, 0 <= d <= b_cap
    A = np.vstack([np.column_stack([-np.ones_like(S), -S, -np.ones_like(S)]),
                   np.column_stack([np.ones_like(S), S, -np.ones_like(S)])])
    bvec = np.concatenate([-(f - g), f - g])
    lp = linprog([0, 0, 1], A_ub=A, b_ub=bvec, bounds=[(0, q_cap), (0, b_cap), (0, None)], method="highs")
    cash, base = (float(lp.x[0]), float(lp.x[1])) if lp.success else (0.0, 0.0)
    construction = build_construction(grid, cash, base, chosen)
    fhat = construction_payoff(construction, S, by_kind)
    err = float(np.max(np.abs(fhat - f)))
    status = "ok" if err <= tol and not reasons else "infeasible"
    closest = None if status == "ok" else [(float(s), float(v)) for s, v in zip(S[::10], fhat[::10])]
    return CompileResult(status, "baseline", construction, err, reasons, closest, time.perf_counter() - t0)
