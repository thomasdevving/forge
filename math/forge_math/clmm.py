"""Real-valued concentrated-liquidity math (section 3.1 of the design).

Price P is quote per base (e.g. USDC per SOL), in human units. A range position with
liquidity L over [p_a, p_b] holds:

    P <= p_a:        x = L (1/sqrt(p_a) - 1/sqrt(p_b)),  y = 0
    p_a < P < p_b:   x = L (1/sqrt(P)   - 1/sqrt(p_b)),  y = L (sqrt(P) - sqrt(p_a))
    P >= p_b:        x = 0,                            y = L (sqrt(p_b) - sqrt(p_a))

and is worth V(P) = x P + y in quote. These functions are used by the compiler, the
simulations and the Greeks. On-chain token amounts use the exact integer port in
`forge_math.orca` instead; never mix the two for settlement.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike, NDArray

FloatArray = NDArray[np.float64]


def _check_range(p_a: float, p_b: float) -> None:
    if not (0.0 < p_a < p_b):
        raise ValueError(f"invalid range: need 0 < p_a < p_b, got [{p_a}, {p_b}]")


def token_amounts(L: float, P: ArrayLike, p_a: float, p_b: float) -> tuple[FloatArray, FloatArray]:
    """Base (x) and quote (y) amounts held by liquidity L in [p_a, p_b] at price(s) P."""
    _check_range(p_a, p_b)
    P = np.asarray(P, dtype=np.float64)
    if np.any(P <= 0):
        raise ValueError("prices must be positive")
    sa, sb = np.sqrt(p_a), np.sqrt(p_b)
    s = np.clip(np.sqrt(P), sa, sb)
    x = L * (1.0 / s - 1.0 / sb)
    y = L * (s - sa)
    return x, y


def value(L: float, P: ArrayLike, p_a: float, p_b: float) -> FloatArray:
    """Quote value V(P) = x P + y of liquidity L in [p_a, p_b]."""
    P = np.asarray(P, dtype=np.float64)
    x, y = token_amounts(L, P, p_a, p_b)
    return x * P + y


def unit_value(P: ArrayLike, p_a: float, p_b: float) -> FloatArray:
    """Value of one unit of liquidity in [p_a, p_b]; the basis function V_i of the compiler."""
    return value(1.0, P, p_a, p_b)


def unit_value_derivative(P: ArrayLike, p_a: float, p_b: float) -> FloatArray:
    """dV/dP for one unit of liquidity: equals the base amount x(P) (the position delta)."""
    x, _ = token_amounts(1.0, P, p_a, p_b)
    return x


def unit_value_second_derivative(P: ArrayLike, p_a: float, p_b: float) -> FloatArray:
    """d2V/dP2 for one unit of liquidity: -1/(2 P^1.5) strictly inside the range, else 0."""
    _check_range(p_a, p_b)
    P = np.asarray(P, dtype=np.float64)
    inside = (P > p_a) & (P < p_b)
    out = np.zeros_like(P)
    out[inside] = -0.5 * P[inside] ** -1.5
    return out


def max_quote(L: float, p_a: float, p_b: float) -> float:
    """Quote held when fully above the range: L (sqrt(p_b) - sqrt(p_a))."""
    _check_range(p_a, p_b)
    return L * (np.sqrt(p_b) - np.sqrt(p_a))


def max_base(L: float, p_a: float, p_b: float) -> float:
    """Base held when fully below the range: L (1/sqrt(p_a) - 1/sqrt(p_b))."""
    _check_range(p_a, p_b)
    return L * (1.0 / np.sqrt(p_a) - 1.0 / np.sqrt(p_b))


@dataclass(frozen=True)
class BorrowedRange:
    """A borrowed (negative-weight) range: removed tokens are escrowed at open."""

    L: float
    p_a: float
    p_b: float
    p_open: float

    def __post_init__(self) -> None:
        _check_range(self.p_a, self.p_b)
        if not (self.p_open < self.p_a or self.p_open > self.p_b):
            raise ValueError("borrowed ranges must be strictly out of range at open")

    @property
    def kind(self) -> str:
        return "put" if self.p_open > self.p_b else "call"

    def escrow(self) -> tuple[float, float]:
        """(base, quote) removed from the pool and escrowed at open."""
        x, y = token_amounts(self.L, self.p_open, self.p_a, self.p_b)
        return float(x), float(y)

    def payoff(self, P: ArrayLike) -> FloatArray:
        """Escrow value minus restoration cost at closing price P (frictionless model)."""
        P = np.asarray(P, dtype=np.float64)
        ex, ey = self.escrow()
        return ex * P + ey - value(self.L, P, self.p_a, self.p_b)
