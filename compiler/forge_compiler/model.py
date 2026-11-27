"""Compiler input/output types (section 6). Prices are human units (quote per base)."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Literal

LegKind = Literal["borrow_put", "borrow_call", "provide_put", "provide_call"]


@dataclass(frozen=True)
class Payoff:
    """Piecewise-linear target f(S) given by breakpoints over [S_min, S_max]."""

    breakpoints: tuple[tuple[float, float], ...]

    def __post_init__(self) -> None:
        xs = [b[0] for b in self.breakpoints]
        if len(xs) < 2 or any(x <= 0 for x in xs) or any(b >= a for a, b in zip(xs[1:], xs)):
            raise ValueError("breakpoints need >= 2 strictly increasing positive prices")

    @property
    def domain(self) -> tuple[float, float]:
        return self.breakpoints[0][0], self.breakpoints[-1][0]

    def __call__(self, s):
        import numpy as np

        xs, ys = zip(*self.breakpoints)
        return np.interp(s, xs, ys)

    def notional_scale(self) -> float:
        """Scale for relative tolerances: max(|f|, sum over kinks of |slope change| x strike)."""
        import numpy as np

        _, ys = zip(*self.breakpoints)
        return max(1.0, float(np.max(np.abs(ys))), sum(abs(ds) * k for k, ds in self.kinks()))

    def default_tolerance(self) -> float:
        """Default replication tolerance: 1% of notional. Users may set their own."""
        return 0.01 * self.notional_scale()

    def kinks(self) -> list[tuple[float, float]]:
        """(price, slope change) at every interior breakpoint where the slope changes."""
        out = []
        b = self.breakpoints
        for i in range(1, len(b) - 1):
            s0 = (b[i][1] - b[i - 1][1]) / (b[i][0] - b[i - 1][0])
            s1 = (b[i + 1][1] - b[i][1]) / (b[i + 1][0] - b[i][0])
            if abs(s1 - s0) > 1e-12:
                out.append((b[i][0], s1 - s0))
        return out


@dataclass(frozen=True)
class GridBucket:
    tick_lower: int
    tick_upper: int
    price_lower: float
    price_upper: float
    borrowable_liquidity: int  # on-chain liquidity units available to borrow (cap applied)

    @property
    def sqrt_lower(self) -> float:
        return math.sqrt(self.price_lower)

    @property
    def sqrt_upper(self) -> float:
        return math.sqrt(self.price_upper)


@dataclass(frozen=True)
class MarketGrid:
    spot: float
    buckets: tuple[GridBucket, ...]
    base_decimals: int = 9
    quote_decimals: int = 6
    restoration_buffer_bps: int = 200
    floor_rate_bps: int = 500

    @property
    def liquidity_scale(self) -> float:
        """Human liquidity per on-chain liquidity unit: 10^-((base_dec + quote_dec) / 2)."""
        return 10 ** (-(self.base_decimals + self.quote_decimals) / 2)

    def side(self, b: GridBucket) -> str | None:
        if b.price_upper < self.spot:
            return "below"
        if b.price_lower > self.spot:
            return "above"
        return None  # contains spot: never used for a new leg


@dataclass(frozen=True)
class UserLimits:
    base_holdings: float
    quote_holdings: float
    premium_budget: float
    max_legs: int = 8


@dataclass(frozen=True)
class Leg:
    kind: LegKind
    tick_lower: int
    tick_upper: int
    price_lower: float
    price_upper: float
    liquidity: float          # human units
    liquidity_onchain: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Construction:
    cash: float               # free quote held by the construction
    base: float               # free base held (user's own, excludes escrow)
    legs: tuple[Leg, ...]
    spot: float
    escrow_quote: float       # removed quote from borrowed put legs
    escrow_base: float        # removed base from borrowed call legs
    buffer_quote: float
    buffer_base: float
    provided_quote: float
    provided_base: float

    @property
    def capital_locked(self) -> float:
        """User capital at spot: cash, base, provided liquidity and restoration buffers."""
        return (self.cash + self.base * self.spot + self.provided_quote + self.provided_base * self.spot
                + self.buffer_quote + self.buffer_base * self.spot)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["legs"] = [leg.to_dict() for leg in self.legs]
        d["capital_locked"] = self.capital_locked
        return d


@dataclass
class CompileResult:
    status: Literal["ok", "infeasible"]
    method: Literal["baseline", "optimizer"]
    construction: Construction | None
    sampled_max_error: float
    reasons: list[str] = field(default_factory=list)
    closest_feasible: list[tuple[float, float]] | None = None
    solve_seconds: float = 0.0

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "method": self.method,
            "construction": self.construction.to_dict() if self.construction else None,
            "sampled_max_error": self.sampled_max_error,
            "reasons": self.reasons,
            "closest_feasible": self.closest_feasible,
            "solve_seconds": self.solve_seconds,
        }


def grid_for_market(spot: float, tick_spacing: int, bucket_multiplier: int, n_each_side: int,
                    borrowable: dict[int, int] | None = None, base_decimals: int = 9,
                    quote_decimals: int = 6) -> MarketGrid:
    """Bucket grid anchored at tick 0 (section 4.2), in human prices."""
    width = tick_spacing * bucket_multiplier
    # human price = 1.0001^tick * 10^(base_dec - quote_dec)
    scale = 10 ** (base_decimals - quote_decimals)
    spot_tick = math.log(spot / scale) / math.log(1.0001)
    center = math.floor(spot_tick / width) * width
    buckets = []
    for k in range(-n_each_side, n_each_side + 1):
        lo = center + k * width
        buckets.append(GridBucket(lo, lo + width, 1.0001**lo * scale, 1.0001 ** (lo + width) * scale,
                                  (borrowable or {}).get(lo, 0)))
    return MarketGrid(spot=spot, buckets=tuple(buckets), base_decimals=base_decimals,
                      quote_decimals=quote_decimals)
