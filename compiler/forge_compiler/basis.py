"""Normalized basis functions for candidate legs (section 6.2).

Each candidate (bucket, kind) gets a payoff per unit of *notional at spot* (quote), which keeps
the MILP well conditioned regardless of raw liquidity scale:

* provide_put  (bucket below spot): user deposits quote; payoff V(S)
* borrow_put   (below spot): quote escrow y_full; payoff y_full - V(S)        (long put)
* provide_call (above spot): user deposits base; payoff V(S)
* borrow_call  (above spot): base escrow x_full; payoff x_full * S - V(S)     (long call)

Borrowed legs fold their escrow into the payoff (quote escrow behaves like cash, base escrow
like held base), as section 6.2 requires.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from forge_compiler.model import GridBucket, LegKind, MarketGrid
from forge_math.clmm import unit_value


@dataclass(frozen=True)
class Candidate:
    bucket: GridBucket
    kind: LegKind

    @property
    def x_full(self) -> float:  # base per unit L across the whole range
        return 1 / self.bucket.sqrt_lower - 1 / self.bucket.sqrt_upper

    @property
    def y_full(self) -> float:  # quote per unit L across the whole range
        return self.bucket.sqrt_upper - self.bucket.sqrt_lower

    def notional_per_liquidity(self, spot: float) -> float:
        """Quote value at spot of the tokens one unit of liquidity holds (single-sided)."""
        return self.y_full if self.kind in ("provide_put", "borrow_put") else self.x_full * spot

    def payoff_per_liquidity(self, s: np.ndarray) -> np.ndarray:
        v = unit_value(s, self.bucket.price_lower, self.bucket.price_upper)
        if self.kind in ("provide_put", "provide_call"):
            return v
        if self.kind == "borrow_put":
            return self.y_full - v
        return self.x_full * s - v

    def payoff_per_notional(self, s: np.ndarray, spot: float) -> np.ndarray:
        return self.payoff_per_liquidity(s) / self.notional_per_liquidity(spot)


def candidates(grid: MarketGrid) -> list[Candidate]:
    """All admissible (bucket, kind) pairs under the out-of-range rules (section 3.3)."""
    out = []
    for b in grid.buckets:
        side = grid.side(b)
        if side == "below":
            out.append(Candidate(b, "provide_put"))
            if b.borrowable_liquidity > 0:
                out.append(Candidate(b, "borrow_put"))
        elif side == "above":
            out.append(Candidate(b, "provide_call"))
            if b.borrowable_liquidity > 0:
                out.append(Candidate(b, "borrow_call"))
    return out


def evaluation_grid(lo: float, hi: float, extra: list[float], n: int = 600) -> np.ndarray:
    pts = np.concatenate([np.linspace(lo, hi, n), [x for x in extra if lo <= x <= hi]])
    return np.unique(pts)
