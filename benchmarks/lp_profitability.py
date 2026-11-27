"""Benchmark 4: is providing liquidity through FORGE profitable?

Two claims are tested separately, on every window, and reported even where they fail:

1. Incremental: the same LP capital in FORGE buckets (world B) ends with at least as much as in plain
   Orca (world A), and how much more. B - A = premium paid - fees the borrowed liquidity forwent.
2. Absolute: does the LP make money at all? LP value (liquidity + fees [+ premium]) at the window end
   against simply holding the starting tokens (HODL). Concentrated liquidity can lose to HODL through
   impermanent loss; FORGE does not change the LP's principal (borrowed liquidity is restored exactly),
   so it cannot remove that loss, only add premium on top.

Model (a controlled simulation, not a replay of Orca swaps)
-----------------------------------------------------------
Binance 1-minute bars (benchmarks/data/<SYMBOL>-1m.npz) are expanded to o -> h -> l -> c and o -> l ->
h -> c (OHLC bars do not record intra-bar order, so both are run). A simulated pool follows that path:

* "arb": the pool is arbitraged to every point of the path and earns the fee on every move (the fee
  model of forge_math.lpsim and Benchmark 3). Every sub-fee wiggle pays a fee, so this overstates
  arbitrage income; it is the optimistic end for fee levels.
* "arb-band": the pool only moves when the external price leaves the no-arbitrage band
  [p (1 - f), p (1 + f)] and then only to the band edge (the standard arbitrage-with-fees model). This
  is the conservative lower bound for fee income.
* "band+noise": "arb-band" plus fixed round-trip "noise" volume at the current price, 1x the LP's ladder
  value per day (the in-range pool liquidity turns over ~2x a day), shared pro rata with background
  liquidity. This is an assumption, not a measurement of Orca volume.

On these 15-second OHLC paths "arb" yields fee APRs of several hundred percent on the ladder, far above
anything a real 0.30% pool pays; it is kept only for comparability with Benchmark 3. "arb-band" and
"band+noise" are the realistic range.

The LP holds liquidity L in a ladder of 8 buckets (4 x tick spacing each) centered on the window's start
price, next to 3x as much background (non-FORGE) liquidity. Results are scaled to $10,000 of starting
capital. World A keeps all of it in Orca. World B is the same, except borrowers take a utilization u of
each strictly out-of-range bucket (puts below spot, calls above), hold, and restore it exactly. While
borrowed, that share earns no fees; the borrower pays premium = max(time floor, m(u) x forgone fees),
capped by the borrower's premium budget (less the 1% keeper bounty). The event engine is a fast
re-implementation of forge_math.lpsim.simulate_path and is checked against it at the start of every run
(identical borrow events -> identical fees, premium, shortfall and final values, see "self_check").

Program parameters come from forge_math.lpsim.SimParams and are asserted equal to the on-chain defaults
parsed from programs/forge/src/state.rs and programs/forge/src/math/premium.rs. Where this benchmark
deviates from lpsim it follows the program instead (listed in LPSIM_DEVIATIONS below and in the output).

Usage: uv run --project compiler python benchmarks/lp_profitability.py [--market JUP/USDC] [--quick]
       [--out DIR] [--workers N]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from forge_math import lpsim
from forge_math.lpsim import SimParams, gbm_path, ohlc_path, simulate_path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import markets  # noqa: E402
from lp_guarantee import run_id  # noqa: E402

SEED = 20261127
YEAR_S = 365 * 86_400
CAPITAL_USD = 10_000.0
BAR_STEPS = 4                       # ohlc_path: 4 points per 1-minute bar
OHLC_STEP_S = 15.0
GBM_STEP_S = 60.0
HORIZONS = {"7d": 7, "30d": 30}
NOISE_PER_DAY = 1.0                 # round-trip noise volume per day, x the LP ladder's starting value
OPEN_WAIT_S = 3_600.0               # mean wait (of eligible time) before a free bucket is borrowed again
HOLDS_S = {"short": 8 * 3_600.0, "long": 7 * 86_400.0}   # mean borrow hold (exponential)
UTILS = (0.2, 0.5, 0.8)             # per-bucket utilization taken by a borrower (0.8 = program cap)
KEEPER_DELAY_S = 300.0              # keeper closes this long after the 80%-of-cap trigger
RESTORE_RETRY_S = 3_600.0           # a refused restoration is retried after this delay
MIN_BUDGET_USD = 1e-6               # on-chain minimum: premium_budget > 0, i.e. 1 USDC atom
FEE_MODES = ("arb-band", "band+noise", "arb")
BUDGETS = ("funded", "realistic", "realistic+keeper", "min", "min+keeper")
BUDGET_TEXT = {
    "funded": "every borrower funds 100% of notional (cap never binds)",
    "realistic": "Benchmark 3 base: 90% fund max(3x expected floor, 1% of notional), 10% fund 0.5x expected "
                 "floor; no keeper, every borrow runs its full hold",
    "realistic+keeper": "as realistic, but a keeper closes the position 5 min after accrued premium reaches "
                        "80% of the cap (the on-chain trigger)",
    "min": "adversarial: every borrower funds the on-chain minimum (1 USDC atom); no keeper ever closes",
    "min+keeper": "adversarial minimum budget, with a keeper closing 5 min after the 80% trigger",
}
LPSIM_DEVIATIONS = [
    "Time-floor notional of a call (borrowed base) is valued at the open reference price, as "
    "strategy_open.rs stores notional_quote; lpsim values it at the close price.",
    "Keeper trigger modeled (budgets *+keeper): anyone may close once accrued premium >= 80% of the LP cap "
    "(keeper_trigger_bps = 8000); lpsim never closes early.",
    "Restoration guard: besides lpsim's buffer-vs-cost test, a restoration whose swap cost exceeds "
    "swap_slippage_bps (50) is refused and retried after 1 h with the liquidity still out of the pool and "
    "premium still accruing (the program's Recovery path); lpsim only counts the failure.",
    "Borrow utilization is fixed per demand level (0.2 / 0.5 / 0.8) instead of uniform(0.2, 0.8), and "
    "open/hold rates are set by the demand sweep instead of open_prob / mean_hold_steps.",
    "Fee model 'arb-band' (no-arbitrage band) added; lpsim's model ('arb') charges the fee on every move.",
    "Noise volume is scaled to the ladder's actual starting value. lpsim's lp_notional is "
    "sum(L (sqrt p_b - sqrt p_a)) x sqrt(P0), i.e. sqrt(P0) times the ladder's value, so Benchmark 3's "
    "'base+noise' carries ~10x the stated noise volume on SOL/USDC (sqrt(73) ~ 8.6 at the GBM start, "
    "~11 on 2026 history) and ~0.5x on JUP/USDC.",
]


# ---------------------------------------------------------------------------------------------
# Program parameters: assert the simulation uses the on-chain defaults
# ---------------------------------------------------------------------------------------------


def program_params(p: SimParams) -> dict:
    state = (ROOT / "programs/forge/src/state.rs").read_text()
    prem = (ROOT / "programs/forge/src/math/premium.rs").read_text()

    def num(src: str, name: str) -> int:
        m = re.search(rf"\b{name}:\s*([\d_]+)", src)
        if not m:
            raise SystemExit(f"could not find {name} in program source")
        return int(m.group(1).replace("_", ""))

    onchain = {k: num(state, k) for k in ("floor_rate_bps", "restoration_buffer_bps", "swap_slippage_bps",
                                          "keeper_trigger_bps", "bounty_bps", "max_buckets_per_strategy")}
    onchain["curve"] = {k: num(prem, k) for k in ("base_ppm", "slope1_ppm", "kink_ppm", "slope2_ppm", "cap_ppm")}
    used = {"floor_rate_bps": round(p.floor_rate * 1e4), "restoration_buffer_bps": round(p.restoration_buffer * 1e4),
            "swap_slippage_bps": 50, "keeper_trigger_bps": 8_000, "bounty_bps": 100,
            "max_buckets_per_strategy": p.n_buckets, "curve": asdict(p.curve)}
    mismatch = {k: (used[k], onchain[k]) for k in onchain if used[k] != onchain[k]}
    if mismatch:
        raise SystemExit(f"simulation parameters differ from the program defaults: {mismatch}")
    return {"onchain_defaults": onchain, "used": used, "match": True}


# ---------------------------------------------------------------------------------------------
# Per-path precomputation: fee growth per bucket as prefix sums over steps
# ---------------------------------------------------------------------------------------------


@dataclass
class Win:
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


def ladder(p0: float, p: SimParams) -> tuple[np.ndarray, np.ndarray]:
    start_tick = math.log(p0) / math.log(1.0001)
    w = p.bucket_width_ticks
    center = math.floor(start_tick / w) * w
    lowers = np.array([center + (k - p.n_buckets // 2) * w for k in range(p.n_buckets)], float)
    return np.sqrt(lpsim.tick_price(lowers)), np.sqrt(lpsim.tick_price(lowers + w))


def lp_notional(w: Win, L: float = 1.0) -> float:
    return float(np.sum(L * (w.sqrt_hi - w.sqrt_lo) * w.s[0]))


def precompute(prices: np.ndarray, step_s: float, p: SimParams, noise_per_step: float,
               noise_notional: float | None = None) -> Win:
    """Mirror of lpsim.simulate_path's fee accrual, vectorized over steps. Noise volume is
    noise_per_step x noise_notional (default: lpsim's lp_notional, for the self-check)."""
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
    win = Win(prices=prices, s=s, step_s=step_s, sqrt_lo=sqrt_lo, sqrt_hi=sqrt_hi,
              arb_b=np.vstack([z, np.cumsum(db, axis=0)]), arb_q=np.vstack([z, np.cumsum(dq, axis=0)]),
              arb_v=np.vstack([z, np.cumsum(db * pt + dq, axis=0)]),
              nz_b=z, nz_q=z, nz_v=z, elig=np.zeros(1))
    if noise_per_step > 0:
        inside = (s1[:, None] >= sqrt_lo) & (s1[:, None] < sqrt_hi)
        scale = lp_notional(win) if noise_notional is None else noise_notional
        fee_q = p.fee_rate * keep * noise_per_step * scale / 2
        nq = inside * fee_q
        nb = nq / pt
        win.nz_q = np.vstack([z, np.cumsum(nq, axis=0)])
        win.nz_b = np.vstack([z, np.cumsum(nb, axis=0)])
        win.nz_v = np.vstack([z, np.cumsum(nq + nb * pt, axis=0)])
    else:
        win.nz_q = win.nz_b = win.nz_v = np.zeros_like(win.arb_v)
    el = (s1[:, None] < sqrt_lo) | (s1[:, None] > sqrt_hi)
    win.elig = np.vstack([np.zeros((1, len(sqrt_lo)), np.int64), np.cumsum(el, axis=0)])
    return win


def band_path(q: np.ndarray, f: float) -> np.ndarray:
    """Pool price under arbitrage with fee f: it moves only to the edge of the no-arbitrage band."""
    out = np.empty(len(q))
    lo_m, hi_m = 1.0 / (1.0 + f), 1.0 / (1.0 - f)
    pp = float(q[0])
    for i, x in enumerate(q.tolist()):
        lo, hi = x * lo_m, x * hi_m
        if pp < lo:
            pp = lo
        elif pp > hi:
            pp = hi
        out[i] = pp
    return out


# ---------------------------------------------------------------------------------------------
# Settlement of a set of borrows (vectorized), the core shared with the lpsim self-check
# ---------------------------------------------------------------------------------------------


def settle(w: Win, p: SimParams, nzf: float, k, to, tc, u, m, put, budget, call_notional_at_close=False) -> dict:
    """Premium, shortfall and fee loss of borrows (bucket k, open step to, close step tc)."""
    L, Lbg = p.lp_liquidity, p.background_ratio * p.lp_liquidity
    k, to, tc = (np.asarray(a, np.int64) for a in (k, to, tc))
    u, m, put, budget = (np.asarray(a, float) for a in (u, m, put, budget))
    put = put.astype(bool)
    den_a, den_b = L + Lbg, L * (1 - u) + Lbg

    def d(arr):
        return arr[tc, k] - arr[to, k]

    dab, daq, dav = d(w.arb_b), d(w.arb_q), d(w.arb_v)
    dnb, dnq, dnv = nzf * d(w.nz_b), nzf * d(w.nz_q), nzf * d(w.nz_v)
    fa_b, fa_q, fa_v = L * (dab + dnb / den_a), L * (daq + dnq / den_a), L * (dav + dnv / den_a)
    fb_b = L * (1 - u) * (dab + dnb / den_b)
    fb_q = L * (1 - u) * (daq + dnq / den_b)
    fb_v = L * (1 - u) * (dav + dnv / den_b)
    forgone = u * L * (dav + dnv / den_b)
    sa, sb = w.sqrt_lo[k], w.sqrt_hi[k]
    px = w.prices[tc] if call_notional_at_close else w.prices[to]
    notional = np.where(put, L * u * (sb - sa), L * u * (1 / sa - 1 / sb) * px)
    floor = notional * p.floor_rate * (tc - to) * w.step_s / YEAR_S
    premium = np.maximum(floor, m * forgone)
    paid = np.minimum(premium, budget * 0.99)
    short = premium - paid
    loss = fa_v - fb_v
    funded = short <= 1e-15
    viol = int(np.sum(funded & (paid + 1e-12 * np.maximum(1.0, np.abs(loss)) < loss)))
    return {"lost_b": float(np.sum(fa_b - fb_b)), "lost_q": float(np.sum(fa_q - fb_q)),
            "lost_v": float(np.sum(loss)), "fees_a_int": float(np.sum(fa_v)), "idle_b_int": float(np.sum(fb_v)),
            "premium": float(np.sum(premium)), "paid": float(np.sum(paid)), "short": float(np.sum(short)),
            "forgone": float(np.sum(forgone)), "short_borrows": int(np.sum(~funded)), "violations": viol,
            "floor_bound": int(np.sum(floor >= m * forgone)), "util_steps": float(np.sum(u * (tc - to)))}


def world_a(w: Win, p: SimParams, nzf: float) -> tuple[float, float, float]:
    """LP fees in plain Orca over the whole path: (base, quote, quote value at accrual time)."""
    L, Lbg = p.lp_liquidity, p.background_ratio * p.lp_liquidity
    den = L + Lbg
    return (float(L * np.sum(w.arb_b[-1] + nzf * w.nz_b[-1] / den)),
            float(L * np.sum(w.arb_q[-1] + nzf * w.nz_q[-1] / den)),
            float(L * np.sum(w.arb_v[-1] + nzf * w.nz_v[-1] / den)))


def principal(w: Win, sp: float, L: float = 1.0) -> tuple[float, float]:
    """(base, quote) held by the ladder at sqrt price sp."""
    s = np.clip(sp, w.sqrt_lo, w.sqrt_hi)
    return float(np.sum(L * (1 / s - 1 / w.sqrt_hi))), float(np.sum(L * (s - w.sqrt_lo)))


# ---------------------------------------------------------------------------------------------
# Borrow demand: event generation (sequential per bucket, geometric waits over eligible steps)
# ---------------------------------------------------------------------------------------------


def generate(w: Win, p: SimParams, nzf: float, u: float, hold_s: float, budget_mode: str, seed: int,
             usd_per_unit: float) -> dict:
    rng = np.random.default_rng(seed)
    T, nbk = w.T, len(w.sqrt_lo)
    p_open = min(1.0, w.step_s / OPEN_WAIT_S)
    hold_steps = hold_s / w.step_s
    m = p.curve.multiplier_ppm(math.ceil(u * 1e6)) / 1e6
    L, Lbg = p.lp_liquidity, p.background_ratio * p.lp_liquidity
    den_b = L * (1 - u) + Lbg
    floor_step = p.floor_rate * w.step_s / YEAR_S
    keeper = budget_mode.endswith("+keeper")
    keeper_steps = max(1, round(KEEPER_DELAY_S / w.step_s))
    retry_steps = max(1, round(RESTORE_RETRY_S / w.step_s))
    min_budget = MIN_BUDGET_USD / usd_per_unit
    ev = {"k": [], "to": [], "tc": [], "put": [], "budget": []}
    refusals = keeper_closes = 0
    for k in range(nbk):
        E = w.elig[:, k]
        sa, sb = w.sqrt_lo[k], w.sqrt_hi[k]
        t_free = 1
        while True:
            target = E[t_free - 1] + rng.geometric(p_open)
            if target > E[T]:
                break
            to = int(np.searchsorted(E, target, "left"))
            put = bool(w.s[to] > sb)
            hold = max(1, int(rng.exponential(hold_steps)))
            notional = L * u * (sb - sa) if put else L * u * (1 / sa - 1 / sb) * w.prices[to]
            exp_floor = notional * floor_step * hold
            under = rng.random() < p.budget_cap_prob
            if budget_mode == "funded":
                budget = notional
            elif budget_mode.startswith("realistic"):
                budget = (max(exp_floor * 0.5, 1e-15) if under
                          else max(exp_floor * p.budget_multiple, notional * p.budget_notional_frac))
            else:
                budget = min_budget
            tc = min(to + hold, T)
            if keeper:
                thr = 0.8 * 0.99 * budget
                t_floor = to + max(1, math.ceil(thr / (notional * floor_step)))
                seg = w.arb_v[to:tc + 1, k] + nzf * w.nz_v[to:tc + 1, k] / den_b
                i = int(np.searchsorted(seg - seg[0], thr / (m * u * L), "left"))
                t_trig = min(t_floor, to + max(i, 1))
                if t_trig <= tc and t_trig + keeper_steps < tc:
                    tc = t_trig + keeper_steps
                    keeper_closes += 1
            while tc < T:   # guarded restoration (end-of-path closes are forced, as in lpsim)
                sp = w.s[tc]
                sc = min(max(sp, sa), sb)
                x, y = L * u * (1 / sc - 1 / sb), L * u * (sc - sa)
                if put:
                    full = L * u * (sb - sa)
                    deficit = x * w.prices[tc]
                    margin = full - (x * w.prices[tc] + y) + p.restoration_buffer * full
                else:
                    full = L * u * (1 / sa - 1 / sb) * w.prices[tc]
                    deficit = y
                    margin = full - (x * w.prices[tc] + y) + p.restoration_buffer * full
                if deficit <= 0:
                    break
                cost = min(rng.exponential(p.restore_cost_bps_mean), p.restore_cost_bps_max)
                if cost <= 50.0 and deficit * cost / 1e4 <= margin + 1e-15:
                    break
                refusals += 1
                tc = min(tc + retry_steps, T)
            for key, v in zip(ev, (k, to, tc, put, budget), strict=True):
                ev[key].append(v)
            t_free = tc
    n = len(ev["k"])
    if n:
        r = settle(w, p, nzf, ev["k"], ev["to"], ev["tc"], [u] * n, [m] * n, ev["put"], ev["budget"])
    else:
        r = {key: 0.0 for key in ("lost_b", "lost_q", "lost_v", "premium", "paid", "short", "forgone",
                                  "util_steps")}
        r.update(short_borrows=0, violations=0, floor_bound=0)
    r.update(borrows=n, refusals=refusals, keeper_closes=keeper_closes, util=r["util_steps"] / (nbk * T))
    return r


# ---------------------------------------------------------------------------------------------
# One path: every fee mode x demand x budget
# ---------------------------------------------------------------------------------------------

CONFIGS = [("none", 0.0, "", "-")] + [
    (f"u{round(u * 100)}-{h}", u, h, b) for u in UTILS for h in HOLDS_S for b in BUDGETS]
METRICS = ("v0", "hodl", "pos", "fees_a", "fees_b", "paid", "premium", "short", "forgone", "lost_v", "borrows",
           "short_borrows", "refusals", "keeper_closes", "util", "violations", "days", "floor_bound")
USD_METRICS = ("v0", "hodl", "pos", "fees_a", "fees_b", "paid", "premium", "short", "forgone", "lost_v")


def run_path(task: dict) -> np.ndarray:
    p: SimParams = task["params"]
    out = np.zeros((len(FEE_MODES), len(CONFIGS), len(METRICS)))
    noise_step = NOISE_PER_DAY * task["step_s"] / 86_400
    band = task["band"]
    sl0, sh0 = ladder(float(band[0]), p)
    xb, yb = principal(Win(band, np.sqrt(band), 0, sl0, sh0, *([None] * 7)), math.sqrt(band[0]))
    wins = {"tick": precompute(task["tick"], task["step_s"], p, 0.0),
            "band": precompute(band, task["step_s"], p, noise_step, noise_notional=xb * band[0] + yb)}
    for fi, mode in enumerate(FEE_MODES):
        w = wins["tick" if mode == "arb" else "band"]
        nzf = 1.0 if mode == "band+noise" else 0.0
        x0, y0 = principal(w, w.s[0])
        v0 = x0 * w.prices[0] + y0
        pT = float(w.prices[-1])
        hodl = x0 * pT + y0
        xT, yT = principal(w, w.s[-1])
        pos = xT * pT + yT
        a_b, a_q, _ = world_a(w, p, nzf)
        fees_a = a_b * pT + a_q
        usd = CAPITAL_USD / v0
        days = w.T * w.step_s / 86_400
        for ci, (name, u, hold, budget) in enumerate(CONFIGS):
            if name == "none":
                r = {"lost_b": 0.0, "lost_q": 0.0, "lost_v": 0.0, "paid": 0.0, "premium": 0.0, "short": 0.0,
                     "forgone": 0.0, "borrows": 0, "short_borrows": 0, "refusals": 0, "keeper_closes": 0,
                     "util": 0.0, "violations": 0, "floor_bound": 0}
            else:
                di = CONFIGS.index((name, u, hold, "funded"))
                r = generate(w, p, nzf, u, HOLDS_S[hold], budget, task["seed"] + 1_000 * di, usd)
            fees_b = (a_b - r["lost_b"]) * pT + (a_q - r["lost_q"]) + r["paid"]
            row = {"v0": v0, "hodl": hodl, "pos": pos, "fees_a": fees_a, "fees_b": fees_b, "days": days, **r}
            out[fi, ci] = [row[mtr] * (usd if mtr in USD_METRICS else 1.0) for mtr in METRICS]
    return out


# ---------------------------------------------------------------------------------------------
# Paths: rolling historical windows, targeted stress windows, synthetic GBM
# ---------------------------------------------------------------------------------------------


def historical_tasks(mk: markets.Market, p: SimParams, quick: bool, stride_days: int) -> tuple[list, list]:
    d = np.load(mk.history_path())
    o, h, lo, c = d["open"], d["high"], d["low"], d["close"]
    n_bars = len(c)
    expanded = {hf: ohlc_path(o, h, lo, c, hf) for hf in (True, False)}
    banded = {hf: band_path(expanded[hf], p.fee_rate) for hf in (True, False)}
    lr = np.diff(np.log(c), prepend=math.log(o[0]))
    cs1, cs2 = np.concatenate([[0.0], np.cumsum(lr)]), np.concatenate([[0.0], np.cumsum(lr * lr)])

    def stats(i: int, nb: int) -> tuple[float, float]:
        ret = float(c[i + nb - 1] / o[i] - 1)
        s1, s2 = cs1[i + nb] - cs1[i], cs2[i + nb] - cs2[i]
        vol = math.sqrt(max(s2 / nb - (s1 / nb) ** 2, 0.0) * 525_600)
        return ret, vol

    def date(i: int) -> str:
        return f"{datetime.fromtimestamp(int(d['open_ms'][i]) / 1000, UTC):%Y-%m-%d %H:%M}"

    tasks, windows = [], []

    def add(i: int, nb: int, horizon: str, kind: str, tags: list[str]):
        ret, vol = stats(i, nb)
        for hf in (True, False):
            sl = slice(i * BAR_STEPS, (i + nb) * BAR_STEPS)
            wid = f"{kind}-{horizon}-{date(i).replace(' ', 'T')}-{'HL' if hf else 'LH'}"
            windows.append({"id": wid, "source": kind, "horizon": horizon, "start": date(i), "ordering":
                            "HL" if hf else "LH", "return": ret, "realized_vol": vol, "tags": tags})
            tasks.append({"tick": expanded[hf][sl], "band": banded[hf][sl], "step_s": OHLC_STEP_S})

    for horizon, days in HORIZONS.items():
        nb = days * 1440
        starts = list(range(0, n_bars - nb + 1, stride_days * 1440))
        st = np.array([stats(i, nb) for i in starts])
        q = {"worst-decile-return": st[:, 0] <= np.quantile(st[:, 0], 0.1),
             "best-decile-return": st[:, 0] >= np.quantile(st[:, 0], 0.9),
             "top-decile-vol": st[:, 1] >= np.quantile(st[:, 1], 0.9)}
        for j, i in enumerate(starts):
            add(i, nb, horizon, "hist", [f"hist-{horizon}-all"] + [f"hist-{horizon}-{t}" for t, msk in q.items()
                                                                  if msk[j]])
        # targeted stress: hourly starts, top non-overlapping windows by return / vol
        hs = np.arange(0, n_bars - nb + 1, 60)
        hst = np.array([stats(i, nb) for i in hs])
        n_pick = 1 if quick else 3
        for label, key in (("drawdown", hst[:, 0]), ("rally", -hst[:, 0]), ("vol", -hst[:, 1])):
            picked: list[int] = []
            for j in np.argsort(key):
                i = int(hs[j])
                if all(abs(i - x) >= nb for x in picked):
                    picked.append(i)
                if len(picked) == n_pick:
                    break
            for i in picked:
                add(i, nb, horizon, "stress", [f"stress-{horizon}-{label}"])
    return tasks, windows


def gbm_tasks(start: float, p: SimParams, quick: bool) -> tuple[list, list]:
    tasks, windows = [], []
    seeds = 2 if quick else 10
    for horizon, days in HORIZONS.items():
        for vol in (0.9, 1.4):
            for i in range(seeds):
                s = SEED + int(vol * 1000) + 100 * days + i
                path = gbm_path(start, days * 1440, vol, seed=s, step_seconds=GBM_STEP_S)
                windows.append({"id": f"gbm-{horizon}-vol{vol}-s{s}", "source": "gbm", "horizon": horizon,
                                "start": None, "ordering": None, "return": float(path[-1] / path[0] - 1),
                                "realized_vol": vol, "tags": [f"gbm-{horizon}-vol{vol}"]})
                tasks.append({"tick": path, "band": band_path(path, p.fee_rate), "step_s": GBM_STEP_S})
    return tasks, windows


# ---------------------------------------------------------------------------------------------
# Self-check against forge_math.lpsim.simulate_path
# ---------------------------------------------------------------------------------------------


def self_check(mk: markets.Market, p: SimParams) -> dict:
    """Run lpsim on two days of history, record its borrow events, re-settle them here, compare."""
    d = np.load(mk.history_path())
    n = 2 * 1440
    prices = ohlc_path(d["open"][:n], d["high"][:n], d["low"][:n], d["close"][:n], True)
    out = {}
    for label, noise in (("arb", 0.0), ("arb+noise", 0.0005)):
        params = replace(p, step_seconds=OHLC_STEP_S, open_prob=0.01, mean_hold_steps=600.0,
                         restore_cost_bps_mean=0.0, restore_cost_bps_max=0.0, noise_volume_per_step=noise)
        events: list = []
        orig = lpsim.Borrow

        class Rec(orig):
            def __init__(self, *a, _ev=events, **kw):
                super().__init__(*a, **kw)
                _ev.append(self)

        lpsim.Borrow = Rec
        try:
            ref = simulate_path(prices, params, seed=SEED, path_id="self-check")
        finally:
            lpsim.Borrow = orig
        w = precompute(prices, OHLC_STEP_S, params, noise)
        T = w.T
        r = settle(w, params, 1.0, [b.bucket for b in events], [b.opened for b in events],
                   [min(b.close_at, T) for b in events], [b.util for b in events], [b.multiplier for b in events],
                   [b.kind == "put" for b in events], [b.budget for b in events], call_notional_at_close=True)
        a_b, a_q, a_v = world_a(w, params, 1.0)
        pT = float(prices[-1])
        mine = {"lp_fees_world_a": a_v, "lp_idle_fees_world_b": a_v - r["lost_v"], "premium_paid": r["paid"],
                "shortfall": r["short"], "measured_forgone": r["forgone"], "final_value_a": a_b * pT + a_q,
                "final_value_b": (a_b - r["lost_b"]) * pT + (a_q - r["lost_q"]) + r["paid"]}
        theirs = {k: getattr(ref, k) for k in mine}
        rel = {k: abs(mine[k] - theirs[k]) / max(abs(theirs[k]), 1e-30) for k in mine}
        ok = all(v < 1e-7 for v in rel.values()) and len(events) == ref.borrows
        out[label] = {"borrows": ref.borrows, "max_rel_error": max(rel.values()), "ok": ok, "lpsim": theirs}
        if not ok:
            raise SystemExit(f"self-check against lpsim failed ({label}): {rel}")
    return out


# ---------------------------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------------------------


def _q(a: np.ndarray, qq: float) -> float:
    return float(np.quantile(a, qq)) if len(a) else float("nan")


def derived(res: np.ndarray) -> dict[str, np.ndarray]:
    """res[..., metric] -> named per-window arrays (USD and bps of starting capital)."""
    g = {mtr: res[..., i] for i, mtr in enumerate(METRICS)}
    v0 = g["v0"]
    a = g["pos"] + g["fees_a"]
    b = g["pos"] + g["fees_b"]
    yr = 365.0 / g["days"]
    return {"A": a, "B": b, "HODL": g["hodl"], "extra_usd": b - a, "extra_bps": (b - a) / v0 * 1e4,
            "b_hodl_bps": (b - g["hodl"]) / v0 * 1e4, "a_hodl_bps": (a - g["hodl"]) / v0 * 1e4,
            "il_bps": (g["pos"] - g["hodl"]) / v0 * 1e4, "apr_a": g["fees_a"] / v0 * yr,
            "apr_b": g["fees_b"] / v0 * yr, "short_usd": g["short"], "short_bps": g["short"] / v0 * 1e4,
            "extra_accrual_bps": (g["paid"] - g["lost_v"]) / v0 * 1e4, "gain_bps": (b - v0) / v0 * 1e4, **g}


def summarize_group(dv: dict[str, np.ndarray]) -> dict:
    e = dv["extra_bps"]
    tol = 1e-6
    return {
        "n": len(e), "extra_bps_mean": float(np.mean(e)), "extra_bps_median": _q(e, 0.5), "extra_bps_p5": _q(e, 0.05),
        "extra_bps_min": float(np.min(e)), "extra_usd_min": float(np.min(dv["extra_usd"])),
        "share_B_ge_A": float(np.mean(e >= -tol)), "share_B_gt_HODL": float(np.mean(dv["b_hodl_bps"] > 0)),
        "share_A_gt_HODL": float(np.mean(dv["a_hodl_bps"] > 0)),
        "share_B_gt_start": float(np.mean(dv["gain_bps"] > 0)),
        "share_B_ge_A_accrual": float(np.mean(dv["extra_accrual_bps"] >= -tol)),
        "extra_accrual_bps_median": _q(dv["extra_accrual_bps"], 0.5),
        "b_minus_hodl_bps_median": _q(dv["b_hodl_bps"], 0.5), "a_minus_hodl_bps_median": _q(dv["a_hodl_bps"], 0.5),
        "b_minus_hodl_bps_mean": float(np.mean(dv["b_hodl_bps"])),
        "a_minus_hodl_bps_mean": float(np.mean(dv["a_hodl_bps"])),
        "il_bps_median": _q(dv["il_bps"], 0.5),
        "apr_a_mean": float(np.mean(dv["apr_a"])), "apr_b_mean": float(np.mean(dv["apr_b"])),
        "apr_a_median": _q(dv["apr_a"], 0.5), "apr_b_median": _q(dv["apr_b"], 0.5),
        "util_mean": float(np.mean(dv["util"])), "borrows_mean": float(np.mean(dv["borrows"])),
        "windows_with_shortfall": int(np.sum(dv["short"] > 1e-12)),
        "shortfall_bps_mean": float(np.mean(dv["short_bps"])), "refusals": int(np.sum(dv["refusals"])),
        "guarantee_violations": int(np.sum(dv["violations"])),
    }


def summaries(res: np.ndarray, windows: list[dict]) -> list[dict]:
    tags = sorted({t for w in windows for t in w["tags"]})
    tags += ["hist-all"]
    rows = []
    for tag in tags:
        if tag == "hist-all":
            idx = [i for i, w in enumerate(windows) if w["source"] == "hist"]
        else:
            idx = [i for i, w in enumerate(windows) if tag in w["tags"]]
        if not idx:
            continue
        for fi, mode in enumerate(FEE_MODES):
            for ci, (name, _, _, budget) in enumerate(CONFIGS):
                dv = derived(res[idx, fi, ci])
                rows.append({"regime": tag, "fee_mode": mode, "demand": name, "budget": budget,
                             **summarize_group(dv)})
    return rows


def failure_modes(res: np.ndarray, windows: list[dict]) -> dict:
    """Every (window, fee mode, config) where FORGE LP < plain Orca LP, grouped and explained."""
    dv = derived(res)
    e, s, ea = dv["extra_bps"], dv["short_bps"], dv["extra_accrual_bps"]
    out = {}
    for fi, mode in enumerate(FEE_MODES):
        for ci, (name, _, _, budget) in enumerate(CONFIGS):
            if name == "none":
                continue
            bad = np.where(e[:, fi, ci] < -1e-6)[0]
            key = f"{mode}/{name}/{budget}"
            if not len(bad):
                continue
            by_short = [i for i in bad if e[i, fi, ci] + s[i, fi, ci] >= -1e-6]
            # premium covered the forgone fees at accrual-time prices, but world A's fees, kept in kind
            # (base fees earned while the price fell), were worth more at the window-end price
            by_reval = [i for i in bad if i not in set(by_short) and ea[i, fi, ci] >= -1e-6]
            refused = [i for i in bad if res[i, fi, ci, METRICS.index("refusals")] > 0]
            worst = int(bad[np.argmin(e[bad, fi, ci])])
            out[key] = {"fee_mode": mode, "demand": name, "budget": budget, "windows": len(e),
                        "B_lt_A": len(bad), "explained_by_premium_shortfall": len(by_short),
                        "explained_by_in_kind_revaluation": len(by_reval),
                        "other_cause": len(bad) - len(by_short) - len(by_reval),
                        "with_restoration_refusals": len(refused),
                        "accrual_time_guarantee_violations": int(np.sum(res[:, fi, ci, METRICS.index("violations")])),
                        "worst_extra_bps": float(e[worst, fi, ci]),
                        "worst_extra_usd": float(dv["extra_usd"][worst, fi, ci]),
                        "worst_shortfall_usd": float(dv["short_usd"][worst, fi, ci]),
                        "worst_window": windows[worst]["id"], "worst_window_return": windows[worst]["return"]}
    return out


# ---------------------------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------------------------


def _f(x: float, nd: int = 1) -> str:
    return "n/a" if x != x else f"{x:,.{nd}f}"


def _pct(x: float) -> str:
    return "n/a" if x != x else f"{x:.1%}"


def write_md(path: Path, mk: markets.Market, meta: dict, rows: list[dict], fails: dict) -> str:
    idx = {(r["regime"], r["fee_mode"], r["demand"], r["budget"]): r for r in rows}

    def find(regime, mode, demand, budget):
        return idx.get((regime, mode, demand, "-" if demand == "none" else budget))

    demands = [c[0] for c in CONFIGS if c[3] in ("-", "realistic")]
    L = [f"# Benchmark 4: is providing liquidity through FORGE profitable? ({mk.name})", "",
         f"Historical-price-driven simulation: Binance {mk.symbol} 1-minute bars ({meta['history_span']}) drive a "
         f"simulated Orca pool (fee {mk.fee_rate:.2%}, buckets of {mk.bucket_ticks} ticks, 8-bucket ladder centred "
         "on each window's start price, the LP is 25% of active liquidity). This is not a replay of real Orca "
         "swaps or of real FORGE borrowing: fees come from simulated arbitrage (and optional noise volume) along "
         "the historical price path, and borrow demand and budgets are assumptions, swept below. Each window "
         "deploys $10,000; bps are of starting capital. A = plain Orca LP, B = FORGE LP, HODL = hold the "
         "starting tokens; all valued at the window-end price (fees in kind, premium in USDC).", "",
         f"Windows: rolling 7-day and 30-day windows starting every {meta['stride_days']} day(s), both intrabar "
         "orderings; the 3 worst drawdowns, biggest rallies and highest-volatility windows per horizon (hourly "
         "starts, non-overlapping); synthetic GBM at 90% and 140% annual vol (10 seeds each). "
         f"{meta['n_windows']} windows x {len(FEE_MODES)} fee models x {len(CONFIGS)} demand/budget configs; "
         f"runtime {meta['seconds']:.0f} s.", "",
         "Program parameters (asserted equal to the programs/forge defaults): floor 5%/yr on borrowed notional, "
         "m(u) = 1 + u to 60%, 1.6 + 6(u - 0.6) to the 80% cap, LP cap = budget - 1% keeper bounty, keeper "
         "trigger at 80% of the cap, restoration buffer 2%, swap slippage cap 0.5%. The event engine reproduces "
         f"forge_math.lpsim exactly on identical borrows (max relative error {meta['self_check_max_rel_error']:.1e}).",
         "",
         f"Fee models: **arb-band** = arbitrage only, pool follows the price only outside the {mk.fee_rate:.2%} "
         "no-arbitrage band (conservative lower bound); **band+noise** = arb-band plus round-trip noise volume of "
         "1x the LP's ladder value per day (an assumption; the in-range pool turns over ~2x a day); **arb** = "
         "Benchmark 3 / lpsim's model, fee on every 15 s path point, which gives fee APRs of hundreds of percent "
         "and is shown only for comparison.", "",
         "Demand: `uXX-short|long` = borrowers take XX% of every borrowable (strictly out-of-range) bucket, "
         "re-borrow after ~1 h, hold 8 h (short) or 7 days (long) on average. Budgets: "
         + "; ".join(f"**{k}** = {v}" for k, v in BUDGET_TEXT.items()) + ".", ""]

    for regime in ("hist-7d-all", "hist-30d-all"):
        for mode in ("arb-band", "band+noise"):
            L += [f"## {regime}, fee model {mode}", "",
                  "Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR "
                  "under realistic budgets.", "",
                  "| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) "
                  "| extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median "
                  "| APR B median | avg util |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
            for dmd in demands:
                r, k = find(regime, mode, dmd, "realistic"), find(regime, mode, dmd, "realistic+keeper")
                if not r:
                    continue
                k = k or r
                L.append(f"| {dmd} | {r['n']} | {_pct(r['share_B_ge_A'])} | {_f(r['extra_bps_median'])} | "
                         f"{_f(r['extra_bps_p5'])} | {_f(r['extra_bps_min'])} | {_pct(k['share_B_ge_A'])} | "
                         f"{_f(k['extra_bps_median'])} | {_f(k['extra_bps_min'])} | {_pct(r['share_A_gt_HODL'])} | "
                         f"{_pct(r['share_B_gt_HODL'])} | {_pct(r['apr_a_median'])} | {_pct(r['apr_b_median'])} | "
                         f"{_pct(r['util_mean'])} |")
            L.append("")

    for mode in ("arb-band", "band+noise"):
        L += [f"## Budget sensitivity: all historical windows, fee model {mode}", "",
              "| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows "
              "with shortfall | B > HODL | APR B median |", "|---|---|---|---|---|---|---|---|---|---|"]
        for dmd in ("u20-short", "u50-short", "u80-short", "u50-long", "u80-long"):
            for b in BUDGETS:
                r = find("hist-all", mode, dmd, b)
                if r:
                    L.append(f"| {dmd} | {b} | {_pct(r['share_B_ge_A'])} | {_f(r['extra_bps_median'])} | "
                             f"{_f(r['extra_bps_p5'])} | {_f(r['extra_bps_min'])} | {_f(r['extra_usd_min'], 2)} | "
                             f"{r['windows_with_shortfall']} | {_pct(r['share_B_gt_HODL'])} | "
                             f"{_pct(r['apr_b_median'])} |")
        L.append("")

    L += ["## Regimes: fee model arb-band, demand u50-short", "",
          "| regime | n | median return | B >= A (realistic) | extra median bps | extra min bps | B >= A (+keeper) "
          "| A > HODL | B > HODL | A-HODL median bps | B-HODL median bps | APR A median | APR B median |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for regime in sorted({r["regime"] for r in rows}):
        r, k = find(regime, "arb-band", "u50-short", "realistic"), find(regime, "arb-band", "u50-short",
                                                                         "realistic+keeper")
        if r and k:
            L.append(f"| {regime} | {r['n']} | {_pct(meta['regime_median_return'].get(regime, float('nan')))} | "
                     f"{_pct(r['share_B_ge_A'])} | {_f(r['extra_bps_median'])} | {_f(r['extra_bps_min'])} | "
                     f"{_pct(k['share_B_ge_A'])} | {_pct(r['share_A_gt_HODL'])} | {_pct(r['share_B_gt_HODL'])} | "
                     f"{_f(r['a_minus_hodl_bps_median'])} | {_f(r['b_minus_hodl_bps_median'])} | "
                     f"{_pct(r['apr_a_median'])} | {_pct(r['apr_b_median'])} |")
    L.append("")

    L += ["## Benchmark 3 fee model (arb) for comparison: all historical windows", "",
          "| demand | budget | APR A median | APR B median | B >= A | extra median bps | extra min bps |",
          "|---|---|---|---|---|---|---|"]
    for dmd in demands:
        for b in ("funded", "realistic", "realistic+keeper"):
            r = find("hist-all", "arb", dmd, b)
            if r and (dmd != "none" or b == "funded"):
                L.append(f"| {dmd} | {r['budget']} | {_pct(r['apr_a_median'])} | {_pct(r['apr_b_median'])} | "
                         f"{_pct(r['share_B_ge_A'])} | {_f(r['extra_bps_median'])} | {_f(r['extra_bps_min'])} |")
    L.append("")

    L += ["## Failure modes: FORGE LP < plain Orca LP", "",
          "Cases = windows x the 6 demand levels, over every regime (historical, stress, GBM). Causes: "
          "**shortfall** = the gap closes if the premium above the borrower's capped budget had been paid; "
          "**in-kind** = the premium covered the forgone fees at the prices when they accrued, but plain Orca's "
          "fees are kept in kind and the base-token part was worth more at the window-end price; **other** = "
          "neither alone explains it. Accrual-time guarantee violations (fully funded borrow whose premium is "
          "below its forgone fees at accrual prices) are counted separately and must be 0.", "",
          "| fee model | budget | cases | B < A | shortfall | in-kind | other | accrual-time violations | "
          "worst bps | worst USD | worst case |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for mode in FEE_MODES:
        for b in BUDGETS:
            fs = [f for f in fails.values() if f["fee_mode"] == mode and f["budget"] == b]
            cases = len(CONFIGS[1:]) // len(BUDGETS) * meta["n_windows"]
            if not fs:
                L.append(f"| {mode} | {b} | {cases} | 0 | 0 | 0 | 0 | 0 | | | |")
                continue
            w = min(fs, key=lambda f: f["worst_extra_bps"])
            L.append(f"| {mode} | {b} | {cases} | {sum(f['B_lt_A'] for f in fs)} | "
                     f"{sum(f['explained_by_premium_shortfall'] for f in fs)} | "
                     f"{sum(f['explained_by_in_kind_revaluation'] for f in fs)} | "
                     f"{sum(f['other_cause'] for f in fs)} | "
                     f"{sum(f['accrual_time_guarantee_violations'] for f in fs)} | {_f(w['worst_extra_bps'], 1)} | "
                     f"{_f(w['worst_extra_usd'], 2)} | {w['demand']} {w['worst_window']} |")
    L += ["", f"Restoration refusals (swap cost above the 0.5% slippage cap; retried after 1 h): "
          f"{meta['refusals']} over all runs. They delay restoration; they never reduce the LP's liquidity.", "",
          "Every number (all regimes x fee models x demand x budgets, per-config failure lists, per-window values "
          "for realistic budgets) is in lp_profitability.json.", "",
          "Deviations from forge_math.lpsim (this benchmark follows the program):", ""]
    L += [f"- {x}" for x in LPSIM_DEVIATIONS]
    text = "\n".join(L) + "\n"
    path.write_text(text)
    return text


# ---------------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="few windows, for CI")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--market", default=markets.DEFAULT, choices=sorted(markets.MARKETS))
    ap.add_argument("--stride-days", type=int, default=None, help="rolling window stride (default 1, quick 30)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args(argv)
    mk = markets.get(args.market)
    if not mk.history_path().exists():
        print(f"missing price data: run benchmarks/fetch_history.py --symbol {mk.symbol} first", file=sys.stderr)
        return 1
    stride = args.stride_days or (30 if args.quick else 1)
    p = SimParams(fee_rate=mk.fee_rate, bucket_width_ticks=mk.bucket_ticks)
    prog = program_params(p)
    t0 = time.time()
    check = self_check(mk, p)
    spot, _ = markets.spot(mk)
    gbm_start = mk.gbm_start if mk.gbm_start is not None else spot
    ht, hw = historical_tasks(mk, p, args.quick, stride)
    gt, gw = gbm_tasks(gbm_start, p, args.quick)
    tasks, windows = ht + gt, hw + gw
    for i, t in enumerate(tasks):
        t.update(params=p, seed=SEED + 7 * i)
    print(f"{mk.name}: {len(tasks)} windows x {len(FEE_MODES)} fee models x {len(CONFIGS)} configs, "
          f"{args.workers} workers", flush=True)
    res = np.zeros((len(tasks), len(FEE_MODES), len(CONFIGS), len(METRICS)))
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for i, r in enumerate(ex.map(run_path, tasks, chunksize=4)):
            res[i] = r
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(tasks)} windows, {time.time() - t0:.0f}s", flush=True)
    rows = summaries(res, windows)
    fails = failure_modes(res, windows)
    d = np.load(mk.history_path())
    span = (f"{datetime.fromtimestamp(int(d['open_ms'][0]) / 1000, UTC):%Y-%m-%d} to "
            f"{datetime.fromtimestamp(int(d['open_ms'][-1]) / 1000, UTC):%Y-%m-%d}")
    regime_ret = {}
    for tag in {t for w in windows for t in w["tags"]} | {"hist-all"}:
        rs = [w["return"] for w in windows if tag in w["tags"] or (tag == "hist-all" and w["source"] == "hist")]
        regime_ret[tag] = float(np.median(rs))
    seconds = round(time.time() - t0, 1)
    meta = {"history_span": span, "stride_days": stride, "n_windows": len(windows), "seconds": seconds,
            "refusals": int(res[..., METRICS.index("refusals")].sum()),
            "self_check_max_rel_error": max(v["max_rel_error"] for v in check.values()),
            "regime_median_return": regime_ret}
    # compact per-window rows for the headline configs (realistic budgets, every demand, every fee model)
    headline = [ci for ci, c in enumerate(CONFIGS) if c[3] in ("-", "realistic")]
    dv = derived(res)
    per_window = []
    for i, w in enumerate(windows):
        row = {**w, "A_usd": {}, "B_usd": {}, "HODL_usd": round(float(dv["HODL"][i, 0, 0]), 2)}
        for fi, mode in enumerate(FEE_MODES):
            row["A_usd"][mode] = round(float(dv["A"][i, fi, 0]), 2)
            row["B_usd"][mode] = {CONFIGS[ci][0]: round(float(dv["B"][i, fi, ci]), 2) for ci in headline[1:]}
        per_window.append(row)
    out_dir = args.out or HERE / "results" / markets.results_name(run_id(), mk)
    out_dir.mkdir(parents=True, exist_ok=True)
    params_dict = asdict(p)
    params_dict["curve"] = asdict(p.curve)
    (out_dir / "lp_profitability.json").write_text(json.dumps({
        "benchmark": "lp_profitability", "market": mk.to_dict(),
        "history": {"path": str(mk.history_path().relative_to(HERE)), "span": span,
                    "label": f"Binance {mk.symbol} 1m bars"},
        "claims": {
            "incremental": "FORGE LP value (liquidity + idle fees + premium paid) >= plain Orca LP value "
                           "(liquidity + fees) for the same capital, ladder and price path; extra = B - A.",
            "absolute": "LP value vs holding the starting tokens (HODL) and vs plain Orca LP, at the window end."},
        "not_a_replay": "Binance bars drive a simulated pool (arbitrage to each price, optional noise volume); "
                        "not a replay of Orca swaps. Borrow demand and budgets are assumptions swept below.",
        "seed": SEED, "seconds": seconds, "capital_usd": CAPITAL_USD, "params": params_dict,
        "program_params": prog, "lpsim_deviations": LPSIM_DEVIATIONS, "self_check": check,
        "design": {"horizons_days": HORIZONS, "stride_days": stride, "fee_modes": FEE_MODES,
                   "noise_per_day_x_lp_notional": NOISE_PER_DAY, "utils": UTILS, "holds_s": HOLDS_S,
                   "open_wait_s": OPEN_WAIT_S, "budgets": BUDGET_TEXT, "keeper_delay_s": KEEPER_DELAY_S,
                   "restore_retry_s": RESTORE_RETRY_S, "min_budget_usd": MIN_BUDGET_USD,
                   "configs": [{"demand": c[0], "util": c[1], "hold": c[2], "budget": c[3]} for c in CONFIGS]},
        "meta": meta, "summary": rows, "failure_modes": fails, "windows": per_window,
    }, indent=1, default=float) + "\n")
    text = write_md(out_dir / "lp_profitability.md", mk, meta, rows, fails)
    print(text)
    print(f"wrote {out_dir} in {seconds}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
