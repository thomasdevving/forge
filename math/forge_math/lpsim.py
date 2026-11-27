"""Paired LP simulation (sections 4.6, 12.4).

Two worlds share one price path:

* World A: the LP keeps liquidity L over a ladder of buckets directly in Orca.
* World B: the same L sits in FORGE buckets; borrowers open long puts (buckets strictly below
  spot) and long calls (strictly above), hold them, and restore them.

Pool price. The external price path (Binance bars, GBM) is not the pool price. By default
(``fee_model="band"``) arbitrageurs only move the pool once the external price leaves the
no-arbitrage band [p (1 - f), p (1 + f)], and then only to the band edge. The legacy model
(``fee_model="legacy-every-price"``) arbitrages the pool to every path point and charges the fee
on every wiggle, which on 15-second OHLC paths gives fee APRs of several hundred percent; it is kept
only so older results can be reproduced and compared.

Fees come from (1) arbitrage swaps that move the pool and (2) optional "noise" round-trip volume at
the current pool price, ``noise_volume_per_step`` x the LP ladder's starting value per step. Under
arbitrage only, fee growth per unit liquidity is identical in both worlds, so measured forgone fees
equal the true counterfactual. Noise volume is fixed in size, so with less active liquidity in world
B the per-unit growth is higher and the forgone measure overstates the counterfactual (in the LP's
favor).

Program parity (programs/forge): premium = max(floor, m(u) x forgone) with the floor on the notional
stored at open (calls: removed base valued at the open reference price); the LP cap is the budget less
the keeper bounty; optionally (``keeper=True``) a keeper closes a position ``keeper_delay_s`` after
accrued premium reaches ``keeper_trigger_bps`` of the LP cap; a restoration whose swap cost exceeds the
slippage cap or the escrow margin is refused (Recovery) and retried after ``restore_retry_s`` with the
liquidity still out of the pool and premium still accruing. ``SimParams.from_program()`` reads the
defaults from the Rust sources and ``program_parity()`` fails loudly on any mismatch.

Two engines share these rules:

* ``simulate_path``: the reference step-by-step simulation with random borrowers (Benchmark 3).
* ``fee_growth`` + ``settle_borrows`` + ``simulate_demand``: a vectorized event engine (Benchmark 4's
  demand sweep). ``settle_borrows`` reproduces ``simulate_path`` exactly on identical borrows
  (math/tests/test_lpsim.py).

Everything here is a controlled simulation driven by a price path. It is not a replay of
Orca's actual swap history; see benchmarks/README.md for what each benchmark claims.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field, replace
from functools import lru_cache
from pathlib import Path

import numpy as np

from forge_math.premium import UtilizationCurve

YEAR_S = 365 * 86_400
FEE_MODELS = ("band", "legacy-every-price")
PROGRAM_SRC = Path(__file__).resolve().parents[2] / "programs" / "forge" / "src"


# ---------------------------------------------------------------------------------------------
# Parameters and program parity
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SimParams:
    fee_rate: float = 0.003              # target pool fee (SOL/USDC ts64: 0.30%)
    protocol_fee_share: float = 0.13     # Orca protocol fee share of swap fees
    fee_model: str = "band"              # "band" (default) or "legacy-every-price"
    bucket_width_ticks: int = 256
    n_buckets: int = 8                   # ladder centered on the start price
    lp_liquidity: float = 1.0            # per bucket, in units where sqrt(price) is in $^0.5
    background_ratio: float = 3.0        # other LPs' liquidity per bucket, multiple of the LP's
    noise_volume_per_step: float = 0.0   # round-trip quote volume per step, x the LP ladder's start value
    open_prob: float = 0.002             # per eligible bucket per step
    mean_hold_steps: float = 2_000.0
    util_low: float = 0.2
    util_high: float = 0.8
    budget_multiple: float = 3.0         # budget >= multiple x the floor premium for the hold
    budget_notional_frac: float = 0.01   # ... and >= this share of the borrowed notional
    budget_cap_prob: float = 0.1         # share of borrowers who fund only 0.5x expected floor
    floor_rate: float = 0.05             # program: floor_rate_bps = 500
    step_seconds: float = 60.0
    restoration_buffer: float = 0.02     # program: restoration_buffer_bps = 200
    restore_cost_bps_mean: float = 6.0   # swap fee + impact on the restoration pool (assumption)
    restore_cost_bps_max: float = 60.0
    swap_slippage_bps: float = 50.0      # program: swap_slippage_bps; costlier restorations are refused
    restore_retry_s: float = 3_600.0     # a refused restoration is retried after this delay
    bounty_bps: int = 100                # program: bounty_bps; LP cap = budget - bounty reserve
    keeper: bool = False                 # keepers close positions at the budget trigger
    keeper_trigger_bps: int = 8_000      # program: keeper_trigger_bps (accrued >= 80% of the LP cap)
    keeper_delay_s: float = 300.0        # trigger -> close executed
    protocol_fee_bps: int = 1_000        # program: protocol_fee_bps, share of premium above forgone fees
    curve: UtilizationCurve = field(default_factory=UtilizationCurve)

    def __post_init__(self) -> None:
        if self.fee_model not in FEE_MODELS:
            raise ValueError(f"fee_model must be one of {FEE_MODELS}")

    @property
    def lp_cap_frac(self) -> float:
        """LP cap / budget (the rest is the keeper bounty reserve)."""
        return (10_000 - self.bounty_bps) / 10_000

    @property
    def keeper_trigger(self) -> float:
        return self.keeper_trigger_bps / 10_000

    @property
    def protocol_take(self) -> float:
        return self.protocol_fee_bps / 10_000

    @classmethod
    def from_program(cls, **overrides) -> SimParams:
        """Defaults read from programs/forge (state.rs MarketParams, premium.rs UtilizationCurve)."""
        d = program_defaults()
        program_parity(cls())   # the literal defaults must equal the program's
        p = cls(floor_rate=d["floor_rate_bps"] / 10_000, restoration_buffer=d["restoration_buffer_bps"] / 10_000,
                swap_slippage_bps=float(d["swap_slippage_bps"]), bounty_bps=d["bounty_bps"],
                keeper_trigger_bps=d["keeper_trigger_bps"], protocol_fee_bps=d["protocol_fee_bps"],
                curve=UtilizationCurve(**d["curve"]))
        return replace(p, **overrides)


_PROGRAM_FIELDS = ("floor_rate_bps", "restoration_buffer_bps", "swap_slippage_bps", "keeper_trigger_bps",
                   "bounty_bps", "protocol_fee_bps")
_CURVE_FIELDS = ("base_ppm", "slope1_ppm", "kink_ppm", "slope2_ppm", "cap_ppm")


@lru_cache(maxsize=1)
def program_defaults() -> dict:
    """Parse the on-chain defaults from the program sources (fails loudly if they cannot be found)."""
    state = (PROGRAM_SRC / "state.rs").read_text()
    prem = (PROGRAM_SRC / "math" / "premium.rs").read_text()

    def num(src: str, name: str) -> int:
        m = re.search(rf"\b{name}:\s*([\d_]+)", src)
        if not m:
            raise RuntimeError(f"could not find {name} in the program sources under {PROGRAM_SRC}")
        return int(m.group(1).replace("_", ""))

    out = {k: num(state, k) for k in _PROGRAM_FIELDS}
    out["curve"] = {k: num(prem, k) for k in _CURVE_FIELDS}
    return out


def program_parity(p: SimParams) -> dict:
    """Compare the program-defined parameters of ``p`` with programs/forge; raise on any mismatch."""
    onchain = program_defaults()
    used = {"floor_rate_bps": round(p.floor_rate * 10_000),
            "restoration_buffer_bps": round(p.restoration_buffer * 10_000),
            "swap_slippage_bps": round(p.swap_slippage_bps), "keeper_trigger_bps": p.keeper_trigger_bps,
            "bounty_bps": p.bounty_bps, "protocol_fee_bps": p.protocol_fee_bps, "curve": asdict(p.curve)}
    mismatch = {k: (used[k], onchain[k]) for k in onchain if used[k] != onchain[k]}
    if mismatch:
        raise ValueError(f"simulation parameters differ from the programs/forge defaults (used, on-chain): {mismatch}")
    return {"onchain_defaults": onchain, "used": used, "match": True}


# ---------------------------------------------------------------------------------------------
# Paths, ladder, pool price
# ---------------------------------------------------------------------------------------------


def tick_price(tick: float) -> float:
    return 1.0001 ** tick


def ladder(p0: float, p: SimParams) -> tuple[np.ndarray, np.ndarray]:
    """sqrt prices of the bucket edges of the ladder centered on p0."""
    start_tick = math.log(p0) / math.log(1.0001)
    w = p.bucket_width_ticks
    center = math.floor(start_tick / w) * w
    lowers = np.array([center + (k - p.n_buckets // 2) * w for k in range(p.n_buckets)], float)
    return np.sqrt(tick_price(lowers)), np.sqrt(tick_price(lowers + w))


def ladder_amounts(sqrt_lo: np.ndarray, sqrt_hi: np.ndarray, sp: float, L: float = 1.0) -> tuple[float, float]:
    """(base, quote) held by liquidity L in every bucket of the ladder at sqrt price sp."""
    s = np.clip(sp, sqrt_lo, sqrt_hi)
    return float(np.sum(L * (1 / s - 1 / sqrt_hi))), float(np.sum(L * (s - sqrt_lo)))


def ladder_value(sqrt_lo: np.ndarray, sqrt_hi: np.ndarray, price: float, L: float = 1.0) -> float:
    x, y = ladder_amounts(sqrt_lo, sqrt_hi, math.sqrt(price), L)
    return x * price + y


def band_path(q: np.ndarray, f: float) -> np.ndarray:
    """Pool price under arbitrage with fee f: it moves only to the edge of the no-arbitrage band."""
    out = np.empty(len(q))
    lo_m, hi_m = 1.0 / (1.0 + f), 1.0 / (1.0 - f)
    pp = float(q[0])
    for i, x in enumerate(np.asarray(q, float).tolist()):
        lo, hi = x * lo_m, x * hi_m
        if pp < lo:
            pp = lo
        elif pp > hi:
            pp = hi
        out[i] = pp
    return out


def pool_path(prices: np.ndarray, p: SimParams) -> np.ndarray:
    """The pool price the simulation runs on, given an external price path."""
    prices = np.asarray(prices, float)
    return band_path(prices, p.fee_rate) if p.fee_model == "band" else prices


def gbm_path(start: float, steps: int, annual_vol: float, seed: int, step_seconds: float = 60.0,
             drift: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    dt = step_seconds / YEAR_S
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


def _noise_fee_quote(p: SimParams, lp_value: float, noise_per_step: float) -> float:
    """Quote half of the LP-pool fee taken from one step of round-trip noise volume."""
    return p.fee_rate * (1.0 - p.protocol_fee_share) * noise_per_step * lp_value / 2


# ---------------------------------------------------------------------------------------------
# Reference engine: step-by-step paired simulation with random borrowers
# ---------------------------------------------------------------------------------------------


@dataclass
class Borrow:
    bucket: int
    kind: str          # "put" or "call"
    util: float
    opened: int
    close_at: int
    budget: float
    multiplier: float
    notional: float = 0.0   # quote notional stored at open (calls: removed base x open price)
    forgone_quote: float = 0.0
    g_base0: float = 0.0
    g_quote0: float = 0.0
    t_floor: int = 0        # first step at which the floor alone reaches the keeper trigger
    triggered: bool = False
    refusals: int = 0
    closed: int = -1        # step at which the liquidity was restored
    # true counterfactual over this borrow's window on its bucket (accrual-time quote value)
    fees_a: float = 0.0
    idle_b: float = 0.0


@dataclass
class PathResult:
    path_id: str
    steps: int
    fee_model: str = "band"
    step_seconds: float = 60.0
    lp_value_start: float = 0.0         # LP ladder value at the start pool price (quote)
    lp_fees_world_a: float = 0.0        # quote value at accrual time
    lp_idle_fees_world_b: float = 0.0   # quote value at accrual time
    premium_accrued: float = 0.0
    premium_paid: float = 0.0           # paid to LPs (after the protocol's share)
    protocol_paid: float = 0.0          # protocol share: protocol_fee_bps of premium above forgone fees
    shortfall: float = 0.0
    restoration_failures: int = 0       # refused restoration attempts (each retried later)
    borrows_with_refusals: int = 0
    keeper_closes: int = 0
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
        """Every borrow on the path fully funded (restorations always complete, possibly delayed)."""
        return self.shortfall <= 1e-12

    @property
    def guarantee_holds(self) -> bool:
        """Conditional claim: idle fees + premium paid >= fees from staying in Orca."""
        tol = 1e-9 * max(1.0, self.lp_fees_world_a)
        return self.lp_idle_fees_world_b + self.premium_paid + tol >= self.lp_fees_world_a

    @property
    def final_value_dominates(self) -> bool:
        tol = 1e-9 * max(1.0, self.final_value_a)
        return self.final_value_b + tol >= self.final_value_a

    @property
    def fee_apr_a(self) -> float:
        """World A fees (accrual-time quote) / starting LP value, annualized."""
        days = self.steps * self.step_seconds / 86_400
        return self.lp_fees_world_a / self.lp_value_start * 365 / days if self.lp_value_start and days else 0.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(eligible=self.eligible, guarantee_holds=self.guarantee_holds,
                 final_value_dominates=self.final_value_dominates, fee_apr_a=self.fee_apr_a)
        return d


def _restoration(p: SimParams, kind: str, util: float, sa: float, sb: float, price: float,
                 rng: np.random.Generator) -> bool:
    """Guarded restoration at `price`: True if it executes, False if refused (Recovery)."""
    L = p.lp_liquidity
    sc = min(max(math.sqrt(price), sa), sb)
    x, y = L * util * (1 / sc - 1 / sb), L * util * (sc - sa)
    if kind == "put":
        full = L * util * (sb - sa)
        deficit = x * price
    else:
        full = L * util * (1 / sa - 1 / sb) * price
        deficit = y
    if deficit <= 0:
        return True   # the escrow already holds the exact tokens: no swap
    margin = full - (x * price + y) + p.restoration_buffer * full
    cost = min(rng.exponential(p.restore_cost_bps_mean), p.restore_cost_bps_max)
    return cost <= p.swap_slippage_bps and deficit * cost / 1e4 <= margin + 1e-15


def _keeper_floor_step(p: SimParams, opened: int, budget: float, notional: float) -> int:
    floor_step = p.floor_rate * p.step_seconds / YEAR_S
    thr = p.keeper_trigger * p.lp_cap_frac * budget
    return opened + max(1, math.ceil(thr / (notional * floor_step)))


def simulate_path(prices: np.ndarray, params: SimParams, seed: int, path_id: str,
                  record: list | None = None) -> PathResult:
    """Run both worlds over one external price path (quote per base, one price per step).
    If `record` is a list, every Borrow is appended to it (for replay_check)."""
    p = params
    rng = np.random.default_rng(seed)
    if len(prices) < 2:
        raise ValueError("need at least two prices")
    prices = pool_path(prices, p)
    sqrt_lo, sqrt_hi = ladder(float(prices[0]), p)
    nb = p.n_buckets
    L = p.lp_liquidity
    Lbg = p.background_ratio * L
    T = len(prices) - 1
    lp_value = ladder_value(sqrt_lo, sqrt_hi, float(prices[0]), L)
    fee_q = _noise_fee_quote(p, lp_value, p.noise_volume_per_step)
    keeper_steps = max(1, round(p.keeper_delay_s / p.step_seconds))
    retry_steps = max(1, round(p.restore_retry_s / p.step_seconds))
    trig = p.keeper_trigger * p.lp_cap_frac

    # per-unit-liquidity fee growth in each bucket, separately per world (they differ only
    # when noise volume is present), in base and quote units
    gA_base = np.zeros(nb)
    gA_quote = np.zeros(nb)
    gB_base = np.zeros(nb)
    gB_quote = np.zeros(nb)
    borrowed = np.zeros(nb)   # utilization fraction of the LP's L in world B
    active: list[Borrow | None] = [None] * nb
    res = PathResult(path_id=path_id, steps=T, fee_model=p.fee_model, step_seconds=p.step_seconds,
                     lp_value_start=lp_value)
    lp_base_a = lp_quote_a = lp_base_b = lp_quote_b = 0.0
    keep = 1.0 - p.protocol_fee_share
    prev_a_base = np.zeros(nb)
    prev_a_quote = np.zeros(nb)
    prev_b_base = np.zeros(nb)
    prev_b_quote = np.zeros(nb)

    def settle(b: Borrow, t: int, price_t: float) -> None:
        k = b.bucket
        held_s = (t - b.opened) * p.step_seconds
        floor = b.notional * p.floor_rate * held_s / YEAR_S
        premium = max(floor, b.multiplier * b.forgone_quote)
        paid = min(premium, b.budget * p.lp_cap_frac)
        # the protocol takes its share of the excess over forgone fees only when the LP is paid in full
        cut = min(paid, p.protocol_take * max(0.0, premium - b.forgone_quote)) if premium - paid <= 1e-15 else 0.0
        res.premium_accrued += premium
        res.premium_paid += paid - cut
        res.protocol_paid += cut
        res.shortfall += premium - paid
        res.measured_forgone += b.forgone_quote
        res.restored_exact += 1
        res.borrows_with_refusals += b.refusals > 0
        b.closed = t
        _evaluate_borrow(res, b, premium, paid, paid - cut)
        borrowed[k] = 0.0
        active[k] = None

    for t in range(1, T + 1):
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
        if fee_q > 0:
            j = np.where((s1 >= sqrt_lo) & (s1 < sqrt_hi))[0]
            if len(j):
                k = j[0]
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

        # accrue forgone fees for open borrows (base fees valued at this step's reference);
        # keepers act once accrued premium reaches the trigger share of the LP cap
        for k, b in enumerate(active):
            if b is None:
                continue
            b.fees_a += float(dA_b[k] * price + dA_q[k])
            b.idle_b += float(dB_b[k] * price + dB_q[k])
            dbase = (gB_base[k] - b.g_base0) * L * b.util
            dquote = (gB_quote[k] - b.g_quote0) * L * b.util
            b.forgone_quote += dbase * price + dquote
            b.g_base0, b.g_quote0 = gB_base[k], gB_quote[k]
            if p.keeper and not b.triggered and (
                    t >= b.t_floor or b.multiplier * b.forgone_quote >= trig * b.budget):
                b.triggered = True
                if t + keeper_steps < min(b.close_at, T):
                    b.close_at = t + keeper_steps
                    res.keeper_closes += 1

        # closes: guarded restoration; a refused one is retried later (Recovery)
        for k, b in enumerate(active):
            if b is None or t < b.close_at:
                continue
            if t < T and not _restoration(p, b.kind, b.util, sqrt_lo[k], sqrt_hi[k], price, rng):
                res.restoration_failures += 1
                b.refusals += 1
                b.close_at = t + retry_steps
                continue
            settle(b, t, price)

        # opens: only strictly out-of-range buckets, on the side the product requires
        for k in range(nb):
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
            exp_floor = notional * p.floor_rate * hold * p.step_seconds / YEAR_S
            if rng.random() < p.budget_cap_prob:
                budget = max(exp_floor * 0.5, 1e-12)  # deliberately underfunded borrower
            else:
                budget = max(exp_floor * p.budget_multiple, notional * p.budget_notional_frac, 1e-12)
            active[k] = Borrow(k, kind, util, t, t + hold, budget, m, notional=notional,
                               g_base0=gB_base[k], g_quote0=gB_quote[k],
                               t_floor=_keeper_floor_step(p, t, budget, notional))
            borrowed[k] = util
            res.borrows += 1
            if record is not None:
                record.append(active[k])

    # still-open borrows are restored at the end of the path (same premium rules, no guard)
    final_price = float(prices[-1])
    for b in active:
        if b is not None:
            settle(b, T, final_price)

    assert res.restored_exact == res.borrows, "every borrow must restore exactly its liquidity"
    res.final_value_a = lp_base_a * final_price + lp_quote_a
    res.final_value_b = lp_base_b * final_price + lp_quote_b + res.premium_paid
    return res


def _evaluate_borrow(res: PathResult, b: Borrow, premium: float, paid: float, lp_paid: float) -> None:
    """Conditional guarantee for one borrow: if the premium was fully funded, the premium paid must
    cover the LP's actual fee loss on that bucket over the whole time the liquidity was out
    (including any refused-restoration delay)."""
    if premium - paid > 1e-15:
        res.borrows_shortfall += 1
        return
    res.borrows_eligible += 1
    loss = b.fees_a - b.idle_b
    if lp_paid + 1e-12 * max(1.0, abs(loss)) >= loss:
        res.borrows_holding += 1
    else:
        res.borrow_violations.append({"bucket": b.bucket, "kind": b.kind, "loss": loss, "paid": lp_paid})


# ---------------------------------------------------------------------------------------------
# Event engine: fee growth as prefix sums, vectorized settlement, demand sweep
# ---------------------------------------------------------------------------------------------


@dataclass
class FeeGrowth:
    prices: np.ndarray       # pool price path (T+1)
    s: np.ndarray            # sqrt prices
    step_s: float
    sqrt_lo: np.ndarray
    sqrt_hi: np.ndarray
    arb_b: np.ndarray        # (T+1, nb) prefix sums of per-unit-L arbitrage fee growth, base
    arb_q: np.ndarray        # ... quote
    arb_v: np.ndarray        # ... valued in quote at accrual time
    nz_b: np.ndarray         # (T+1, nb) prefix sums of noise fees reaching the bucket (total, not per L)
    nz_q: np.ndarray
    nz_v: np.ndarray
    elig: np.ndarray         # (T+1, nb) cumulative count of steps where the bucket is borrowable

    @property
    def T(self) -> int:
        return len(self.prices) - 1


def fee_growth(pool_prices: np.ndarray, step_s: float, p: SimParams, noise_per_step: float = 0.0) -> FeeGrowth:
    """simulate_path's fee accrual over a pool price path, vectorized over steps."""
    prices = np.asarray(pool_prices, float)
    sqrt_lo, sqrt_hi = ladder(float(prices[0]), p)
    s = np.sqrt(prices)
    s0, s1 = s[:-1], s[1:]
    lo, hi = np.minimum(s0, s1)[:, None], np.maximum(s0, s1)[:, None]
    ov = np.clip(np.minimum(hi, sqrt_hi) - np.maximum(lo, sqrt_lo), 0.0, None)
    keep = 1.0 - p.protocol_fee_share
    up = (s1 > s0)[:, None]
    down = (s1 < s0)[:, None]
    dq = np.where(up, p.fee_rate * keep * ov, 0.0)
    inv = np.clip(np.minimum(1 / lo, 1 / sqrt_lo) - np.maximum(1 / hi, 1 / sqrt_hi), 0.0, None)
    db = np.where(down & (ov > 0), p.fee_rate * keep * inv, 0.0)
    pt = prices[1:, None]
    z = np.zeros((1, len(sqrt_lo)))
    arb_v = np.vstack([z, np.cumsum(db * pt + dq, axis=0)])
    fg = FeeGrowth(prices=prices, s=s, step_s=step_s, sqrt_lo=sqrt_lo, sqrt_hi=sqrt_hi,
                   arb_b=np.vstack([z, np.cumsum(db, axis=0)]), arb_q=np.vstack([z, np.cumsum(dq, axis=0)]),
                   arb_v=arb_v, nz_b=np.zeros_like(arb_v), nz_q=np.zeros_like(arb_v), nz_v=np.zeros_like(arb_v),
                   elig=np.zeros(1))
    if noise_per_step > 0:
        fee_q = _noise_fee_quote(p, ladder_value(sqrt_lo, sqrt_hi, float(prices[0]), p.lp_liquidity), noise_per_step)
        inside = (s1[:, None] >= sqrt_lo) & (s1[:, None] < sqrt_hi)
        nq = inside * fee_q
        nb = nq / pt
        fg.nz_q = np.vstack([z, np.cumsum(nq, axis=0)])
        fg.nz_b = np.vstack([z, np.cumsum(nb, axis=0)])
        fg.nz_v = np.vstack([z, np.cumsum(nq + nb * pt, axis=0)])
    el = (s1[:, None] < sqrt_lo) | (s1[:, None] > sqrt_hi)
    fg.elig = np.vstack([np.zeros((1, len(sqrt_lo)), np.int64), np.cumsum(el, axis=0)])
    return fg


def world_a_fees(fg: FeeGrowth, p: SimParams, nzf: float = 1.0) -> tuple[float, float, float]:
    """LP fees in plain Orca over the whole path: (base, quote, quote value at accrual time)."""
    L, Lbg = p.lp_liquidity, p.background_ratio * p.lp_liquidity
    den = L + Lbg
    return (float(L * np.sum(fg.arb_b[-1] + nzf * fg.nz_b[-1] / den)),
            float(L * np.sum(fg.arb_q[-1] + nzf * fg.nz_q[-1] / den)),
            float(L * np.sum(fg.arb_v[-1] + nzf * fg.nz_v[-1] / den)))


def settle_borrows(fg: FeeGrowth, p: SimParams, k, to, tc, u, m, put, budget, nzf: float = 1.0) -> dict:
    """Premium, shortfall and fee loss of borrows (bucket k, open step to, restore step tc), with
    exactly simulate_path's rules. nzf scales noise volume (0 disables it)."""
    L, Lbg = p.lp_liquidity, p.background_ratio * p.lp_liquidity
    k, to, tc = (np.asarray(a, np.int64) for a in (k, to, tc))
    u, m, put, budget = (np.asarray(a, float) for a in (u, m, put, budget))
    put = put.astype(bool)
    den_a, den_b = L + Lbg, L * (1 - u) + Lbg

    def d(arr):
        return arr[tc, k] - arr[to, k]

    dab, daq, dav = d(fg.arb_b), d(fg.arb_q), d(fg.arb_v)
    dnb, dnq, dnv = nzf * d(fg.nz_b), nzf * d(fg.nz_q), nzf * d(fg.nz_v)
    fa_b, fa_q, fa_v = L * (dab + dnb / den_a), L * (daq + dnq / den_a), L * (dav + dnv / den_a)
    fb_b = L * (1 - u) * (dab + dnb / den_b)
    fb_q = L * (1 - u) * (daq + dnq / den_b)
    fb_v = L * (1 - u) * (dav + dnv / den_b)
    forgone = u * L * (dav + dnv / den_b)
    sa, sb = fg.sqrt_lo[k], fg.sqrt_hi[k]
    notional = np.where(put, L * u * (sb - sa), L * u * (1 / sa - 1 / sb) * fg.prices[to])
    floor = notional * p.floor_rate * (tc - to) * fg.step_s / YEAR_S
    premium = np.maximum(floor, m * forgone)
    paid = np.minimum(premium, budget * p.lp_cap_frac)
    short = premium - paid
    loss = fa_v - fb_v
    funded = short <= 1e-15
    # protocol share of the premium above forgone fees, only when the LP is paid in full
    cut = np.where(funded, np.minimum(paid, p.protocol_take * np.maximum(0.0, premium - forgone)), 0.0)
    paid = paid - cut
    viol = int(np.sum(funded & (paid + 1e-12 * np.maximum(1.0, np.abs(loss)) < loss)))
    return {"lost_b": float(np.sum(fa_b - fb_b)), "lost_q": float(np.sum(fa_q - fb_q)),
            "lost_v": float(np.sum(loss)), "fees_a_int": float(np.sum(fa_v)), "idle_b_int": float(np.sum(fb_v)),
            "premium": float(np.sum(premium)), "paid": float(np.sum(paid)), "protocol": float(np.sum(cut)),
            "short": float(np.sum(short)),
            "forgone": float(np.sum(forgone)), "short_borrows": int(np.sum(~funded)), "violations": viol,
            "floor_bound": int(np.sum(floor >= m * forgone)), "util_steps": float(np.sum(u * (tc - to)))}


def simulate_demand(fg: FeeGrowth, p: SimParams, u: float, hold_s: float, budget_mode: str, keeper: bool,
                    seed: int, min_budget: float, open_wait_s: float = 3_600.0, nzf: float = 1.0) -> dict:
    """Borrow demand at fixed utilization u: every free borrowable bucket is borrowed again after an
    exponential wait (mean open_wait_s of eligible time) and held exponential(hold_s). Budgets:
    "funded" (100% of notional), "realistic" (simulate_path's: budget_cap_prob of borrowers fund 0.5x
    the expected floor, the rest max(budget_multiple x expected floor, budget_notional_frac x notional)),
    "min" (min_budget, the on-chain minimum). keeper: close keeper_delay_s after the trigger.
    Same restoration guard and retry as simulate_path; same settlement (settle_borrows)."""
    rng = np.random.default_rng(seed)
    T, nbk = fg.T, len(fg.sqrt_lo)
    p_open = min(1.0, fg.step_s / open_wait_s)
    hold_steps = hold_s / fg.step_s
    m = p.curve.multiplier_ppm(math.ceil(u * 1e6)) / 1e6
    L, Lbg = p.lp_liquidity, p.background_ratio * p.lp_liquidity
    den_b = L * (1 - u) + Lbg
    floor_step = p.floor_rate * fg.step_s / YEAR_S
    keeper_steps = max(1, round(p.keeper_delay_s / fg.step_s))
    retry_steps = max(1, round(p.restore_retry_s / fg.step_s))
    trig = p.keeper_trigger * p.lp_cap_frac
    ev = {"k": [], "to": [], "tc": [], "put": [], "budget": []}
    refusals = keeper_closes = 0
    for k in range(nbk):
        E = fg.elig[:, k]
        sa, sb = fg.sqrt_lo[k], fg.sqrt_hi[k]
        t_free = 1
        while True:
            target = E[t_free - 1] + rng.geometric(p_open)
            if target > E[T]:
                break
            to = int(np.searchsorted(E, target, "left"))
            put = bool(fg.s[to] > sb)
            hold = max(1, int(rng.exponential(hold_steps)))
            notional = L * u * (sb - sa) if put else L * u * (1 / sa - 1 / sb) * fg.prices[to]
            exp_floor = notional * floor_step * hold
            under = rng.random() < p.budget_cap_prob
            if budget_mode == "funded":
                budget = notional
            elif budget_mode == "realistic":
                budget = (max(exp_floor * 0.5, 1e-15) if under
                          else max(exp_floor * p.budget_multiple, notional * p.budget_notional_frac))
            elif budget_mode == "min":
                budget = min_budget
            else:
                raise ValueError(f"unknown budget mode {budget_mode!r}")
            tc = min(to + hold, T)
            if keeper:
                thr = trig * budget
                t_floor = to + max(1, math.ceil(thr / (notional * floor_step)))
                seg = fg.arb_v[to:tc + 1, k] + nzf * fg.nz_v[to:tc + 1, k] / den_b
                i = int(np.searchsorted(seg - seg[0], thr / (m * u * L), "left"))
                t_trig = min(t_floor, to + max(i, 1))
                if t_trig <= tc and t_trig + keeper_steps < tc:
                    tc = t_trig + keeper_steps
                    keeper_closes += 1
            while tc < T and not _restoration(p, "put" if put else "call", u, sa, sb, float(fg.prices[tc]), rng):
                refusals += 1
                tc = min(tc + retry_steps, T)
            for key, v in zip(ev, (k, to, tc, put, budget), strict=True):
                ev[key].append(v)
            t_free = tc
    n = len(ev["k"])
    if n:
        r = settle_borrows(fg, p, ev["k"], ev["to"], ev["tc"], [u] * n, [m] * n, ev["put"], ev["budget"], nzf)
    else:
        r = {key: 0.0 for key in ("lost_b", "lost_q", "lost_v", "premium", "paid", "protocol", "short", "forgone",
                                  "util_steps")}
        r.update(short_borrows=0, violations=0, floor_bound=0)
    r.update(borrows=n, refusals=refusals, keeper_closes=keeper_closes, util=r["util_steps"] / (nbk * T))
    return r


def replay_check(prices: np.ndarray, params: SimParams, seed: int) -> dict:
    """Run simulate_path, re-settle its exact borrows with the event engine, return both and the
    largest relative difference (fees, premium, shortfall, forgone, final values)."""
    events: list[Borrow] = []
    ref = simulate_path(prices, params, seed=seed, path_id="replay-check", record=events)
    fg = fee_growth(pool_path(prices, params), params.step_seconds, params, params.noise_volume_per_step)
    if events:
        r = settle_borrows(fg, params, [b.bucket for b in events], [b.opened for b in events],
                           [b.closed for b in events], [b.util for b in events], [b.multiplier for b in events],
                           [b.kind == "put" for b in events], [b.budget for b in events])
    else:
        r = {"lost_v": 0.0, "lost_b": 0.0, "lost_q": 0.0, "paid": 0.0, "protocol": 0.0, "short": 0.0, "forgone": 0.0}
    a_b, a_q, a_v = world_a_fees(fg, params)
    pT = float(fg.prices[-1])
    engine = {"lp_fees_world_a": a_v, "lp_idle_fees_world_b": a_v - r["lost_v"], "premium_paid": r["paid"],
              "shortfall": r["short"], "measured_forgone": r["forgone"], "final_value_a": a_b * pT + a_q,
              "final_value_b": (a_b - r["lost_b"]) * pT + (a_q - r["lost_q"]) + r["paid"]}
    reference = {k: getattr(ref, k) for k in engine}
    rel = {k: abs(engine[k] - reference[k]) / max(abs(reference[k]), 1e-30) for k in engine}
    return {"borrows": ref.borrows, "keeper_closes": ref.keeper_closes, "refusals": ref.restoration_failures,
            "max_rel_error": max(rel.values()), "rel_error": rel, "simulate_path": reference, "event_engine": engine}
