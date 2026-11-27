"""FORGE optimizer: constrained minimax MILP solved with HiGHS (section 6.3).

    minimize   eps + lambda * sum(z)
    subject to |f(S_j) - (c + d S_j + sum_i q_i phi_i(S_j))| <= eps      for every grid S_j
               quote:  c + sum(provide_put q) + buffer * sum(borrow_put q) <= H_q - premium
               base:   d S0 + sum(provide_call q) + buffer * sum(borrow_call q) <= H_b S0
               borrow: q_i <= available notional of bucket i (utilization cap applied)
               legs:   q_i <= M_i z_i,  sum(z) <= max_legs,  z binary
               0 <= c <= H_q, 0 <= d <= H_b, q >= 0

q_i is notional at spot in quote, phi_i the per-notional payoff, so the problem is scale free.
No naked shorts: every leg is either the user's own funded liquidity or a borrowed range whose
removed tokens are escrowed.
"""

from __future__ import annotations

import time

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

from forge_compiler.basis import candidates, evaluation_grid
from forge_compiler.build import build_construction, construction_payoff
from forge_compiler.model import CompileResult, MarketGrid, Payoff, UserLimits


def _diagnose(payoff: Payoff, grid: MarketGrid, limits: UserLimits, sol, cands, quote_row, base_row,
              avail) -> list[str]:
    reasons = []
    spot_bucket = next((b for b in grid.buckets if grid.side(b) is None), None)
    if spot_bucket:
        for k, ds in payoff.kinks():
            if spot_bucket.price_lower <= k <= spot_bucket.price_upper:
                reasons.append(f"kink at {k:g} lies in the range containing the current price; "
                               "borrowed and provided ranges must be strictly out of range")
    lo, hi = payoff.domain
    if sol is None:
        return reasons or ["solver found no feasible construction"]
    x = sol
    if quote_row @ x >= limits.quote_holdings - limits.premium_budget - 1e-6 * max(1, limits.quote_holdings):
        reasons.append("quote holdings (after the premium budget) are fully used")
    if base_row @ x >= limits.base_holdings * grid.spot * (1 - 1e-6):
        reasons.append("base holdings are fully used")
    nz = int(sum(x[3 + len(cands) + i] > 0.5 for i in range(len(cands))))
    if nz >= limits.max_legs:
        reasons.append(f"leg limit ({limits.max_legs}) reached")
    for i, c in enumerate(cands):
        if c.kind.startswith("borrow") and avail[i] > 0 and x[3 + i] >= avail[i] * (1 - 1e-6):
            reasons.append(f"borrowable liquidity exhausted in [{c.bucket.price_lower:.4g}, "
                           f"{c.bucket.price_upper:.4g}]")
    if not reasons:
        reasons.append("the payoff cannot be matched within tolerance by out-of-range ranges on this grid")
    return reasons


def compile_optimizer(payoff: Payoff, grid: MarketGrid, limits: UserLimits, tolerance: float | None = None,
                      n_grid: int = 600, time_limit: float = 20.0) -> CompileResult:
    t0 = time.perf_counter()
    lo, hi = payoff.domain
    cands = candidates(grid)
    edges = [b.price_lower for b in grid.buckets] + [b.price_upper for b in grid.buckets]
    S = evaluation_grid(lo, hi, [b[0] for b in payoff.breakpoints] + edges, n_grid)
    f = payoff(S)
    scale = max(1.0, float(np.max(np.abs(f))))
    tol = tolerance if tolerance is not None else payoff.default_tolerance()
    n = len(cands)
    # variables: [c, d, eps, q_1..q_n, z_1..z_n]
    nv = 3 + 2 * n
    Phi = np.column_stack([c.payoff_per_notional(S, grid.spot) for c in cands]) if n else np.zeros((len(S), 0))

    rows, lb, ub = [], [], []
    # f - fhat <= eps  ->  -c - d S - Phi q - eps <= -f
    A1 = np.zeros((len(S), nv))
    A1[:, 0], A1[:, 1], A1[:, 2] = -1.0, -S, -1.0
    A1[:, 3:3 + n] = -Phi
    rows.append(A1)
    lb.append(np.full(len(S), -np.inf))
    ub.append(-f)
    # fhat - f <= eps  ->  c + d S + Phi q - eps <= f
    A2 = np.zeros((len(S), nv))
    A2[:, 0], A2[:, 1], A2[:, 2] = 1.0, S, -1.0
    A2[:, 3:3 + n] = Phi
    rows.append(A2)
    lb.append(np.full(len(S), -np.inf))
    ub.append(f)

    buf = grid.restoration_buffer_bps / 10_000
    quote_row = np.zeros(nv)
    quote_row[0] = 1.0
    base_row = np.zeros(nv)
    base_row[1] = grid.spot
    avail = np.zeros(n)
    big = np.zeros(n)
    capital = limits.quote_holdings + limits.base_holdings * grid.spot
    for i, c in enumerate(cands):
        if c.kind == "provide_put":
            quote_row[3 + i] = 1.0
        elif c.kind == "borrow_put":
            quote_row[3 + i] = buf
        elif c.kind == "provide_call":
            base_row[3 + i] = 1.0
        else:
            base_row[3 + i] = buf
        if c.kind.startswith("borrow"):
            avail[i] = c.bucket.borrowable_liquidity * grid.liquidity_scale * c.notional_per_liquidity(grid.spot)
            big[i] = avail[i]
        else:
            big[i] = capital
    rows.append(quote_row[None, :])
    lb.append([-np.inf])
    ub.append([max(0.0, limits.quote_holdings - limits.premium_budget)])
    rows.append(base_row[None, :])
    lb.append([-np.inf])
    ub.append([limits.base_holdings * grid.spot])
    # q_i - M_i z_i <= 0
    if n:
        Az = np.zeros((n, nv))
        for i in range(n):
            Az[i, 3 + i] = 1.0
            Az[i, 3 + n + i] = -big[i]
        rows.append(Az)
        lb.append(np.full(n, -np.inf))
        ub.append(np.zeros(n))
        cnt = np.zeros((1, nv))
        cnt[0, 3 + n:] = 1.0
        rows.append(cnt)
        lb.append([-np.inf])
        ub.append([limits.max_legs])

    A = np.vstack(rows)
    lo_b = np.zeros(nv)
    hi_b = np.full(nv, np.inf)
    hi_b[0] = limits.quote_holdings
    hi_b[1] = limits.base_holdings
    hi_b[3:3 + n] = np.maximum(big, 0.0)
    hi_b[3 + n:] = 1.0
    integrality = np.zeros(nv)
    integrality[3 + n:] = 1
    cost = np.zeros(nv)
    cost[2] = 1.0
    cost[3 + n:] = 1e-5 * scale  # prefer fewer legs at equal error
    res = milp(cost, constraints=LinearConstraint(A, np.concatenate(lb), np.concatenate(ub)),
               integrality=integrality, bounds=Bounds(lo_b, hi_b),
               options={"time_limit": time_limit, "mip_rel_gap": 1e-4, "disp": False})
    if res.x is None:
        return CompileResult("infeasible", "optimizer", None, float("inf"),
                             _diagnose(payoff, grid, limits, None, cands, quote_row, base_row, avail),
                             None, time.perf_counter() - t0)
    x = res.x
    chosen = []
    for i, c in enumerate(cands):
        q = x[3 + i]
        if x[3 + n + i] > 0.5 and q > 1e-9 * scale:
            chosen.append((c, q / c.notional_per_liquidity(grid.spot)))
    construction = build_construction(grid, float(x[0]), float(x[1]), chosen)
    by_kind = {(c.bucket.tick_lower, c.kind): c for c in cands}
    fhat = construction_payoff(construction, S, by_kind)
    err = float(np.max(np.abs(fhat - f)))
    status = "ok" if err <= tol else "infeasible"
    reasons = [] if status == "ok" else _diagnose(payoff, grid, limits, x, cands, quote_row, base_row, avail)
    closest = None if status == "ok" else [(float(s), float(v)) for s, v in zip(S[::10], fhat[::10])]
    return CompileResult(status, "optimizer", construction, err, reasons, closest, time.perf_counter() - t0)
