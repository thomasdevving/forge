"""Independent exact replication-error verifier (section 7).

Separate implementation: no imports from the compiler or forge_math. Range prices are
recomputed from tick indices and liquidity from on-chain units.

On any interval with no target breakpoint and no range boundary inside it, the target is
linear and every leg is in one regime, so the error has the form

    e(S) = a + b S + c sqrt(S)

whose extremes lie at the interval endpoints or at the stationary point sqrt(S) = -c / (2 b).
The maximum of |e| over the domain is therefore computed exactly, not sampled.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class VLeg:
    kind: str            # borrow_put | borrow_call | provide_put | provide_call
    tick_lower: int
    tick_upper: int
    liquidity_onchain: int


@dataclass(frozen=True)
class VConstruction:
    cash: float
    base: float
    legs: tuple[VLeg, ...]
    base_decimals: int
    quote_decimals: int


def tick_to_price(tick: int, base_decimals: int, quote_decimals: int) -> float:
    return 1.0001 ** tick * 10 ** (base_decimals - quote_decimals)


def _leg_coeffs(leg: VLeg, s_mid: float, bd: int, qd: int) -> tuple[float, float, float]:
    """(A, B, K) so that the leg's payoff is A + B S + K sqrt(S) on the interval around s_mid."""
    L = leg.liquidity_onchain * 10 ** (-(bd + qd) / 2)
    pa = tick_to_price(leg.tick_lower, bd, qd)
    pb = tick_to_price(leg.tick_upper, bd, qd)
    ra, rb = math.sqrt(pa), math.sqrt(pb)
    x_full = L * (1 / ra - 1 / rb)
    y_full = L * (rb - ra)
    # V(S): below -> x_full S ; inside -> L(2 sqrt S - S/rb - ra) ; above -> y_full
    if s_mid <= pa:
        v = (0.0, x_full, 0.0)
    elif s_mid >= pb:
        v = (y_full, 0.0, 0.0)
    else:
        v = (-L * ra, -L / rb, 2 * L)
    if leg.kind.startswith("provide"):
        return v
    if leg.kind == "borrow_put":
        return (y_full - v[0], -v[1], -v[2])
    if leg.kind == "borrow_call":
        return (-v[0], x_full - v[1], -v[2])
    raise ValueError(f"unknown leg kind {leg.kind}")


@dataclass(frozen=True)
class ErrorBound:
    max_error: float          # exact max |f - fhat| over the domain (real arithmetic)
    at_price: float
    rounding_bound: float     # conservative allowance for Orca integer rounding
    certified_bound: float    # max_error + rounding_bound
    target_at: float
    construction_at: float


def construction_value(c: VConstruction, s: float) -> float:
    total = c.cash + c.base * s
    for leg in c.legs:
        a, b, k = _leg_coeffs(leg, s, c.base_decimals, c.quote_decimals)
        total += a + b * s + k * math.sqrt(s)
    return total


def _target(bps: list[tuple[float, float]], s: float) -> float:
    for (x0, y0), (x1, y1) in zip(bps, bps[1:]):
        if x0 <= s <= x1:
            return y0 + (y1 - y0) * (s - x0) / (x1 - x0)
    raise ValueError("price outside the target domain")


def max_error(target: list[tuple[float, float]], c: VConstruction) -> ErrorBound:
    bd, qd = c.base_decimals, c.quote_decimals
    lo, hi = target[0][0], target[-1][0]
    cuts = {x for x, _ in target}
    for leg in c.legs:
        for t in (leg.tick_lower, leg.tick_upper):
            p = tick_to_price(t, bd, qd)
            if lo < p < hi:
                cuts.add(p)
    pts = sorted(cuts)
    best = (-1.0, lo)
    for u, v in zip(pts, pts[1:]):
        mid = 0.5 * (u + v)
        A = B = K = 0.0
        A += c.cash
        B += c.base
        for leg in c.legs:
            a, b, k = _leg_coeffs(leg, mid, bd, qd)
            A, B, K = A + a, B + b, K + k
        fu, fv = _target(target, u), _target(target, v)
        beta = (fv - fu) / (v - u)
        alpha = fu - beta * u
        ea, eb, ec = alpha - A, beta - B, -K
        cand = [u, v]
        if eb != 0 and ec != 0:
            r = -ec / (2 * eb)
            if r > 0 and u < r * r < v:
                cand.append(r * r)
        for s in cand:
            e = abs(ea + eb * s + ec * math.sqrt(s))
            if e > best[0]:
                best = (e, s)
    err, at = best
    # Rounding: each leg's open and close CPIs round token amounts by at most 1 atom per token,
    # liquidity is integral, and the price grid is exact in Q64.64; bound conservatively.
    per_leg = 2 * hi * 10 ** (-bd) + 2 * 10 ** (-qd)
    float_slack = 1e-10 * max(1.0, max(abs(y) for _, y in target))
    rounding = len(c.legs) * per_leg + float_slack
    return ErrorBound(err, at, rounding, err + rounding, _target(target, at), construction_value(c, at))
