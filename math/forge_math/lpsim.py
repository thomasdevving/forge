"""Paired LP simulation (sections 4.6, 12.4).

Two worlds share one price path:

* World A: the LP keeps liquidity L over a ladder of buckets directly in Orca.
* World B: the same L sits in FORGE buckets; random borrowers open long puts (buckets
  strictly below spot) and long calls (strictly above), hold them, and restore them.

Fees come from (1) arbitrage swaps that move the pool along the path and (2) optional "noise"
round-trip volume at the current price. Under arbitrage only, fee growth per unit liquidity
is identical in both worlds, so measured forgone fees equal the true counterfactual. Noise
volume is fixed in size, so with less active liquidity in world B the per-unit growth is
higher and the forgone measure overstates the counterfactual (in the LP's favor). Both cases
are simulated and reported.

Everything here is a controlled simulation driven by a price path. It is not a replay of
Orca's actual swap history; see benchmarks/README.md for what each benchmark claims.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

from forge_math.premium import UtilizationCurve


@dataclass(frozen=True)
class SimParams:
    fee_rate: float = 0.003              # target pool fee (SOL/USDC ts64: 0.30%)
    protocol_fee_share: float = 0.13     # Orca protocol fee share of swap fees
    bucket_width_ticks: int = 256
    n_buckets: int = 8                   # ladder centered on the start price
    lp_liquidity: float = 1.0            # per bucket, in units where sqrt(price) is in $^0.5
    background_ratio: float = 3.0        # other LPs' liquidity per bucket, multiple of the LP's
    noise_volume_per_step: float = 0.0   # round-trip quote volume per step, x LP notional
    open_prob: float = 0.002             # per eligible bucket per step
    mean_hold_steps: float = 2_000.0
    util_low: float = 0.2
    util_high: float = 0.8
    budget_multiple: float = 3.0         # budget >= multiple x the floor premium for the hold
    budget_notional_frac: float = 0.01   # ... and >= this share of the borrowed notional
    budget_cap_prob: float = 0.1         # share of borrowers who fund only 0.5x expected floor
    floor_rate: float = 0.05
    step_seconds: float = 60.0
    restoration_buffer: float = 0.02
    restore_cost_bps_mean: float = 6.0   # swap fee + impact on the restoration pool
    restore_cost_bps_max: float = 60.0
    curve: UtilizationCurve = field(default_factory=UtilizationCurve)


@dataclass
class Borrow:
    bucket: int
    kind: str          # "put" or "call"
    util: float
    opened: int
    close_at: int
    budget: float
    multiplier: float
    forgone_quote: float = 0.0
    g_base0: float = 0.0
    g_quote0: float = 0.0
    # true counterfactual over this borrow's window on its bucket (accrual-time quote value)
    fees_a: float = 0.0
    idle_b: float = 0.0


@dataclass
class PathResult:
    path_id: str
    steps: int
    lp_fees_world_a: float = 0.0        # quote value at accrual time
    lp_idle_fees_world_b: float = 0.0   # quote value at accrual time
    premium_accrued: float = 0.0
    premium_paid: float = 0.0
    shortfall: float = 0.0
    restoration_failures: int = 0
    borrows: int = 0
    restored_exact: int = 0
    final_value_a: float = 0.0          # fees valued in kind at the final price
    final_value_b: float = 0.0
    measured_forgone: float = 0.0
    # per-borrow evaluation of the conditional guarantee
    borrows_eligible: int = 0
    borrows_holding: int = 0
    borrow_violations: list = field(default_factory=list)
    borrows_shortfall: int = 0

    @property
    def eligible(self) -> bool:
        return self.shortfall <= 1e-12 and self.restoration_failures == 0

    @property
    def guarantee_holds(self) -> bool:
        """Conditional claim: idle fees + premium paid >= fees from staying in Orca."""
        tol = 1e-9 * max(1.0, self.lp_fees_world_a)
        return self.lp_idle_fees_world_b + self.premium_paid + tol >= self.lp_fees_world_a

    @property
    def final_value_dominates(self) -> bool:
        tol = 1e-9 * max(1.0, self.final_value_a)
        return self.final_value_b + tol >= self.final_value_a

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(eligible=self.eligible, guarantee_holds=self.guarantee_holds,
                 final_value_dominates=self.final_value_dominates)
        return d


def tick_price(tick: float) -> float:
    return 1.0001 ** tick


def simulate_path(prices: np.ndarray, params: SimParams, seed: int, path_id: str) -> PathResult:
    """Run both worlds over one price path (quote per base, one price per step)."""
    p = params
    rng = np.random.default_rng(seed)
    if len(prices) < 2:
        raise ValueError("need at least two prices")
    start_tick = math.log(prices[0]) / math.log(1.0001)
    w = p.bucket_width_ticks
    center = math.floor(start_tick / w) * w
    lowers = np.array([center + (k - p.n_buckets // 2) * w for k in range(p.n_buckets)], float)
    sqrt_lo = np.sqrt(tick_price(lowers))
    sqrt_hi = np.sqrt(tick_price(lowers + w))
    L = p.lp_liquidity
    Lbg = p.background_ratio * L
    lp_notional = float(np.sum(L * (sqrt_hi - sqrt_lo) * np.sqrt(prices[0])))  # rough quote scale

    # per-unit-liquidity fee growth in each bucket, separately per world (they differ only
    # when noise volume is present), in base and quote units
    gA_base = np.zeros(p.n_buckets)
    gA_quote = np.zeros(p.n_buckets)
    gB_base = np.zeros(p.n_buckets)
    gB_quote = np.zeros(p.n_buckets)
    borrowed = np.zeros(p.n_buckets)   # utilization fraction of the LP's L in world B
    active: list[Borrow | None] = [None] * p.n_buckets
    res = PathResult(path_id=path_id, steps=len(prices) - 1)
    lp_base_a = lp_quote_a = lp_base_b = lp_quote_b = 0.0
    keep = 1.0 - p.protocol_fee_share
    prev_a_base = np.zeros(p.n_buckets)
    prev_a_quote = np.zeros(p.n_buckets)
    prev_b_base = np.zeros(p.n_buckets)
    prev_b_quote = np.zeros(p.n_buckets)

    for t in range(1, len(prices)):
        s0, s1 = math.sqrt(prices[t - 1]), math.sqrt(prices[t])
        price = prices[t]
        lo, hi = min(s0, s1), max(s0, s1)
        ov = np.clip(np.minimum(hi, sqrt_hi) - np.maximum(lo, sqrt_lo), 0.0, None)
        # arbitrage: fee per unit L is independent of the liquidity amount
        if s1 > s0:   # price up: quote in, fee in quote: fee/L = fr * d(sqrt P)
            dq = p.fee_rate * keep * ov
            gA_quote += dq
            gB_quote += dq
        elif s1 < s0:  # price down: base in, fee in base: fee/L = fr * d(1/sqrt P)
            inv = np.clip(np.minimum(1 / lo, 1 / sqrt_lo) - np.maximum(1 / hi, 1 / sqrt_hi), 0.0, None)
            inv = np.where(ov > 0, inv, 0.0)
            db = p.fee_rate * keep * inv
            gA_base += db
            gB_base += db
        # noise round trips at the current price, split between the two tokens
        if p.noise_volume_per_step > 0:
            j = np.where((s1 >= sqrt_lo) & (s1 < sqrt_hi))[0]
            if len(j):
                k = j[0]
                fee_q = p.fee_rate * keep * p.noise_volume_per_step * lp_notional / 2
                fee_b = fee_q / price
                act_a = L + Lbg
                act_b = L * (1 - borrowed[k]) + Lbg
                gA_quote[k] += fee_q / act_a
                gA_base[k] += fee_b / act_a
                gB_quote[k] += fee_q / act_b
                gB_base[k] += fee_b / act_b

        # LP income this step, valued in quote at accrual time and kept in kind
        dA_b = L * (gA_base - prev_a_base)
        dA_q = L * (gA_quote - prev_a_quote)
        dB_b = L * (1 - borrowed) * (gB_base - prev_b_base)
        dB_q = L * (1 - borrowed) * (gB_quote - prev_b_quote)
        res.lp_fees_world_a += float(dA_b.sum() * price + dA_q.sum())
        res.lp_idle_fees_world_b += float(dB_b.sum() * price + dB_q.sum())
        lp_base_a += float(dA_b.sum())
        lp_quote_a += float(dA_q.sum())
        lp_base_b += float(dB_b.sum())
        lp_quote_b += float(dB_q.sum())
        prev_a_base, prev_a_quote = gA_base.copy(), gA_quote.copy()
        prev_b_base, prev_b_quote = gB_base.copy(), gB_quote.copy()

        # accrue forgone fees for open borrows (base fees valued at this step's reference)
        for k, b in enumerate(active):
            if b is None:
                continue
            b.fees_a += float(dA_b[k] * price + dA_q[k])
            b.idle_b += float(dB_b[k] * price + dB_q[k])
            db = (gB_base[k] - b.g_base0) * L * b.util
            dq = (gB_quote[k] - b.g_quote0) * L * b.util
            b.forgone_quote += db * price + dq
            b.g_base0, b.g_quote0 = gB_base[k], gB_quote[k]

        # closes
        for k, b in enumerate(active):
            if b is None or t < b.close_at:
                continue
            res.restored_exact += 1  # restoration restores exactly util * L (asserted below)
            held_s = (t - b.opened) * p.step_seconds
            removed = L * b.util * (sqrt_hi[k] - sqrt_lo[k]) * (1.0 if b.kind == "put" else 0.0)
            removed += L * b.util * (1 / sqrt_lo[k] - 1 / sqrt_hi[k]) * price * (b.kind == "call")
            notional = removed
            floor = notional * p.floor_rate * held_s / (365 * 86_400)
            premium = max(floor, b.multiplier * b.forgone_quote)
            lp_cap = b.budget * 0.99
            paid = min(premium, lp_cap)
            res.premium_accrued += premium
            res.premium_paid += paid
            res.shortfall += premium - paid
            res.measured_forgone += b.forgone_quote
            # restoration feasibility: margin (frictionless payoff + buffer) vs swap cost
            sp = math.sqrt(price)
            sa, sb = sqrt_lo[k], sqrt_hi[k]
            s = min(max(sp, sa), sb)
            x = L * b.util * (1 / s - 1 / sb)
            y = L * b.util * (s - sa)
            if b.kind == "put":
                y_full = L * b.util * (sb - sa)
                deficit_value = x * price
                margin = y_full - (x * price + y) + p.restoration_buffer * y_full
            else:
                x_full = L * b.util * (1 / sa - 1 / sb)
                deficit_value = y
                margin = x_full * price - (x * price + y) + p.restoration_buffer * x_full * price
            cost_bps = min(rng.exponential(p.restore_cost_bps_mean), p.restore_cost_bps_max)
            failed = deficit_value * cost_bps / 1e4 > margin + 1e-15
            if failed:
                res.restoration_failures += 1
            _evaluate_borrow(res, b, premium, paid, failed)
            borrowed[k] = 0.0
            active[k] = None

        # opens: only strictly out-of-range buckets, on the side the product requires
        for k in range(p.n_buckets):
            if active[k] is not None or rng.random() >= p.open_prob:
                continue
            if s1 < sqrt_lo[k]:
                kind = "call"
            elif s1 > sqrt_hi[k]:
                kind = "put"
            else:
                continue
            util = float(rng.uniform(p.util_low, p.util_high))
            hold = max(1, int(rng.exponential(p.mean_hold_steps)))
            u_ppm = math.ceil(util * 1e6)
            m = p.curve.multiplier_ppm(min(u_ppm, p.curve.cap_ppm)) / 1e6
            if kind == "put":
                notional = L * util * (sqrt_hi[k] - sqrt_lo[k])
            else:
                notional = L * util * (1 / sqrt_lo[k] - 1 / sqrt_hi[k]) * price
            exp_floor = notional * p.floor_rate * hold * p.step_seconds / (365 * 86_400)
            if rng.random() < p.budget_cap_prob:
                budget = max(exp_floor * 0.5, 1e-12)  # deliberately underfunded borrower
            else:
                budget = max(exp_floor * p.budget_multiple, notional * p.budget_notional_frac, 1e-12)
            active[k] = Borrow(k, kind, util, t, t + hold, budget, m,
                               g_base0=gB_base[k], g_quote0=gB_quote[k])
            borrowed[k] = util
            res.borrows += 1

    # still-open borrows are closed at the end of the path (same rules)
    final_price = float(prices[-1])
    for k, b in enumerate(active):
        if b is None:
            continue
        held_s = (len(prices) - 1 - b.opened) * p.step_seconds
        if b.kind == "put":
            notional = L * b.util * (sqrt_hi[k] - sqrt_lo[k])
        else:
            notional = L * b.util * (1 / sqrt_lo[k] - 1 / sqrt_hi[k]) * final_price
        floor = notional * p.floor_rate * held_s / (365 * 86_400)
        premium = max(floor, b.multiplier * b.forgone_quote)
        paid = min(premium, b.budget * 0.99)
        res.premium_accrued += premium
        res.premium_paid += paid
        res.shortfall += premium - paid
        res.measured_forgone += b.forgone_quote
        res.restored_exact += 1
        _evaluate_borrow(res, b, premium, paid, False)

    assert res.restored_exact == res.borrows, "every borrow must restore exactly its liquidity"
    res.final_value_a = lp_base_a * final_price + lp_quote_a
    res.final_value_b = lp_base_b * final_price + lp_quote_b + res.premium_paid
    return res


def _evaluate_borrow(res: PathResult, b: Borrow, premium: float, paid: float, failed: bool) -> None:
    """Conditional guarantee for one borrow: if restoration succeeded and the premium was fully
    funded, the premium paid must cover the LP's actual fee loss on that bucket and window."""
    short = premium - paid > 1e-15
    if short:
        res.borrows_shortfall += 1
    if failed or short:
        return
    res.borrows_eligible += 1
    loss = b.fees_a - b.idle_b
    if paid + 1e-12 * max(1.0, abs(loss)) >= loss:
        res.borrows_holding += 1
    else:
        res.borrow_violations.append({"bucket": b.bucket, "kind": b.kind, "loss": loss, "paid": paid})


def gbm_path(start: float, steps: int, annual_vol: float, seed: int, step_seconds: float = 60.0,
             drift: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    dt = step_seconds / (365 * 86_400)
    z = rng.standard_normal(steps)
    log = np.cumsum((drift - 0.5 * annual_vol**2) * dt + annual_vol * math.sqrt(dt) * z)
    return start * np.exp(np.concatenate([[0.0], log]))


def ohlc_path(o: np.ndarray, h: np.ndarray, low: np.ndarray, c: np.ndarray,
              high_first: bool) -> np.ndarray:
    """Expand 1m bars into a path o -> (h, l) -> c. OHLC bars do not record intra-bar order, so
    both orderings are simulated and reported separately."""
    out = np.empty(len(o) * 4)
    out[0::4] = o
    out[1::4] = h if high_first else low
    out[2::4] = low if high_first else h
    out[3::4] = c
    return out
