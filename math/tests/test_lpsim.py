import numpy as np
import pytest
from forge_math.lpsim import SimParams, gbm_path, ohlc_path, simulate_path


def _paths(n, vol=0.9, steps=6_000):
    return [gbm_path(70.0, steps, vol, seed=100 + i) for i in range(n)]


def test_arbitrage_only_measured_forgone_equals_counterfactual():
    """Without noise volume, idle fees + measured forgone fees == fees from staying in Orca."""
    p = SimParams(noise_volume_per_step=0.0, open_prob=0.01, mean_hold_steps=800,
                  budget_cap_prob=0.0, budget_notional_frac=1.0, restore_cost_bps_mean=0.0, restore_cost_bps_max=0.0)
    for i, path in enumerate(_paths(5)):
        r = simulate_path(path, p, seed=i, path_id=f"gbm{i}")
        assert r.borrows > 0
        assert r.lp_idle_fees_world_b + r.measured_forgone == pytest.approx(
            r.lp_fees_world_a, rel=1e-9, abs=1e-15)
        assert r.eligible
        assert r.guarantee_holds


def test_noise_volume_makes_the_measure_overstate_forgone_fees():
    p = SimParams(noise_volume_per_step=0.001, open_prob=0.01, mean_hold_steps=800,
                  budget_cap_prob=0.0, budget_notional_frac=1.0, restore_cost_bps_mean=0.0, restore_cost_bps_max=0.0)
    for i, path in enumerate(_paths(5)):
        r = simulate_path(path, p, seed=i, path_id=f"noise{i}")
        counterfactual = r.lp_fees_world_a - r.lp_idle_fees_world_b
        assert r.measured_forgone >= counterfactual - 1e-12
        assert r.eligible
        assert r.guarantee_holds


def test_underfunded_budgets_are_reported_as_shortfalls_not_hidden():
    p = SimParams(open_prob=0.02, mean_hold_steps=3_000, budget_cap_prob=1.0,
                  restore_cost_bps_mean=0.0, restore_cost_bps_max=0.0)
    results = [simulate_path(path, p, seed=i, path_id=f"cap{i}") for i, path in enumerate(_paths(4))]
    assert any(r.shortfall > 0 for r in results)
    for r in results:
        assert r.premium_paid <= r.premium_accrued + 1e-15
        if r.shortfall > 0:
            assert not r.eligible


def test_expensive_restoration_is_reported_as_failure():
    p = SimParams(open_prob=0.02, restoration_buffer=0.0, restore_cost_bps_mean=200.0,
                  restore_cost_bps_max=500.0, budget_cap_prob=0.0)
    results = [simulate_path(path, p, seed=i, path_id=f"fail{i}") for i, path in enumerate(_paths(4, vol=1.5))]
    assert sum(r.restoration_failures for r in results) > 0
    assert all(not r.eligible for r in results if r.restoration_failures)


def test_every_borrow_restores_exactly():
    r = simulate_path(gbm_path(70.0, 5_000, 1.0, seed=3), SimParams(open_prob=0.02), seed=3,
                      path_id="x")
    assert r.restored_exact == r.borrows


def test_ohlc_expansion_orders():
    o, h, low, c = (np.array([1.0, 2.0]), np.array([3.0, 4.0]), np.array([0.5, 1.5]),
                    np.array([2.0, 3.0]))
    assert list(ohlc_path(o, h, low, c, True)[:4]) == [1.0, 3.0, 0.5, 2.0]
    assert list(ohlc_path(o, h, low, c, False)[:4]) == [1.0, 0.5, 3.0, 2.0]
