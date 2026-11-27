import numpy as np
import pytest

from forge_compiler import presets
from forge_compiler.baseline import compile_baseline
from forge_compiler.model import UserLimits, grid_for_market
from forge_compiler.optimizer import compile_optimizer
from forge_verifier.certificate import build_certificate, construction_from_dict, verify_certificate
from forge_verifier.exact import construction_value

SPOT = 73.23


def market_grid(borrowable=4 * 10**13):
    g = grid_for_market(SPOT, 64, 4, 12)
    lowers = {b.tick_lower: borrowable for b in g.buckets}
    return grid_for_market(SPOT, 64, 4, 12, borrowable=lowers)


def limits(base=20.0, quote=2_000.0, premium=20.0, legs=8):
    return UserLimits(base_holdings=base, quote_holdings=quote, premium_budget=premium, max_legs=legs)


def certify(res, payoff, grid):
    c = res.construction.to_dict()
    return build_certificate(
        market={"whirlpool": "test", "base_decimals": grid.base_decimals, "quote_decimals": grid.quote_decimals,
                "spot": grid.spot},
        target=list(payoff.breakpoints), construction=c, premium_budget=20.0, liquidity_check=[])


def dense_check(cert, payoff, n=50_000):
    m = cert["market"]
    vc = construction_from_dict(cert["construction"], m["base_decimals"], m["quote_decimals"])
    lo, hi = payoff.domain
    rng = np.random.default_rng(1)
    s = np.concatenate([np.linspace(lo, hi, n), rng.uniform(lo, hi, n)])
    f = payoff(s)
    err = max(abs(construction_value(vc, float(x)) - float(y)) for x, y in zip(s, f))
    return err


@pytest.mark.parametrize("make", [
    lambda: presets.protective_put(10, 62.0, SPOT),
    lambda: presets.collar(10, 62.0, 88.0, SPOT),
    lambda: presets.put_spread(10, 66.0, 55.0, SPOT),
    lambda: presets.strangle(10, 60.0, 90.0, SPOT),
    lambda: presets.call_spread(5, 80.0, 95.0, SPOT),
    lambda: presets.butterfly(3, 80.0, 88.0, 96.0, SPOT),
])
def test_optimizer_compiles_and_certificate_bound_holds(make):
    payoff = make()
    grid = market_grid()
    res = compile_optimizer(payoff, grid, limits())
    assert res.status == "ok", res.reasons
    assert len(res.construction.legs) <= 8
    cert = certify(res, payoff, grid)
    assert verify_certificate(cert)
    # the exact bound dominates a dense out-of-sample check
    assert dense_check(cert, payoff) <= cert["error"]["certified_bound"] + 1e-9
    # and the exact max is attained (not loose): within a hair of the dense estimate
    assert cert["error"]["max_gross_error"] - dense_check(cert, payoff) < 1e-3 * cert["error"]["max_gross_error"] + 1e-9


def test_optimizer_is_no_worse_than_baseline():
    payoff = presets.collar(10, 62.0, 88.0, SPOT)
    grid = market_grid()
    opt = compile_optimizer(payoff, grid, limits())
    base = compile_baseline(payoff, grid, limits())
    assert opt.sampled_max_error <= base.sampled_max_error + 1e-6


def test_kink_at_spot_is_infeasible_with_reason():
    payoff = presets.protective_put(10, SPOT, SPOT)
    res = compile_optimizer(payoff, market_grid(), limits(), tolerance=0.5)
    assert res.status == "infeasible"
    assert any("current price" in r for r in res.reasons)
    assert res.closest_feasible


def test_no_borrowable_liquidity_is_reported():
    payoff = presets.protective_put(10, 62.0, SPOT)
    res = compile_optimizer(payoff, market_grid(borrowable=0), limits(), tolerance=1.0)
    assert res.status == "infeasible"


def test_holdings_and_leg_limits_are_respected():
    payoff = presets.collar(10, 62.0, 88.0, SPOT)
    lim = limits(base=10.0, quote=50.0, legs=2)  # tight holdings and legs
    res = compile_optimizer(payoff, market_grid(), lim)
    c = res.construction
    assert len(c.legs) <= 2
    assert c.base + c.provided_base + c.buffer_base <= 10.0 + 1e-9
    assert c.cash + c.provided_quote + c.buffer_quote <= 50.0 - 20.0 + 1e-6
    for leg in c.legs:
        if leg.kind.startswith("borrow"):
            assert leg.price_upper < SPOT or leg.price_lower > SPOT


def test_borrowed_legs_are_strictly_out_of_range_on_the_right_side():
    payoff = presets.strangle(10, 60.0, 90.0, SPOT)
    res = compile_optimizer(payoff, market_grid(), limits())
    for leg in res.construction.legs:
        if leg.kind in ("borrow_put", "provide_put"):
            assert leg.price_upper < SPOT
        else:
            assert leg.price_lower > SPOT
