import math

import pytest
from forge_verifier.certificate import build_certificate, verify_certificate
from forge_verifier.exact import VConstruction, VLeg, construction_value, max_error, tick_to_price
from hypothesis import given, settings
from hypothesis import strategies as st

BD, QD = 9, 6
SCALE = 10 ** (-(BD + QD) / 2)


def brute(target, c, n=200_001):
    lo, hi = target[0][0], target[-1][0]
    best = 0.0
    for i in range(n):
        s = lo + (hi - lo) * i / (n - 1)
        for (x0, y0), (x1, y1) in zip(target, target[1:]):
            if x0 <= s <= x1:
                f = y0 + (y1 - y0) * (s - x0) / (x1 - x0)
                break
        best = max(best, abs(f - construction_value(c, s)))
    return best


def test_zero_error_for_exact_linear_holdings():
    c = VConstruction(cash=100.0, base=2.0, legs=(), base_decimals=BD, quote_decimals=QD)
    t = [(10.0, 120.0), (200.0, 500.0)]
    assert max_error(t, c).max_error == pytest.approx(0.0, abs=1e-9)


def test_provided_range_value_matches_closed_form():
    leg = VLeg("provide_put", -27000, -26744, int(1e7 / SCALE))
    c = VConstruction(0.0, 0.0, (leg,), BD, QD)
    pa, pb = tick_to_price(-27000, BD, QD), tick_to_price(-26744, BD, QD)
    L = leg.liquidity_onchain * SCALE
    s = math.sqrt(pa * pb)
    assert construction_value(c, s) == pytest.approx(L * (2 * math.sqrt(s) - s / math.sqrt(pb) - math.sqrt(pa)))
    assert construction_value(c, pb * 2) == pytest.approx(L * (math.sqrt(pb) - math.sqrt(pa)))
    assert construction_value(c, pa / 2) == pytest.approx(L * (1 / math.sqrt(pa) - 1 / math.sqrt(pb)) * pa / 2)


def test_borrowed_put_payoff_is_nonnegative_and_zero_above():
    leg = VLeg("borrow_put", -27000, -26744, int(1e7 / SCALE))
    c = VConstruction(0.0, 0.0, (leg,), BD, QD)
    pb = tick_to_price(-26744, BD, QD)
    assert construction_value(c, pb * 1.5) == pytest.approx(0.0, abs=1e-9)
    assert construction_value(c, pb * 0.5) > 0


@settings(max_examples=25, deadline=None)
@given(st.integers(-28_000, -25_000), st.integers(1, 6), st.floats(0.0, 50.0), st.floats(0.0, 3.0),
       st.sampled_from(["borrow_put", "borrow_call", "provide_put", "provide_call"]))
def test_exact_bound_matches_brute_force(lo_tick, width_buckets, cash, base, kind):
    lo = (lo_tick // 256) * 256
    leg = VLeg(kind, lo, lo + 256 * width_buckets, int(2e6 / SCALE))
    c = VConstruction(cash, base, (leg,), BD, QD)
    p0 = tick_to_price(lo, BD, QD)
    target = [(p0 * 0.6, 50.0), (p0 * 0.95, 120.0), (p0 * 1.3, 90.0), (p0 * 1.8, 300.0)]
    exact = max_error(target, c).max_error
    sampled = brute(target, c, 20_001)
    # exact maximum is never below a sampled maximum, and the sample gets close to it
    assert exact >= sampled - 1e-9
    assert exact - sampled <= 1e-3 * max(1.0, exact)


def test_certificate_hash_detects_tampering():
    doc = build_certificate(
        market={"whirlpool": "w", "base_decimals": BD, "quote_decimals": QD, "spot": 73.0},
        target=[(40.0, 100.0), (120.0, 900.0)],
        construction={"cash": 1.0, "base": 2.0, "legs": [
            {"kind": "borrow_put", "tick_lower": -27136, "tick_upper": -26880, "liquidity_onchain": 10**12}]},
        premium_budget=10.0, liquidity_check=[])
    assert verify_certificate(doc)
    assert len(doc["hash"]) == 64
    doc["construction"]["cash"] = 2.0
    assert not verify_certificate(doc)
