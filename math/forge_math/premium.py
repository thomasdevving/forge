"""Premium model (section 4.3, 4.4, 8.6), in exact integer arithmetic.

This module is the reference specification for the on-chain premium code. Every function
here uses Python integers only, mirrors the Rust implementation step by step, and rounds
amounts owed to LPs up (in the LP's favor) and amounts released to the borrower down.

Fixed-point conventions
-----------------------
* ppm   : parts per million (1_000_000 = 1.0). Utilization and the multiplier m(u).
* bps   : basis points (10_000 = 100%). Rates, caps, triggers, tolerances.
* x64   : unsigned Q64.64 (value * 2**64), as Orca uses for fee growth and sqrt price.
* Fee growth deltas wrap modulo 2**128, exactly like Orca's `wrapping_sub`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

PPM = 1_000_000
BPS = 10_000
Q64 = 1 << 64
U128 = 1 << 128
U64_MAX = (1 << 64) - 1
SECONDS_PER_YEAR = 365 * 24 * 60 * 60  # 31_536_000, simple 365-day year


def ceil_div(a: int, b: int) -> int:
    if b <= 0:
        raise ZeroDivisionError("divisor must be positive")
    if a < 0:
        raise ValueError("numerator must be non-negative")
    return -(-a // b)


def wrapping_sub_u128(a: int, b: int) -> int:
    """(a - b) mod 2**128, the delta between two Orca growth checkpoints."""
    return (a - b) % U128


# ---------------------------------------------------------------------------
# Utilization curve
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class UtilizationCurve:
    """Kinked multiplier m(u) >= 1, as in a lending-rate curve.

    Default (section 8.6): m(u) = 1 + u on [0, 0.6]; 1.6 + 6 (u - 0.6) on (0.6, 0.8].
    """

    base_ppm: int = 1_000_000
    slope1_ppm: int = 1_000_000
    kink_ppm: int = 600_000
    slope2_ppm: int = 6_000_000
    cap_ppm: int = 800_000

    def __post_init__(self) -> None:
        if self.base_ppm < PPM:
            raise ValueError("multiplier must be >= 1 everywhere (base_ppm >= 1_000_000)")
        if not (0 < self.kink_ppm <= self.cap_ppm <= PPM):
            raise ValueError("need 0 < kink <= cap <= 1")
        if self.slope1_ppm < 0 or self.slope2_ppm < 0:
            raise ValueError("slopes must be non-negative")

    def multiplier_ppm(self, u_ppm: int) -> int:
        """m(u) in ppm, rounded up. Raises if u exceeds the utilization cap."""
        if u_ppm < 0:
            raise ValueError("utilization must be non-negative")
        if u_ppm > self.cap_ppm:
            raise ValueError("utilization above cap")
        if u_ppm <= self.kink_ppm:
            return self.base_ppm + ceil_div(self.slope1_ppm * u_ppm, PPM)
        at_kink = self.base_ppm + ceil_div(self.slope1_ppm * self.kink_ppm, PPM)
        return at_kink + ceil_div(self.slope2_ppm * (u_ppm - self.kink_ppm), PPM)


def utilization_ppm(borrowed_plus_reserved: int, total: int) -> int:
    """Post-reservation utilization in ppm, rounded up (higher u favors the LP)."""
    if total <= 0:
        raise ValueError("bucket has no liquidity")
    if borrowed_plus_reserved < 0 or borrowed_plus_reserved > total:
        raise ValueError("borrowed liquidity outside [0, total]")
    return ceil_div(borrowed_plus_reserved * PPM, total)


# ---------------------------------------------------------------------------
# Forgone fees and conversion
# ---------------------------------------------------------------------------


def forgone_from_growth(growth_open_x64: int, growth_now_x64: int, liquidity: int) -> int:
    """Token atoms of fees the borrowed liquidity would have earned, rounded up."""
    if liquidity < 0:
        raise ValueError("liquidity must be non-negative")
    delta = wrapping_sub_u128(growth_now_x64, growth_open_x64)
    return ceil_div(delta * liquidity, Q64)


def base_to_quote(base_atoms: int, ref_price_x64: int) -> int:
    """Value base atoms in quote atoms at a reference price (quote atoms per base atom, Q64.64).

    Rounded up: it values an amount owed to LPs.
    """
    if base_atoms < 0 or ref_price_x64 <= 0:
        raise ValueError("invalid conversion input")
    return ceil_div(base_atoms * ref_price_x64, Q64)


def time_floor(notional_quote: int, rate_bps: int, elapsed_s: int) -> int:
    """Time-based floor premium: notional x annual rate x elapsed / year, rounded up."""
    if notional_quote < 0 or rate_bps < 0 or elapsed_s < 0:
        raise ValueError("invalid floor input")
    return ceil_div(notional_quote * rate_bps * elapsed_s, BPS * SECONDS_PER_YEAR)


# ---------------------------------------------------------------------------
# Per-leg accrual
# ---------------------------------------------------------------------------


@dataclass
class LegAccrual:
    """Premium accrual state for one borrowed bucket of one position.

    `cum_forgone_quote` only ever increases: each checkpoint converts the base-token fee
    growth accrued since the previous checkpoint at the then-current validated reference
    price, and earlier accruals are never revalued (section 4.3).
    """

    liquidity: int
    multiplier_ppm: int
    notional_quote: int
    opened_at: int
    growth_base_x64: int
    growth_quote_x64: int
    cum_forgone_quote: int = 0

    def checkpoint(self, growth_base_now_x64: int, growth_quote_now_x64: int,
                   ref_price_x64: int) -> int:
        """Accrue fees since the last checkpoint. Returns the quote amount added."""
        base_fees = forgone_from_growth(self.growth_base_x64, growth_base_now_x64, self.liquidity)
        quote_fees = forgone_from_growth(self.growth_quote_x64, growth_quote_now_x64,
                                         self.liquidity)
        added = quote_fees + (base_to_quote(base_fees, ref_price_x64) if base_fees else 0)
        self.growth_base_x64 = growth_base_now_x64
        self.growth_quote_x64 = growth_quote_now_x64
        self.cum_forgone_quote += added
        return added

    def premium(self, now: int, floor_rate_bps: int) -> int:
        """max(floor, m(u) x forgone) for this leg. The floor is not added on top."""
        if now < self.opened_at:
            raise ValueError("clock went backwards")
        floor = time_floor(self.notional_quote, floor_rate_bps, now - self.opened_at)
        scaled = ceil_div(self.multiplier_ppm * self.cum_forgone_quote, PPM)
        return max(floor, scaled)


# ---------------------------------------------------------------------------
# Budget, keeper bounty and settlement split
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Budget:
    total: int
    bounty_bps: int = 100
    trigger_bps: int = 8_000

    def __post_init__(self) -> None:
        if self.total < 0:
            raise ValueError("budget must be non-negative")
        if not (0 <= self.bounty_bps < BPS and 0 < self.trigger_bps <= BPS):
            raise ValueError("invalid bounty or trigger")

    @property
    def bounty_reserve(self) -> int:
        return self.total * self.bounty_bps // BPS

    @property
    def lp_cap(self) -> int:
        return self.total - self.bounty_reserve

    def crank_allowed(self, accrued: int) -> bool:
        """Keeper may close once accrued premium reaches trigger_bps of the LP cap."""
        return accrued * BPS >= self.lp_cap * self.trigger_bps

    def settle(self, accrued: int, keeper_paid: bool) -> Settlement:
        """Split the budget at close. Never charges more than the funded budget."""
        if accrued < 0:
            raise ValueError("accrued premium must be non-negative")
        to_lp = min(accrued, self.lp_cap)
        shortfall = accrued - to_lp
        bounty = self.bounty_reserve if keeper_paid else 0
        refund = self.total - to_lp - bounty
        return Settlement(to_lp=to_lp, lp_shortfall=shortfall, keeper_bounty=bounty,
                          refund_to_user=refund)


@dataclass(frozen=True)
class Settlement:
    to_lp: int
    lp_shortfall: int
    keeper_bounty: int
    refund_to_user: int


# ---------------------------------------------------------------------------
# Pro-rata distribution to LP shares
# ---------------------------------------------------------------------------


@dataclass
class PremiumIndex:
    """Cumulative quote-premium-per-share index for one bucket, with carried dust.

    Each LP stores the index value at its last checkpoint; its claim is
    shares x (index_now - index_then) / 2**64, rounded down. The division remainder is
    carried exactly in scaled units (`remainder_x64`, atoms x 2**64) and folded into the
    next distribution, so for every distribution k:

        sum_k(inc_k x total_shares_k) + remainder_x64 == deposited x 2**64

    which makes the sum of all claims at most the premium actually deposited.
    """

    total_shares: int
    index_x64: int = 0
    remainder_x64: int = 0
    deposited: int = 0

    def distribute(self, amount: int) -> None:
        if amount < 0:
            raise ValueError("amount must be non-negative")
        self.deposited += amount
        scaled = amount * Q64 + self.remainder_x64
        if self.total_shares == 0:
            self.remainder_x64 = scaled
            return
        inc, self.remainder_x64 = divmod(scaled, self.total_shares)
        self.index_x64 += inc

    @property
    def dust(self) -> int:
        """Whole atoms not yet reflected in the index (carried to the next distribution)."""
        return self.remainder_x64 // Q64

    def claimable(self, shares: int, index_then_x64: int) -> int:
        return shares * (self.index_x64 - index_then_x64) // Q64


@dataclass
class LpCheckpoint:
    shares: int
    index_x64: int
    owed: int = 0

    def sync(self, idx: PremiumIndex) -> None:
        self.owed += idx.claimable(self.shares, self.index_x64)
        self.index_x64 = idx.index_x64


@dataclass
class Bucket:
    """Minimal bucket model used by simulations: shares, borrowed L and premium index."""

    total_liquidity: int
    borrowed: int = 0
    reserved: int = 0
    index: PremiumIndex = field(default_factory=lambda: PremiumIndex(total_shares=0))

    def available(self, curve: UtilizationCurve) -> int:
        cap = self.total_liquidity * curve.cap_ppm // PPM
        return max(0, cap - self.borrowed - self.reserved)
