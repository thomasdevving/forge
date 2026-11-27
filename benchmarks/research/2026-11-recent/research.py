# ruff: noqa: E501  (wide result tables and formulas read better unwrapped)
"""Recent-regime study (2026-11): FORGE against the last 8 weeks of real prices.

Questions: what was the regime; did FORGE LPs beat plain Orca LPs and holding; was a FORGE hedge a good
deal against a fair-value reference; what could the protocol earn; and which pricing parameters satisfy
LPs, borrowers and the protocol at once.

Data (real only, fetched by fetch_recent.py): Binance 1-minute spot bars for SOLUSDC, JUPUSDC, BONKUSDC,
KMNOUSDC from 2026-09-01 to the latest published day; Deribit SOL_USDC option trades (with implied vol)
and today's SOL_USDC option book. JLP is not on Binance and is not covered.

Simulation (forge_math.lpsim, imported read-only): the same event engine and pool model as Benchmark 4
(benchmarks/lp_profitability.py). 1-minute bars are expanded to 15-second o->h->l->c and o->l->h->c paths
(both orderings are run); the pool follows the no-arbitrage band of the 0.30% fee tier ("arb-band": fees
from arbitrage only) and, separately, arb-band plus round-trip noise volume of 1x the LP ladder per day
("band+noise", an assumption). It is not a replay of Orca swaps. BONK and KMNO use the same fee tier and
bucket width as SOL/JUP (assumed; no market entry exists for them in benchmarks/markets.py).

Usage: uv run --project compiler python benchmarks/research/2026-11-recent/research.py [--workers N] [--quick]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, replace
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from forge_math.lpsim import (
    SimParams,
    band_path,
    fee_growth,
    gbm_path,
    ladder_amounts,
    ohlc_path,
    program_parity,
    simulate_demand,
    world_a_fees,
)
from forge_math.premium import UtilizationCurve

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
REPO_DATA = HERE.parents[1] / "data"   # benchmarks/data (read-only: 10-month context for SOL and JUP)
SEED = 20261127
YEAR_S = 365 * 86_400
TOKENS = {"SOL": "SOLUSDC", "JUP": "JUPUSDC", "BONK": "BONKUSDC", "KMNO": "KMNOUSDC"}
FEE_RATE = 0.003            # Orca 0.30% tier (SOL/JUP from benchmarks/markets.py; BONK/KMNO assumed)
BUCKET_TICKS = 256          # 4 x tick spacing 64
WINDOW_DAYS = 56            # the recent window: 8 weeks ending at the last published bar
TRAIL_DAYS = 30             # trailing realized-vol lookback for fair value
CAPITAL_USD = 10_000.0
HEDGE_USD = 10_000.0        # notional protected per hedge (units x spot at open)
BAR_STEPS, STEP_S = 4, 15.0
NOISE_PER_DAY = 1.0
OPEN_WAIT_S = 3_600.0
HOLDS_S = {"short": 8 * 3_600.0, "long": 7 * 86_400.0}
UTILS = (0.2, 0.5, 0.8)
FEE_MODES = ("arb-band", "band+noise")
FLOORS = (0.02, 0.05, 0.10, 0.20, 0.40, 0.80)
# Curves are pinned explicitly: the program's default changed after this study (to "hybrid"), so
# "default" below is the curve the study evaluated as the default at the time (1 + u, kink 0.6).
_OLD = {"base_ppm": 1_000_000, "slope1_ppm": 1_000_000, "kink_ppm": 600_000, "slope2_ppm": 6_000_000, "cap_ppm": 800_000}
CURVES = {
    "flat m=1": UtilizationCurve(**{**_OLD, "base_ppm": 1_000_000, "slope1_ppm": 0, "slope2_ppm": 0}),
    "flat m=1.1": UtilizationCurve(**{**_OLD, "base_ppm": 1_100_000, "slope1_ppm": 0, "slope2_ppm": 0}),
    "flat m=1.2": UtilizationCurve(**{**_OLD, "base_ppm": 1_200_000, "slope1_ppm": 0, "slope2_ppm": 0}),
    "1+0.25u": UtilizationCurve(**{**_OLD, "slope1_ppm": 250_000, "slope2_ppm": 250_000}),
    "default": UtilizationCurve(**_OLD),
    "2x slope": UtilizationCurve(**{**_OLD, "slope1_ppm": 2_000_000, "slope2_ppm": 12_000_000}),
    "base 1.5": UtilizationCurve(**{**_OLD, "base_ppm": 1_500_000}),
    # the recommendation as implemented: flat 1.1 up to 60% utilization, then +6x per unit
    "hybrid": UtilizationCurve(**{**_OLD, "base_ppm": 1_100_000, "slope1_ppm": 0}),
}
TAKES = (0.0, 0.05, 0.10, 0.20, 0.30, 0.50)
HEDGE_TENORS = {"7d": 7, "30d": 30}
PUT_MONEYNESS = 0.90
CALL_MONEYNESS = 1.12
FAIR_MONEYNESS = (0.75, 0.80, 0.85, 0.90, 0.95)


def ts(ms: float) -> str:
    return f"{datetime.fromtimestamp(int(ms) / 1000, UTC):%Y-%m-%d %H:%M}"


def day(ms: float) -> str:
    return f"{datetime.fromtimestamp(int(ms) / 1000, UTC):%Y-%m-%d}"


def load(sym: str) -> dict:
    d = np.load(DATA / f"{sym}-1m.npz")
    return {k: d[k] for k in d.files}


def window_index(d: dict) -> tuple[int, int]:
    """[i0, i1) bar indices of the last WINDOW_DAYS full days."""
    end_ms = int(d["open_ms"][-1]) + 60_000
    start_ms = end_ms - WINDOW_DAYS * 86_400_000
    i0 = int(np.searchsorted(d["open_ms"], start_ms))
    return i0, len(d["open_ms"])


# ---------------------------------------------------------------------------------------------
# 1. Regime
# ---------------------------------------------------------------------------------------------


def daily_closes(d: dict, i0: int, i1: int) -> tuple[list[str], np.ndarray]:
    t, c = d["open_ms"][i0:i1], d["close"][i0:i1]
    days = (t // 86_400_000).astype(np.int64)
    last = np.r_[np.where(np.diff(days) != 0)[0], len(days) - 1]
    return [day(x) for x in t[last]], c[last]


def vol_stats(d: dict, i0: int, i1: int) -> dict:
    c = d["close"][i0:i1]
    o0 = float(d["open"][i0])
    r1 = np.diff(np.log(np.r_[o0, c]))
    hourly = np.log(np.r_[o0, c[59::60]])
    _, dc = daily_closes(d, i0, i1)
    dr = np.diff(np.log(np.r_[o0, dc]))
    return {"vol_1m": float(np.std(r1) * math.sqrt(525_600)), "vol_1h": float(np.std(np.diff(hourly)) * math.sqrt(8760)),
            "vol_1d": float(np.std(dr) * math.sqrt(365))}


def regime(name: str, d: dict) -> dict:
    i0, i1 = window_index(d)
    t, c, lo = d["open_ms"], d["close"], d["low"]
    o0, cT = float(d["open"][i0]), float(c[i1 - 1])
    dates, dc = daily_closes(d, i0, i1)
    dr = np.diff(np.log(np.r_[o0, dc]))
    simple = np.exp(dr) - 1
    top = np.argsort(-np.abs(simple))[:5]
    # max drawdown on 1m lows against the running peak of 1m closes
    peak = np.maximum.accumulate(np.r_[o0, c[i0:i1]])[:-1]
    dd = lo[i0:i1] / peak - 1
    j = int(np.argmin(dd))
    pk = int(np.argmax(np.r_[o0, c[i0:i0 + j + 1]][:j + 1])) if j > 0 else 0
    weeks = []
    for w in range(WINDOW_DAYS // 7):
        a, b = i0 + w * 7 * 1440, min(i0 + (w + 1) * 7 * 1440, i1)
        weeks.append({"start": day(t[a]), "return": float(c[b - 1] / d["open"][a] - 1)})
    tr0 = max(0, i0 - TRAIL_DAYS * 1440)
    out = {"token": name, "start": ts(t[i0]), "end": ts(t[i1 - 1] + 60_000), "open": o0, "close": cT,
           "low": float(lo[i0:i1].min()), "high": float(d["high"][i0:i1].max()), "return": cT / o0 - 1,
           **vol_stats(d, i0, i1), "max_drawdown": float(dd[j]), "drawdown_trough": ts(t[i0 + j]),
           "drawdown_peak": ts(t[i0 + pk - 1]) if pk > 0 else ts(t[i0]),
           "biggest_daily_moves": [{"date": dates[k], "return": float(simple[k])} for k in top],
           "days_abs_move_gt_5pct": int(np.sum(np.abs(simple) > 0.05)), "weekly_returns": weeks,
           "prior_30d": {"start": ts(t[tr0]), **vol_stats(d, tr0, i0), "return": float(c[i0 - 1] / d["open"][tr0] - 1)}}
    ctx = REPO_DATA / f"{TOKENS[name]}-1m.npz"
    if ctx.exists():   # 10-month context from the repo's Benchmark 3/4 history (read-only)
        h = np.load(ctx)
        hd = {k: h[k] for k in h.files}
        out["context_jan_oct"] = {"span": f"{day(hd['open_ms'][0])} to {day(hd['open_ms'][-1])}",
                                  **vol_stats(hd, 0, len(hd["close"]))}
        # 7-day returns over the 10 months: where does the recent worst week sit?
        cc = hd["close"][1439::1440]
        r7 = cc[7:] / cc[:-7] - 1
        out["context_jan_oct"]["r7_p5"] = float(np.quantile(r7, 0.05))
        out["context_jan_oct"]["r7_p95"] = float(np.quantile(r7, 0.95))
    return out


# ---------------------------------------------------------------------------------------------
# 2. LPs: Benchmark 4 engine on the recent windows, plus a pricing sweep
# ---------------------------------------------------------------------------------------------


def lp_configs() -> list[tuple]:
    """(floor, curve name, util, hold, budget mode, keeper)."""
    out = []
    for f in FLOORS:
        for cname in CURVES:
            for u in UTILS:
                for h in HOLDS_S:
                    out.append((f, cname, u, h, "realistic", True))
                    if f == 0.05 and cname == "default":
                        out.append((f, cname, u, h, "realistic", False))
    return out


LP_CONFIGS = lp_configs()
LP_METRICS = ("v0", "hodl", "pos", "fees_a", "fees_b", "paid", "premium", "short", "forgone", "lost_v", "borrows",
              "keeper_closes", "util", "floor_bound", "days")


def run_lp_window(task: dict) -> np.ndarray:
    base: SimParams = task["params"]
    out = np.zeros((len(FEE_MODES), len(LP_CONFIGS) + 1, len(LP_METRICS)))
    noise_step = NOISE_PER_DAY * STEP_S / 86_400
    fg = fee_growth(task["band"], STEP_S, base, noise_step)
    x0, y0 = ladder_amounts(fg.sqrt_lo, fg.sqrt_hi, fg.s[0])
    v0 = x0 * fg.prices[0] + y0
    pT = float(fg.prices[-1])
    hodl = x0 * pT + y0
    xT, yT = ladder_amounts(fg.sqrt_lo, fg.sqrt_hi, fg.s[-1])
    pos = xT * pT + yT
    usd = CAPITAL_USD / v0
    days = fg.T * STEP_S / 86_400
    for fi, mode in enumerate(FEE_MODES):
        nzf = 1.0 if mode == "band+noise" else 0.0
        a_b, a_q, _ = world_a_fees(fg, base, nzf)
        fees_a = a_b * pT + a_q
        row0 = {"v0": v0, "hodl": hodl, "pos": pos, "fees_a": fees_a, "fees_b": fees_a, "days": days}
        out[fi, 0] = [row0.get(m, 0.0) * (usd if m not in ("borrows", "keeper_closes", "util", "floor_bound", "days")
                                         else 1.0) for m in LP_METRICS]
        for ci, (f, cname, u, h, bmode, keeper) in enumerate(LP_CONFIGS, start=1):
            p = replace(base, floor_rate=f, curve=CURVES[cname])
            r = simulate_demand(fg, p, u, HOLDS_S[h], bmode, keeper, task["seed"] + 1_000 * (UTILS.index(u) * 2 +
                                list(HOLDS_S).index(h)), min_budget=1e-6 / usd, open_wait_s=OPEN_WAIT_S, nzf=nzf)
            fees_b = (a_b - r["lost_b"]) * pT + (a_q - r["lost_q"]) + r["paid"]
            row = {**row0, "fees_b": fees_b, **r}
            out[fi, ci] = [row[m] * (usd if m not in ("borrows", "keeper_closes", "util", "floor_bound", "days")
                                     else 1.0) for m in LP_METRICS]
    return out


def lp_tasks(name: str, d: dict, p: SimParams, quick: bool) -> tuple[list, list]:
    i0, i1 = window_index(d)
    o, h, lo, c = d["open"], d["high"], d["low"], d["close"]
    tasks, windows = [], []
    for hf in (True, False):
        ex = ohlc_path(o, h, lo, c, hf)
        bd = band_path(ex, p.fee_rate)   # band over the whole fetched history, as Benchmark 4
        specs = [("7d", 7, 2 if quick else 1), ("30d", 30, 13 if quick else 2), ("56d", 56, 1)]
        for hz, nd, stride in specs:
            nb = nd * 1440
            for s in range(i0, i1 - nb + 1, stride * 1440):
                windows.append({"token": name, "horizon": hz, "start": day(d["open_ms"][s]),
                                "ordering": "HL" if hf else "LH", "return": float(c[s + nb - 1] / o[s] - 1)})
                tasks.append({"band": bd[s * BAR_STEPS:(s + nb) * BAR_STEPS + 1], "params": p})
    return tasks, windows


def lp_derived(res: np.ndarray) -> dict:
    g = {m: res[..., i] for i, m in enumerate(LP_METRICS)}
    a = g["pos"] + g["fees_a"]
    b = g["pos"] + g["fees_b"]
    yr = 365.0 / g["days"]
    v0 = g["v0"]
    return {"extra_bps": (b - a) / v0 * 1e4, "paid_bps": g["paid"] / v0 * 1e4, "b_hodl_bps": (b - g["hodl"]) / v0 * 1e4,
            "a_hodl_bps": (a - g["hodl"]) / v0 * 1e4, "apr_a": g["fees_a"] / v0 * yr, "apr_b": g["fees_b"] / v0 * yr,
            "premium_apr": g["paid"] / v0 * yr, "util": g["util"], "short_bps": g["short"] / v0 * 1e4,
            "floor_bound_share": np.where(g["borrows"] > 0, g["floor_bound"] / np.maximum(g["borrows"], 1), np.nan),
            "il_bps": (g["pos"] - g["hodl"]) / v0 * 1e4, "forgone_bps": g["forgone"] / v0 * 1e4,
            "lost_bps": g["lost_v"] / v0 * 1e4}


def q(a, x):
    a = np.asarray(a, float)
    a = a[~np.isnan(a)]
    return float(np.quantile(a, x)) if len(a) else float("nan")


def lp_summaries(res: np.ndarray, windows: list[dict]) -> list[dict]:
    dv = lp_derived(res)
    rows = []
    for name in TOKENS:
        for hz in ("7d", "30d", "56d"):
            idx = [i for i, w in enumerate(windows) if w["token"] == name and w["horizon"] == hz]
            if not idx:
                continue
            for fi, mode in enumerate(FEE_MODES):
                for ci, cfg in enumerate([None] + LP_CONFIGS):
                    e = dv["extra_bps"][idx, fi, ci]
                    paid = dv["paid_bps"][idx, fi, ci]
                    row = {"token": name, "horizon": hz, "fee_mode": mode, "n": len(idx)}
                    if cfg is None:
                        row.update(config="none")
                    else:
                        f, cname, u, h, bmode, keeper = cfg
                        row.update(config=f"u{round(u * 100)}-{h}", floor=f, curve=cname, util_target=u, hold=h,
                                   budget=bmode + ("+keeper" if keeper else ""))
                    row.update({
                        "extra_bps_median": q(e, 0.5), "extra_bps_mean": float(np.mean(e)), "extra_bps_p5": q(e, 0.05),
                        "extra_bps_min": float(np.min(e)), "share_B_ge_A": float(np.mean(e >= -1e-6)),
                        "a_hodl_bps_median": q(dv["a_hodl_bps"][idx, fi, ci], 0.5),
                        "b_hodl_bps_median": q(dv["b_hodl_bps"][idx, fi, ci], 0.5),
                        "share_A_gt_HODL": float(np.mean(dv["a_hodl_bps"][idx, fi, ci] > 0)),
                        "share_B_gt_HODL": float(np.mean(dv["b_hodl_bps"][idx, fi, ci] > 0)),
                        "il_bps_median": q(dv["il_bps"][idx, fi, ci], 0.5),
                        "apr_a_median": q(dv["apr_a"][idx, fi, ci], 0.5), "apr_b_median": q(dv["apr_b"][idx, fi, ci], 0.5),
                        "premium_apr_median": q(dv["premium_apr"][idx, fi, ci], 0.5),
                        "util_mean": float(np.mean(dv["util"][idx, fi, ci])),
                        "floor_bound_share_median": q(dv["floor_bound_share"][idx, fi, ci], 0.5),
                        "shortfall_bps_mean": float(np.mean(dv["short_bps"][idx, fi, ci])),
                        "lost_bps_median": q(dv["lost_bps"][idx, fi, ci], 0.5),
                        "paid_bps_median": q(paid, 0.5),
                        "takes_on_excess": {f"{t:.2f}": {
                            "share_B_ge_A": float(np.mean(e - t * np.maximum(paid - dv["forgone_bps"][idx, fi, ci], 0)
                                                          >= -1e-6)),
                            "extra_bps_median": q(e - t * np.maximum(paid - dv["forgone_bps"][idx, fi, ci], 0), 0.5),
                            "revenue_bps_median": q(t * np.maximum(paid - dv["forgone_bps"][idx, fi, ci], 0), 0.5)}
                            for t in TAKES},
                        "takes": {f"{t:.2f}": {"share_B_ge_A": float(np.mean(e - t * paid >= -1e-6)),
                                               "extra_bps_median": q(e - t * paid, 0.5),
                                               "extra_bps_p5": q(e - t * paid, 0.05)} for t in TAKES},
                    })
                    rows.append(row)
    return rows


# ---------------------------------------------------------------------------------------------
# 3. Borrowers: what FORGE charged for a 90% floor / 90-112 collar vs Black-Scholes fair value
# ---------------------------------------------------------------------------------------------

_Z = np.linspace(-9, 9, 6001)
_W = np.exp(-_Z**2 / 2)
_W /= _W.sum()


def range_value(P: np.ndarray, L: float, sa: float, sb: float) -> np.ndarray:
    s = np.clip(np.sqrt(P), sa, sb)
    return L * (1 / s - 1 / sb) * P + L * (s - sa)


def put_payoff(P, L, sa, sb):
    """Borrowed range below spot: escrow (all quote) minus restoration cost."""
    return L * (sb - sa) - range_value(P, L, sa, sb)


def call_giveaway(P, L, sa, sb):
    """Provided range above spot vs holding its base: the upside given away (>= 0)."""
    return L * (1 / sa - 1 / sb) * P - range_value(P, L, sa, sb)


def bs_value(fn, S0: float, sigma: float, T: float) -> float:
    PT = S0 * np.exp(-0.5 * sigma**2 * T + sigma * math.sqrt(T) * _Z)
    return float(np.sum(_W * fn(PT)))


def implied_vol(fn, S0: float, T: float, target: float) -> float:
    lo, hi = 0.01, 6.0
    if target <= bs_value(fn, S0, lo, T):
        return lo
    if target >= bs_value(fn, S0, hi, T):
        return hi
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if bs_value(fn, S0, mid, T) < target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def grid_bucket(price: float, target: float) -> tuple[float, float]:
    """sqrt edges of the bucket on the absolute 256-tick grid whose geometric mid is closest to target."""
    t = math.log(target) / math.log(1.0001)
    lower = round((t - BUCKET_TICKS / 2) / BUCKET_TICKS) * BUCKET_TICKS
    return 1.0001 ** (lower / 2), 1.0001 ** ((lower + BUCKET_TICKS) / 2)


def bucket_fees(fg, sa: float, sb: float, u: float, p: SimParams) -> dict:
    """Per-unit-L fee value (quote at accrual) for the ladder bucket with these edges: arb-band and noise parts."""
    k = int(np.argmin(np.abs(fg.sqrt_lo - sa)))
    if abs(fg.sqrt_lo[k] - sa) > 1e-9 * sa:
        raise RuntimeError("bucket not on the simulated ladder")
    Lbg = p.background_ratio * p.lp_liquidity
    return {"arb": float(fg.arb_v[-1, k]), "noise_borrowed": float(fg.nz_v[-1, k] / (p.lp_liquidity * (1 - u) + Lbg)),
            "noise_provided": float(fg.nz_v[-1, k] / (p.lp_liquidity + Lbg))}


def run_hedge(task: dict) -> dict:
    p: SimParams = task["params"]
    S0, ST, T = task["S0"], task["ST"], task["days"] / 365
    N = HEDGE_USD / S0
    pa, pb = grid_bucket(S0, PUT_MONEYNESS * S0)
    ca, cb = grid_bucket(S0, CALL_MONEYNESS * S0)
    Lp = N / (1 / pa - 1 / pb)
    Lc = N / (1 / ca - 1 / cb)
    put = lambda P: put_payoff(P, Lp, pa, pb)          # noqa: E731
    call = lambda P: call_giveaway(P, Lc, ca, cb)      # noqa: E731
    notional = Lp * (pb - pa)                          # escrowed quote = floor notional
    noise_step = NOISE_PER_DAY * STEP_S / 86_400
    fees = {}
    for hf, band in task["bands"].items():
        pp = replace(p, n_buckets=14)
        fg = fee_growth(band, STEP_S, pp, noise_step)
        fees[hf] = {"put": {u: bucket_fees(fg, pa, pb, u, pp) for u in UTILS},
                    "call": bucket_fees(fg, ca, cb, 0.0, pp)}
    # forgone fees for the borrowed put range and fees earned by the provided call range (USD), mean of orderings
    forgone = {mode: {u: Lp * float(np.mean([f["put"][u]["arb"] + (f["put"][u]["noise_borrowed"] if mode == "band+noise"
                                                                      else 0.0) for f in fees.values()]))
                      for u in UTILS} for mode in FEE_MODES}
    call_fees = {mode: Lc * float(np.mean([f["call"]["arb"] + (f["call"]["noise_provided"] if mode == "band+noise"
                                                                 else 0.0) for f in fees.values()]))
                 for mode in FEE_MODES}
    sig = {"rv_trailing30": task["rv30"], "rv_trailing7": task["rv7"], "rv_expost": task["rv_fwd"]}
    if task.get("iv") is not None:
        sig["deribit_iv"] = task["iv"]
    fair = {k: {"put": bs_value(put, S0, v, T), "call_giveaway": bs_value(call, S0, v, T)} for k, v in sig.items()}
    fair_rate = {}
    for k, v in sig.items():
        fr = {}
        for mny in FAIR_MONEYNESS:
            a, b = grid_bucket(S0, mny * S0)
            L = N / (1 / a - 1 / b)
            fr[f"{mny:.2f}"] = bs_value(lambda P, L=L, a=a, b=b: put_payoff(P, L, a, b), S0, v, T) / (L * (b - a) * T)
        fair_rate[k] = fr
    return {"token": task["token"], "tenor": task["tenor"], "start": task["start"], "S0": S0, "ST": ST,
            "path_min": task["path_min"], "strike_put": pa * pb, "put_range": [Lp, pa, pb], "call_range": [Lc, ca, cb], "strike_call": ca * cb, "notional": notional,
            "units": N, "sigma": sig, "iv_info": task.get("iv_info"), "fair": fair, "fair_floor_rate": fair_rate,
            "forgone_usd": forgone, "call_fees_usd": call_fees,
            "floor_usd_per_rate": notional * T,      # floor premium = rate x this
            "payoff_put_at_expiry": float(put(np.array([ST]))[0]),
            "payoff_put_at_path_min": float(put(np.array([task["path_min"]]))[0]),
            "giveaway_call_at_expiry": float(call(np.array([ST]))[0]),
            "unhedged_pnl": N * (ST - S0)}


def deribit_iv_series() -> tuple[dict, list]:
    """SOL implied vol from Deribit trades: per UTC day, median IV of SOL_USDC options by tenor bucket and
    moneyness band (strike / index at trade)."""
    path = DATA / "deribit_sol_trades.json"
    if not path.exists():
        return {}, []
    tr = json.loads(path.read_text())["sol_trades"]
    mon = {m: i for i, m in enumerate(("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV",
                                       "DEC"), start=1)}
    rows = []
    for x in tr:
        if not x.get("iv") or not x.get("index_price"):
            continue
        _, exp, strike, kind = x["instrument_name"].split("-")
        dd, mm, yy = int(exp[:-5]), mon[exp[-5:-2]], 2000 + int(exp[-2:])
        exp_ms = datetime(yy, mm, dd, 8, tzinfo=UTC).timestamp() * 1000
        tenor = (exp_ms - x["timestamp"]) / 86_400_000
        rows.append((x["timestamp"], tenor, float(strike.replace("d", ".")) / x["index_price"], x["iv"] / 100, kind))
    return {"n_trades": len(rows)}, rows


def iv_for(rows: list, start_ms: int, tenor_days: int) -> tuple[float | None, dict]:
    """Deribit SOL IV known at start_ms: trades in the prior 24 h (widened to 72 h if sparse), tenor near the
    hedge's, moneyness 0.80-0.97 (OTM puts); falls back to 0.80-1.05."""
    tlo, thi = (2, 14) if tenor_days <= 10 else (14, 60)
    for look_h, (mlo, mhi) in ((24, (0.80, 0.97)), (72, (0.80, 0.97)), (72, (0.80, 1.05))):
        sel = [r[3] for r in rows if start_ms - look_h * 3_600_000 <= r[0] < start_ms and tlo <= r[1] <= thi
               and mlo <= r[2] <= mhi]
        if len(sel) >= 3:
            return float(np.median(sel)), {"n": len(sel), "lookback_h": look_h, "moneyness": [mlo, mhi],
                                           "tenor_days": [tlo, thi]}
    return None, {"n": 0}


def hedge_tasks(name: str, d: dict, p: SimParams, iv_rows: list) -> list[dict]:
    i0, i1 = window_index(d)
    o, h, lo, c, t = d["open"], d["high"], d["low"], d["close"], d["open_ms"]
    bands = {hf: band_path(ohlc_path(o, h, lo, c, hf), p.fee_rate) for hf in (True, False)}
    hourly = np.log(c[59::60])
    tasks = []
    for tenor, nd in HEDGE_TENORS.items():
        nb = nd * 1440
        for s in range(i0, i1 - nb + 1, 1440):
            hi_ = s // 60   # hourly closes strictly before the start
            rv = lambda n, h=hi_: float(np.std(np.diff(hourly[max(0, h - n * 24):h])) * math.sqrt(8760))  # noqa: E731
            iv, info = iv_for(iv_rows, int(t[s]), nd) if name == "SOL" and iv_rows else (None, None)
            tasks.append({"token": name, "tenor": tenor, "days": nd, "start": day(t[s]), "S0": float(o[s]),
                          "ST": float(c[s + nb - 1]), "path_min": float(lo[s:s + nb].min()), "rv30": rv(30),
                          "rv7": rv(7), "iv": iv, "iv_info": info, "params": p,
                          "rv_fwd": float(np.std(np.diff(hourly[hi_:hi_ + nd * 24 + 1])) * math.sqrt(8760)),
                          "bands": {("HL" if hf else "LH"): b[s * BAR_STEPS:(s + nb) * BAR_STEPS + 1]
                                    for hf, b in bands.items()}})
    return tasks


def mult(curve: UtilizationCurve, u: float) -> float:
    return curve.multiplier_ppm(math.ceil(u * 1e6)) / 1e6


def hedge_premium(h: dict, floor: float, curve: UtilizationCurve, u: float, mode: str) -> float:
    return max(floor * h["floor_usd_per_rate"], mult(curve, u) * h["forgone_usd"][mode][u])


def hedge_summaries(hedges: list[dict]) -> dict:
    out = {}
    for name in TOKENS:
        for tenor in HEDGE_TENORS:
            hs = [h for h in hedges if h["token"] == name and h["tenor"] == tenor]
            if not hs:
                continue
            S = {"n_starts": len(hs), "first_start": hs[0]["start"], "last_start": hs[-1]["start"]}
            refs = [k for k in hs[0]["fair"]]
            if name == "SOL":
                refs = sorted({k for h in hs for k in h["fair"]})
            for mode in FEE_MODES:
                for u in UTILS:
                    prem = np.array([hedge_premium(h, 0.05, CURVES["default"], u, mode) for h in hs])
                    floor_only = np.array([0.05 * h["floor_usd_per_rate"] for h in hs])
                    fee_part = np.array([mult(CURVES["default"], u) * h["forgone_usd"][mode][u] for h in hs])
                    key = f"default/{mode}/u{round(u * 100)}"
                    S[key] = {"premium_usd_median": q(prem, 0.5), "premium_usd_mean": float(prem.mean()),
                              "premium_usd_max": float(prem.max()), "floor_usd": q(floor_only, 0.5),
                              "fee_part_usd_median": q(fee_part, 0.5), "fee_part_usd_max": float(fee_part.max()),
                              "share_fee_part_binds": float(np.mean(fee_part > floor_only)),
                              "premium_pct_notional_median": q(prem / HEDGE_USD, 0.5)}
                    for ref in refs:
                        sel = [i for i, h in enumerate(hs) if ref in h["fair"]]
                        if not sel:
                            continue
                        fair = np.array([hs[i]["fair"][ref]["put"] for i in sel])
                        ivs = np.array([implied_vol(lambda P, h=hs[i]: put_payoff(P, *h["put_range"]), hs[i]["S0"],
                                                    HEDGE_TENORS[tenor] / 365, prem[i])
                                        for i in sel]) if (mode == "arb-band" and u == 0.5) else None
                        S[key][f"vs_{ref}"] = {"n": len(sel), "fair_usd_median": q(fair, 0.5),
                                               "ratio_median": q(prem[sel] / fair, 0.5),
                                               "ratio_p90": q(prem[sel] / fair, 0.9),
                                               "share_premium_le_fair": float(np.mean(prem[sel] <= fair)),
                                               "sigma_median": q([hs[i]["sigma"][ref] for i in sel], 0.5)}
                        if ivs is not None:
                            S[key][f"vs_{ref}"]["forge_implied_vol_median"] = q(ivs, 0.5)
            # realized outcomes at default pricing, arb-band, u=0.5
            prem = np.array([hedge_premium(h, 0.05, CURVES["default"], 0.5, "arb-band") for h in hs])
            pay = np.array([h["payoff_put_at_expiry"] for h in hs])
            unh = np.array([h["unhedged_pnl"] for h in hs])
            S["outcome_default_arbband_u50"] = {
                "share_put_in_the_money_at_expiry": float(np.mean(pay > 0)),
                "share_path_touched_strike": float(np.mean([h["path_min"] <= h["strike_put"] for h in hs])),
                "payoff_usd_mean": float(pay.mean()), "payoff_usd_max": float(pay.max()),
                "premium_usd_mean": float(prem.mean()), "net_usd_mean": float((pay - prem).mean()),
                "share_net_positive": float(np.mean(pay - prem > 0)),
                "unhedged_pnl_usd_mean": float(unh.mean()), "unhedged_pnl_usd_min": float(unh.min()),
                "hedged_pnl_usd_min": float((unh + pay - prem).min()),
                "worst_start": hs[int(np.argmin(unh))]["start"]}
            # collar 90/112 at default pricing, arb-band, u=0.5
            for ref in refs:
                sel = [h for h in hs if ref in h["fair"]]
                if not sel:
                    continue
                forge_cash = np.array([hedge_premium(h, 0.05, CURVES["default"], 0.5, "arb-band")
                                       - h["call_fees_usd"]["arb-band"] for h in sel])
                give = np.array([h["fair"][ref]["call_giveaway"] for h in sel])
                fput = np.array([h["fair"][ref]["put"] for h in sel])
                S[f"collar_vs_{ref}"] = {"forge_net_cash_usd_median": q(forge_cash, 0.5),
                                         "call_fees_usd_median": q([h["call_fees_usd"]["arb-band"] for h in sel], 0.5),
                                         "fair_call_giveaway_usd_median": q(give, 0.5),
                                         "fair_put_usd_median": q(fput, 0.5),
                                         "forge_economic_cost_usd_median": q(forge_cash + give, 0.5),
                                         "fair_collar_net_usd_median": q(fput - give, 0.5)}
            # fair floor rate by moneyness (median over starts)
            S["fair_floor_rate_median"] = {ref: {m: q([h["fair_floor_rate"][ref][m] for h in hs if ref in h["fair"]], 0.5)
                                                 for m in [f"{x:.2f}" for x in FAIR_MONEYNESS]} for ref in refs}
            out[f"{name}/{tenor}"] = S
    return out


def borrower_grid(hedges: list[dict]) -> dict:
    """Median premium / fair over starts for every floor x curve x util (arb-band and band+noise)."""
    out = {}
    for name in TOKENS:
        for tenor in HEDGE_TENORS:
            hs = [h for h in hedges if h["token"] == name and h["tenor"] == tenor]
            if not hs:
                continue
            refs = sorted({k for h in hs for k in h["fair"]})
            for mode in FEE_MODES:
                for f in FLOORS:
                    for cname, cv in CURVES.items():
                        for u in UTILS:
                            prem = np.array([hedge_premium(h, f, cv, u, mode) for h in hs])
                            row = {"premium_usd_median": q(prem, 0.5)}
                            for ref in refs:
                                sel = [i for i, h in enumerate(hs) if ref in h["fair"]]
                                fair = np.array([hs[i]["fair"][ref]["put"] for i in sel])
                                row[f"ratio_{ref}"] = q(prem[sel] / fair, 0.5)
                            out[f"{name}/{tenor}/{mode}/{f}/{cname}/u{round(u * 100)}"] = row
    return out



# ---------------------------------------------------------------------------------------------
# 3b. Ex-ante check: expected FORGE premium on GBM paths at a given vol vs Black-Scholes at that vol
# ---------------------------------------------------------------------------------------------

GBM_PATHS = {"7d": 400, "30d": 160}
GBM_CHUNK = 40


def iv_today(tenor_days: int) -> tuple[float | None, dict]:
    """Deribit SOL mark IV now (book snapshot): instruments with tenor near the hedge's, strike/underlying
    0.85-0.95; median."""
    path = DATA / "deribit_sol_book.json"
    if not path.exists():
        return None, {}
    snap = json.loads(path.read_text())
    now = datetime.fromisoformat(snap["fetched_at_utc"]).timestamp() * 1000
    mon = {m: i for i, m in enumerate(("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV",
                                       "DEC"), start=1)}
    tlo, thi = (4, 12) if tenor_days <= 10 else (20, 45)
    sel = []
    for x in snap["instruments"]:
        if not x.get("mark_iv") or not x.get("underlying_price"):
            continue
        _, exp, strike, _kind = x["instrument_name"].split("-")
        exp_ms = datetime(2000 + int(exp[-2:]), mon[exp[-5:-2]], int(exp[:-5]), 8, tzinfo=UTC).timestamp() * 1000
        tenor = (exp_ms - now) / 86_400_000
        m = float(strike.replace("d", ".")) / x["underlying_price"]
        if tlo <= tenor <= thi and 0.85 <= m <= 0.95:
            sel.append((x["mark_iv"] / 100, x["instrument_name"]))
    if not sel:
        return None, {}
    return float(np.median([v for v, _ in sel])), {"n": len(sel), "fetched_at_utc": snap["fetched_at_utc"],
                                                   "instruments": sorted({n for _, n in sel})}


def run_gbm_hedge(task: dict) -> dict:
    p: SimParams = replace(task["params"], n_buckets=14)
    S0, nd, sigma = task["S0"], task["days"], task["sigma"]
    N = HEDGE_USD / S0
    pa, pb = grid_bucket(S0, PUT_MONEYNESS * S0)
    Lp = N / (1 / pa - 1 / pb)
    noise_step = NOISE_PER_DAY * STEP_S / 86_400
    out = {"arb": [], "noise": {u: [] for u in UTILS}, "payoff": []}
    for i in range(task["n_paths"]):
        path = gbm_path(S0, int(nd * 86_400 / STEP_S), sigma, seed=task["seed"] + i, step_seconds=STEP_S)
        fg = fee_growth(band_path(path, p.fee_rate), STEP_S, p, noise_step)
        bf = {u: bucket_fees(fg, pa, pb, u, p) for u in UTILS}
        out["arb"].append(Lp * bf[0.5]["arb"])
        for u in UTILS:
            out["noise"][u].append(Lp * bf[u]["noise_borrowed"])
        out["payoff"].append(float(put_payoff(np.array([path[-1]]), Lp, pa, pb)[0]))
    T = nd / 365
    return {"token": task["token"], "tenor": task["tenor"], "sigma_label": task["sigma_label"], "sigma": sigma,
            "S0": S0, "n_paths": task["n_paths"], "notional": Lp * (pb - pa), "floor_usd_per_rate": Lp * (pb - pa) * T,
            "fair_put": bs_value(lambda P: put_payoff(P, Lp, pa, pb), S0, sigma, T),
            "payoffs": out["payoff"], "forgone_arb": out["arb"], "forgone_noise": {str(u): v for u, v in out["noise"].items()}}


def gbm_grid(g: dict) -> dict:
    """Expected premium / fair for every floor x curve x util x fee mode on one GBM set."""
    out = {}
    arb = np.array(g["forgone_arb"])
    for mode in FEE_MODES:
        for f in FLOORS:
            for cname, cv in CURVES.items():
                for u in UTILS:
                    fg_ = arb + (np.array(g["forgone_noise"][str(u)]) if mode == "band+noise" else 0.0)
                    prem = np.maximum(f * g["floor_usd_per_rate"], mult(cv, u) * fg_)
                    out[f"{mode}/{f}/{cname}/u{round(u * 100)}"] = {
                        "expected_premium_usd": float(prem.mean()), "ratio_to_fair": float(prem.mean() / g["fair_put"]),
                        "share_fee_part_binds": float(np.mean(mult(cv, u) * fg_ > f * g["floor_usd_per_rate"]))}
    return out


# ---------------------------------------------------------------------------------------------
# 5. The pricing band
# ---------------------------------------------------------------------------------------------


def pricing_band(lp_rows: list[dict], bgrid: dict, gbm: dict, mode: str = "arb-band") -> dict:
    """For each token, floor and curve:
    (a) LPs: the largest protocol take (share of premium) that keeps the FORGE LP >= the plain Orca LP in
        >= 95% of the recent 7-day and 30-day windows at every demand level (realistic budgets + keeper);
    (b) borrowers, ex ante: expected FORGE premium for the 90% put (7d and 30d, u = 0.5) on GBM paths at the
        reference vol <= the Black-Scholes value at that vol (trailing 30-day realized vol at the window end;
        for SOL also today's Deribit IV); the realized (ex post) ratio on the recent path is reported alongside;
    (c) protocol: take > 0."""
    out = {}
    for name in TOKENS:
        for f in FLOORS:
            for cname in CURVES:
                rows = [r for r in lp_rows if r["token"] == name and r["fee_mode"] == mode and r.get("floor") == f
                        and r.get("curve") == cname and r.get("budget") == "realistic+keeper"
                        and r["horizon"] in ("7d", "30d")]
                if not rows:
                    continue
                ok_takes = [t for t in TAKES if all(r["takes"][f"{t:.2f}"]["share_B_ge_A"] >= 0.95 for r in rows)]
                ok_excess = [t for t in TAKES if all(r["takes_on_excess"][f"{t:.2f}"]["share_B_ge_A"] >= 0.95
                                                     for r in rows)]
                lp_extra = {r["horizon"] + "/" + r["config"]: r["extra_bps_median"] for r in rows}
                exante, expost = {}, {}
                for tenor in HEDGE_TENORS:
                    for key, g in gbm.items():
                        tk, tn, lab = key.split("/")
                        if tk == name and tn == tenor:
                            exante[f"{tenor}/{lab}"] = g["grid"][f"{mode}/{f}/{cname}/u50"]["ratio_to_fair"]
                    b = bgrid.get(f"{name}/{tenor}/{mode}/{f}/{cname}/u50")
                    if b:
                        expost[tenor] = {k.removeprefix("ratio_"): v for k, v in b.items() if k.startswith("ratio_")}
                borrower_ok = bool(exante) and all(v <= 1.0 for v in exante.values())
                max_take = max(ok_takes) if ok_takes else None
                out[f"{name}/{f}/{cname}"] = {
                    "token": name, "floor": f, "curve": cname, "lp_max_take_95pct": max_take,
                    "lp_max_take_on_excess_95pct": max(ok_excess) if ok_excess else None,
                    "lp_extra_bps_median_7d_u50_short": lp_extra.get("7d/u50-short"),
                    "lp_extra_bps_median_30d_u50_short": lp_extra.get("30d/u50-short"),
                    "borrower_exante_ratio": exante, "borrower_expost_median_ratio": expost,
                    "borrower_le_fair_exante": borrower_ok,
                    "in_band": bool(max_take is not None and max_take > 0 and borrower_ok)}
    return out


# ---------------------------------------------------------------------------------------------


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)))
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args(argv)
    t0 = time.time()
    # the study's baseline is the pricing at the time (1 + u, no protocol fee); protocol takes are
    # evaluated explicitly over TAKES
    p = SimParams.from_program(fee_rate=FEE_RATE, bucket_width_ticks=BUCKET_TICKS, curve=CURVES["default"], protocol_fee_bps=0)
    # parity is checked on the program's current defaults; the study's baseline deliberately differs
    # (pre-change pricing) and is recorded next to them
    prog = {**program_parity(SimParams.from_program(fee_rate=FEE_RATE, bucket_width_ticks=BUCKET_TICKS)),
            "study_baseline": {"curve": asdict(p.curve), "protocol_fee_bps": p.protocol_fee_bps}}
    data = {name: load(sym) for name, sym in TOKENS.items() if (DATA / f"{sym}-1m.npz").exists()}
    manifest = json.loads((DATA / "manifest.json").read_text()) if (DATA / "manifest.json").exists() else {}

    regimes = {name: regime(name, d) for name, d in data.items()}
    print("regime done", flush=True)

    iv_meta, iv_rows = deribit_iv_series()
    # daily SOL IV (ATM-ish 0.9-1.1, 2-60 days) for the regime description
    iv_daily = {}
    for r in iv_rows:
        if 0.9 <= r[2] <= 1.1 and 2 <= r[1] <= 60:
            iv_daily.setdefault(day(r[0]), []).append(r[3])
    iv_daily = {k: {"median_iv": float(np.median(v)), "n": len(v)} for k, v in sorted(iv_daily.items())}

    # LPs
    tasks, windows = [], []
    for name, d in data.items():
        tk, wn = lp_tasks(name, d, p, args.quick)
        tasks += tk
        windows += wn
    for i, t in enumerate(tasks):
        t["seed"] = SEED + 7 * i
    print(f"LP: {len(tasks)} windows x {len(FEE_MODES)} fee models x {len(LP_CONFIGS) + 1} configs", flush=True)
    res = np.zeros((len(tasks), len(FEE_MODES), len(LP_CONFIGS) + 1, len(LP_METRICS)))
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for i, r in enumerate(ex.map(run_lp_window, tasks, chunksize=2)):
            res[i] = r
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(tasks)} LP windows, {time.time() - t0:.0f}s", flush=True)
    del tasks
    lp_rows = lp_summaries(res, windows)
    print(f"LP done {time.time() - t0:.0f}s", flush=True)

    # Borrowers
    htasks = []
    for name, d in data.items():
        htasks += hedge_tasks(name, d, p, iv_rows)
    hedges = []
    with ProcessPoolExecutor(max_workers=min(args.workers, 6)) as ex:
        for r in ex.map(run_hedge, htasks, chunksize=1):
            hedges.append(r)
    del htasks
    hsum = hedge_summaries(hedges)
    bgrid = borrower_grid(hedges)
    print(f"hedges done {time.time() - t0:.0f}s", flush=True)

    # ex ante: GBM at trailing 30-day realized vol (window end) and, for SOL, today's Deribit IV
    gtasks = []
    for name, d in data.items():
        i0, i1 = window_index(d)
        hourly = np.log(d["close"][59::60])
        rv30 = float(np.std(np.diff(hourly[-TRAIL_DAYS * 24 - 1:])) * math.sqrt(8760))
        S0 = float(d["close"][i1 - 1])
        for tenor, nd in HEDGE_TENORS.items():
            sigmas = {"rv30_end": (rv30, {"window_end": ts(d["open_ms"][i1 - 1] + 60_000)})}
            if name == "SOL":
                iv, info = iv_today(nd)
                if iv is not None:
                    sigmas["deribit_iv_today"] = (iv, info)
            for lab, (sg, info) in sigmas.items():
                gtasks.append({"token": name, "tenor": tenor, "days": nd, "sigma_label": lab, "sigma": sg,
                               "sigma_info": info, "S0": S0, "params": p,
                               "n_paths": max(8, GBM_PATHS[tenor] // (8 if args.quick else 1)),
                               "seed": SEED + 10_000 * len(gtasks)})
    chunks = []
    for t in gtasks:   # split each GBM set into chunks of GBM_CHUNK paths with distinct seeds
        for c0 in range(0, t["n_paths"], GBM_CHUNK):
            chunks.append({**t, "n_paths": min(GBM_CHUNK, t["n_paths"] - c0), "seed": t["seed"] + c0})
    gbm = {}
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for t, r in zip(chunks, ex.map(run_gbm_hedge, chunks, chunksize=1), strict=True):
            key = f"{r['token']}/{r['tenor']}/{r['sigma_label']}"
            if key not in gbm:
                gbm[key] = {**r, "sigma_info": t["sigma_info"], "payoffs": [], "forgone_arb": [],
                            "forgone_noise": {str(u): [] for u in UTILS}, "n_paths": 0}
            g = gbm[key]
            g["n_paths"] += r["n_paths"]
            g["payoffs"] += r["payoffs"]
            g["forgone_arb"] += r["forgone_arb"]
            for u in UTILS:
                g["forgone_noise"][str(u)] += r["forgone_noise"][str(u)]
    for g in gbm.values():
        pay, fa = np.array(g.pop("payoffs")), np.array(g["forgone_arb"])
        fn = np.array(g["forgone_noise"]["0.5"])
        g["mc_payoff_mean"] = float(pay.mean())
        g["mc_payoff_se"] = float(pay.std() / math.sqrt(len(pay)))
        g["forgone_arb_mean"] = float(fa.mean())
        g["forgone_arb_se"] = float(fa.std() / math.sqrt(len(fa)))
        g["forgone_arb_to_fair"] = float(fa.mean() / g["fair_put"])
        g["forgone_noise_u50_to_fair"] = float(fn.mean() / g["fair_put"])
        g["share_paths_touch_bucket"] = float(np.mean(fa > 0))
        g["grid"] = gbm_grid(g)
        g.pop("forgone_arb")
        g.pop("forgone_noise")
    print(f"gbm done {time.time() - t0:.0f}s", flush=True)

    band = {mode: pricing_band(lp_rows, bgrid, gbm, mode) for mode in FEE_MODES}

    # per-window LP rows for the default pricing (compact)
    dv = lp_derived(res)
    dflt = [ci for ci, c in enumerate([None] + LP_CONFIGS) if c is None or (c[0] == 0.05 and c[1] == "default")]
    per_window = []
    for i, w in enumerate(windows):
        row = dict(w)
        for fi, mode in enumerate(FEE_MODES):
            row[mode] = {("none" if ci == 0 else
                          f"u{round(LP_CONFIGS[ci - 1][2] * 100)}-{LP_CONFIGS[ci - 1][3]}-"
                          f"{'keeper' if LP_CONFIGS[ci - 1][5] else 'nokeeper'}"):
                         {"extra_bps": round(float(dv["extra_bps"][i, fi, ci]), 2),
                          "b_hodl_bps": round(float(dv["b_hodl_bps"][i, fi, ci]), 2),
                          "a_hodl_bps": round(float(dv["a_hodl_bps"][i, fi, ci]), 2),
                          "apr_a": round(float(dv["apr_a"][i, fi, ci]), 4)} for ci in dflt}
        per_window.append(row)

    params = asdict(p)
    params["curve"] = asdict(p.curve)
    out = {
        "study": "FORGE recent-regime study", "generated_at_utc": datetime.now(UTC).isoformat(timespec="seconds"),
        "seconds": round(time.time() - t0, 1), "data_manifest": manifest, "window_days": WINDOW_DAYS,
        "params_default": params, "program_parity": prog,
        "assumptions": {
            "fee_rate": FEE_RATE, "bucket_ticks": BUCKET_TICKS, "bonk_kmno_pool": "assumed 0.30% tier, tick spacing 64",
            "noise_per_day_x_lp_ladder": NOISE_PER_DAY, "holds_s": HOLDS_S, "utils": UTILS, "open_wait_s": OPEN_WAIT_S,
            "budgets": "realistic (90% fund max(3x expected floor, 1% notional), 10% fund 0.5x expected floor), "
                       "with and without a keeper closing at 80% of the LP cap",
            "hedge_usd": HEDGE_USD, "hedge_budget": "large enough to hold to expiry (no keeper close)",
            "fair_value": "Black-Scholes (r = 0) price of the exact FORGE range payoff, lognormal terminal price",
            "floors": FLOORS, "curves": {k: asdict(v) for k, v in CURVES.items()}, "takes": TAKES},
        "regimes": regimes, "deribit": {"meta": iv_meta, "sol_iv_daily_atm": iv_daily},
        "lp_summary": lp_rows, "lp_windows": per_window, "hedge_summary": hsum, "borrower_grid": bgrid,
        "hedges": [{k: v for k, v in h.items()} for h in hedges], "gbm_exante": gbm, "pricing_band": band,
    }
    (HERE / "results.json").write_text(json.dumps(out, indent=1, default=float) + "\n")
    print(f"wrote results.json in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
