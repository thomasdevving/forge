"""Realistic payoff presets: the gross value of the user's position at a closing price S.

Gross value includes everything the construction holds. In FORGE a short option is never naked:
a short put is a cash-secured put (the user posts quote, which buys base on the way down) and a
short call is a covered call (the user posts base). So presets with short legs include that
collateral, e.g. a put spread on 10 SOL is worth 10 S + 10 max(K1 - S, 0) + 10 min(S, K2).
Long legs carry no collateral beyond the restoration buffer. Domains extend past every kink.
"""

from __future__ import annotations

from forge_compiler.model import Payoff


def _domain(spot: float, kinks: list[float], lo_mult: float = 0.55, hi_mult: float = 1.6) -> tuple[float, float]:
    return min(spot * lo_mult, min(kinks) * 0.85), max(spot * hi_mult, max(kinks) * 1.15)


def protective_put(units: float, floor: float, spot: float) -> Payoff:
    lo, hi = _domain(spot, [floor])
    return Payoff(((lo, units * floor), (floor, units * floor), (hi, units * hi)))


def collar(units: float, floor: float, cap: float, spot: float) -> Payoff:
    lo, hi = _domain(spot, [floor, cap])
    return Payoff(((lo, units * floor), (floor, units * floor), (cap, units * cap), (hi, units * cap)))


def put_spread(units: float, upper: float, lower: float, spot: float) -> Payoff:
    """Held units + long put at `upper` + cash-secured short put at `lower`:
    units S + units max(upper - S, 0) + units min(S, lower)."""
    lo, hi = _domain(spot, [lower, upper])

    def f(s: float) -> float:
        return units * s + units * max(upper - s, 0.0) + units * min(s, lower)

    return Payoff(tuple((x, f(x)) for x in (lo, lower, upper, hi)))


def call_spread(units: float, lower: float, upper: float, spot: float) -> Payoff:
    """Long call at `lower` + covered short call at `upper` (base posted):
    units max(S - lower, 0) + units min(S, upper)."""
    lo, hi = _domain(spot, [lower, upper])

    def f(s: float) -> float:
        return units * max(s - lower, 0.0) + units * min(s, upper)

    return Payoff(tuple((x, f(x)) for x in (lo, lower, upper, hi)))


def straddle(units: float, strike: float, spot: float) -> Payoff:
    lo, hi = _domain(spot, [strike])
    return Payoff(((lo, units * (strike - lo)), (strike, 0.0), (hi, units * (hi - strike))))


def strangle(units: float, put_strike: float, call_strike: float, spot: float) -> Payoff:
    lo, hi = _domain(spot, [put_strike, call_strike])
    return Payoff(((lo, units * (put_strike - lo)), (put_strike, 0.0), (call_strike, 0.0),
                   (hi, units * (hi - call_strike))))


def butterfly(units: float, low: float, mid: float, high: float, spot: float) -> Payoff:
    """Call butterfly with the two short calls covered by 2 units of base."""
    lo, hi = _domain(spot, [low, high])

    def f(s: float) -> float:
        return (units * max(s - low, 0.0) - 2 * units * max(s - mid, 0.0) + units * max(s - high, 0.0)
                + 2 * units * s)

    return Payoff(tuple((x, f(x)) for x in (lo, low, mid, high, hi)))
