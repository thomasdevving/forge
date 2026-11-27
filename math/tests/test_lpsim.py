import math
from dataclasses import replace

import numpy as np
import pytest

from forge_math.lpsim import (
    SimParams,
    band_path,
    fee_growth,
    gbm_path,
    ladder,
    ladder_value,
    ohlc_path,
    pool_path,
    program_defaults,
    program_parity,
    replay_check,
    simulate_demand,
    simulate_path,
)


def _paths(n, vol=0.9, steps=6_000):
    return [gbm_path(70.0, steps, vol, seed=100 + i) for i in range(n)]


NO_COST = {"restore_cost_bps_mean": 0.0, "restore_cost_bps_max": 0.0}


# ---------------------------------------------------------------------------------------------
# Program parity
# ---------------------------------------------------------------------------------------------


def test_defaults_match_the_program():
    d = program_defaults()
    assert d["floor_rate_bps"] == 500 and d["keeper_trigger_bps"] == 8_000 and d["bounty_bps"] == 100
    assert program_parity(SimParams())["match"]
    p = SimParams.from_program(fee_rate=0.003)
    assert p == SimParams(fee_rate=0.003)
    assert p.lp_cap_frac == 0.99 and p.keeper_trigger == 0.8


def test_parity_fails_loudly_on_mismatch():
    with pytest.raises(ValueError, match="floor_rate_bps"):
        program_parity(SimParams(floor_rate=0.04))
    with pytest.raises(ValueError, match="swap_slippage_bps"):
        program_parity(SimParams(swap_slippage_bps=100.0))


def test_unknown_fee_model_is_rejected():
    with pytest.raises(ValueError):
        SimParams(fee_model="every-tick")


# ---------------------------------------------------------------------------------------------
# Fee band
# ---------------------------------------------------------------------------------------------


def test_band_path_moves_only_to_the_band_edge():
    f = 0.003
    q = np.array([100.0, 100.2, 99.8, 100.29, 101.0, 100.5, 99.0])
    b = band_path(q, f)
    assert b[0] == 100.0
    # wiggles inside the band leave the pool price where it is
    assert b[1] == b[2] == b[3] == 100.0
    # outside the band the pool moves exactly to the edge
    assert b[4] == pytest.approx(101.0 / (1 + f))
    assert b[5] == b[4]                              # 100.5 is inside [b4 (1 - f), b4 (1 + f)]
    assert b[6] == pytest.approx(99.0 / (1 - f))
    assert np.all(b >= q / (1 + f) - 1e-12) and np.all(b <= q / (1 - f) + 1e-12)


def test_oscillation_inside_the_band_earns_no_arbitrage_fees():
    q = np.tile([70.0, 70.1, 69.9], 500)
    band = simulate_path(q, SimParams(open_prob=0.0), seed=0, path_id="band")
    legacy = simulate_path(q, SimParams(open_prob=0.0, fee_model="legacy-every-price"), seed=0, path_id="old")
    assert band.lp_fees_world_a == 0.0
    assert legacy.lp_fees_world_a > 0.0


def test_band_fees_are_below_legacy_fees():
    path = gbm_path(70.0, 20_000, 0.9, seed=7, step_seconds=15.0)
    p = SimParams(open_prob=0.0, step_seconds=15.0)
    band = simulate_path(path, p, seed=0, path_id="b")
    legacy = simulate_path(path, replace(p, fee_model="legacy-every-price"), seed=0, path_id="l")
    assert 0 < band.fee_apr_a < legacy.fee_apr_a


# ---------------------------------------------------------------------------------------------
# Noise volume
# ---------------------------------------------------------------------------------------------


def test_noise_volume_is_a_multiple_of_the_lp_ladder_value():
    """Flat price: only noise pays. LP fees per step = fee x keep x noise x ladder value x LP share."""
    for p0 in (0.26, 73.0, 2_500.0):          # the old sqrt(P0) scaling would differ by 0.5x..50x
        prices = np.full(1_001, p0)
        p = SimParams(noise_volume_per_step=0.001, open_prob=0.0)
        r = simulate_path(prices, p, seed=0, path_id="flat")
        lo, hi = ladder(p0, p)
        v0 = ladder_value(lo, hi, p0)
        assert r.lp_value_start == pytest.approx(v0)
        share = p.lp_liquidity / (p.lp_liquidity * (1 + p.background_ratio))
        expected = 1_000 * p.fee_rate * (1 - p.protocol_fee_share) * 0.001 * v0 * share
        assert r.lp_fees_world_a == pytest.approx(expected, rel=1e-9)


def test_arbitrage_only_measured_forgone_equals_counterfactual():
    """Without noise volume, idle fees + measured forgone fees == fees from staying in Orca."""
    p = SimParams(noise_volume_per_step=0.0, open_prob=0.01, mean_hold_steps=800,
                  budget_cap_prob=0.0, budget_notional_frac=1.0, **NO_COST)
    for i, path in enumerate(_paths(5)):
        r = simulate_path(path, p, seed=i, path_id=f"gbm{i}")
        assert r.borrows > 0
        assert r.lp_idle_fees_world_b + r.measured_forgone == pytest.approx(
            r.lp_fees_world_a, rel=1e-9, abs=1e-15)
        assert r.eligible
        assert r.guarantee_holds


def test_noise_volume_makes_the_measure_overstate_forgone_fees():
    p = SimParams(noise_volume_per_step=0.01, open_prob=0.01, mean_hold_steps=800,
                  budget_cap_prob=0.0, budget_notional_frac=1.0, **NO_COST)
    for i, path in enumerate(_paths(5)):
        r = simulate_path(path, p, seed=i, path_id=f"noise{i}")
        counterfactual = r.lp_fees_world_a - r.lp_idle_fees_world_b
        assert r.measured_forgone >= counterfactual - 1e-12
        assert r.eligible
        assert r.guarantee_holds


# ---------------------------------------------------------------------------------------------
# Premium: floor on the notional stored at open
# ---------------------------------------------------------------------------------------------


def test_call_floor_uses_the_open_reference_price():
    """A rally after a call is borrowed must not raise its floor (the program stores notional_quote
    at open)."""
    path = np.concatenate([np.full(200, 70.0), np.linspace(70.0, 69.0, 200), np.linspace(69.0, 75.0, 3_000)])
    p = SimParams(open_prob=0.05, mean_hold_steps=5_000, budget_cap_prob=0.0, budget_notional_frac=1.0, **NO_COST)
    events: list = []
    r = simulate_path(path, p, seed=1, path_id="call", record=events)
    pool = pool_path(path, p)
    lo, hi = ladder(float(pool[0]), p)
    calls = [b for b in events if b.kind == "call"]
    assert calls
    for b in calls:
        k = b.bucket
        assert b.notional == pytest.approx(p.lp_liquidity * b.util * (1 / lo[k] - 1 / hi[k]) * pool[b.opened])

    def floor(b, notional):
        return notional * p.floor_rate * (b.closed - b.opened) * p.step_seconds / (365 * 86_400)

    # premium accrued = sum over borrows of max(open-notional floor, m x forgone)
    assert r.premium_accrued == pytest.approx(
        sum(max(floor(b, b.notional), b.multiplier * b.forgone_quote) for b in events), rel=1e-12)
    # with the close price instead, call floors would be larger after this rally
    close_floor = sum(floor(b, p.lp_liquidity * b.util * (1 / lo[b.bucket] - 1 / hi[b.bucket]) * pool[b.closed])
                      for b in calls)
    assert close_floor > sum(floor(b, b.notional) for b in calls)


# ---------------------------------------------------------------------------------------------
# Budgets and keepers
# ---------------------------------------------------------------------------------------------


def test_underfunded_budgets_are_reported_as_shortfalls_not_hidden():
    p = SimParams(open_prob=0.02, mean_hold_steps=3_000, budget_cap_prob=1.0, **NO_COST)
    results = [simulate_path(path, p, seed=i, path_id=f"cap{i}") for i, path in enumerate(_paths(4))]
    assert any(r.shortfall > 0 for r in results)
    for r in results:
        assert r.premium_paid <= r.premium_accrued + 1e-15
        if r.shortfall > 0:
            assert not r.eligible


def test_keeper_closes_at_the_trigger_and_limits_shortfall():
    p = SimParams(open_prob=0.02, mean_hold_steps=3_000, budget_cap_prob=1.0, **NO_COST)
    pk = replace(p, keeper=True)
    delay = round(pk.keeper_delay_s / pk.step_seconds)
    short_no = short_k = 0.0
    closes = 0
    for i, path in enumerate(_paths(4)):
        events: list = []
        rk = simulate_path(path, pk, seed=i, path_id=f"k{i}", record=events)
        short_no += simulate_path(path, p, seed=i, path_id=f"n{i}").shortfall
        short_k += rk.shortfall
        closes += rk.keeper_closes
        for b in events:
            # never held past the floor trigger + keeper delay (no refusals here)
            assert b.closed <= b.t_floor + delay
            # floor premium at the trigger step reaches the trigger share of the cap
            floor_at_trigger = b.notional * p.floor_rate * (b.t_floor - b.opened) * p.step_seconds / (365 * 86_400)
            assert floor_at_trigger >= pk.keeper_trigger * pk.lp_cap_frac * b.budget * (1 - 1e-12)
    assert closes > 0
    assert short_k < 0.5 * short_no


def test_keeper_trigger_is_80_percent_of_the_lp_cap():
    """One deterministic borrow: the keeper fires at the first step where max(floor, m x forgone)
    >= 0.8 x 0.99 x budget, and the position closes keeper_delay_s later."""
    p = SimParams(keeper=True, open_prob=1.0, mean_hold_steps=1e9, budget_cap_prob=0.0, budget_multiple=0.0,
                  budget_notional_frac=0.0002, n_buckets=2, util_low=0.5, util_high=0.5, **NO_COST)
    path = np.full(3_000, 70.0)             # flat: no fees, the floor alone triggers
    events: list = []
    r = simulate_path(path, p, seed=0, path_id="one", record=events)
    b = next(e for e in events if e.opened == 1)
    per_step = b.notional * p.floor_rate * p.step_seconds / (365 * 86_400)
    t_trig = b.opened + math.ceil(0.8 * 0.99 * b.budget / per_step)
    assert b.t_floor == t_trig < len(path) - 10
    assert b.closed == t_trig + round(p.keeper_delay_s / p.step_seconds)
    assert r.keeper_closes >= 1


# ---------------------------------------------------------------------------------------------
# Restoration guard
# ---------------------------------------------------------------------------------------------


def test_slippage_guard_refuses_and_retries_without_losing_liquidity():
    p = SimParams(open_prob=0.02, restore_cost_bps_mean=80.0, restore_cost_bps_max=200.0,
                  budget_cap_prob=0.0, budget_notional_frac=1.0)
    results = []
    for i, path in enumerate(_paths(4, vol=1.5)):
        events: list = []
        r = simulate_path(path, p, seed=i, path_id=f"fail{i}", record=events)
        results.append(r)
        assert r.restored_exact == r.borrows          # refused restorations are retried, never dropped
        for b in events:
            if b.refusals:
                retry = round(p.restore_retry_s / p.step_seconds)
                assert b.closed >= b.opened + b.refusals * retry or b.closed == r.steps
        # premium keeps accruing while the liquidity is out: the funded guarantee still holds
        assert not r.borrow_violations
    assert sum(r.restoration_failures for r in results) > 0
    assert sum(r.borrows_with_refusals for r in results) > 0


def test_costs_within_the_slippage_cap_and_buffer_never_refuse():
    p = SimParams(open_prob=0.02, restore_cost_bps_mean=20.0, restore_cost_bps_max=50.0)
    for i, path in enumerate(_paths(3, vol=1.5)):
        assert simulate_path(path, p, seed=i, path_id=f"ok{i}").restoration_failures == 0


def test_thin_buffer_refuses_restorations():
    """Put restored with the price just under the range top: the escrow margin is (sb - s)^2 / sb per
    unit L against a swap of s (sb - s) / sb, so a 40 bps swap fails without a buffer when
    (sb - s) / s < 0.4%, and the 2% program buffer covers it."""
    from forge_math.lpsim import _restoration

    sa, sb = math.sqrt(69.0), math.sqrt(70.0)
    s = sb * (1 - 0.001)
    rng = np.random.default_rng(0)
    cost40 = {"restore_cost_bps_mean": 1e9, "restore_cost_bps_max": 40.0}
    assert not _restoration(SimParams(restoration_buffer=0.0, **cost40), "put", 0.5, sa, sb, s * s, rng)
    assert _restoration(SimParams(**cost40), "put", 0.5, sa, sb, s * s, rng)
    # above the 0.5% slippage cap a restoration is refused whatever the buffer
    cost60 = {"restore_cost_bps_mean": 1e9, "restore_cost_bps_max": 60.0}
    assert not _restoration(SimParams(**cost60), "put", 0.5, sa, sb, 69.5, rng)
    # nothing to swap (price above the put's range): always restores
    assert _restoration(SimParams(restoration_buffer=0.0, **cost60), "put", 0.5, sa, sb, 71.0, rng)


def test_every_borrow_restores_exactly():
    r = simulate_path(gbm_path(70.0, 5_000, 1.0, seed=3), SimParams(open_prob=0.02), seed=3,
                      path_id="x")
    assert r.restored_exact == r.borrows


# ---------------------------------------------------------------------------------------------
# Event engine == reference step simulation
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("over", [
    {},
    {"noise_volume_per_step": 0.002},
    {"keeper": True, "budget_cap_prob": 0.6},
    {"restore_cost_bps_mean": 80.0, "restore_cost_bps_max": 200.0},
    {"fee_model": "legacy-every-price"},
])
def test_event_engine_reproduces_simulate_path(over):
    path = gbm_path(70.0, 8_000, 1.2, seed=11)
    p = replace(SimParams(open_prob=0.01, mean_hold_steps=600), **over)
    r = replay_check(path, p, seed=5)
    assert r["borrows"] > 0
    assert r["max_rel_error"] < 1e-9, r["rel_error"]
    if over.get("keeper"):
        assert r["keeper_closes"] > 0
    if "restore_cost_bps_mean" in over:
        assert r["refusals"] > 0


def test_demand_sweep_funded_borrows_never_violate_the_guarantee():
    p = SimParams()
    fg = fee_growth(pool_path(gbm_path(70.0, 20_000, 1.0, seed=2), p), 60.0, p, 0.001)
    for keeper in (False, True):
        r = simulate_demand(fg, p, 0.5, 8 * 3_600.0, "funded", keeper, seed=3, min_budget=1e-12)
        assert r["borrows"] > 0 and r["violations"] == 0 and r["short"] == 0.0
        assert r["paid"] >= r["lost_v"] - 1e-12


def test_ohlc_expansion_orders():
    o, h, low, c = (np.array([1.0, 2.0]), np.array([3.0, 4.0]), np.array([0.5, 1.5]),
                    np.array([2.0, 3.0]))
    assert list(ohlc_path(o, h, low, c, True)[:4]) == [1.0, 3.0, 0.5, 2.0]
    assert list(ohlc_path(o, h, low, c, False)[:4]) == [1.0, 0.5, 3.0, 2.0]
