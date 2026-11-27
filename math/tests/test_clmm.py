import math

import numpy as np
import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from forge_math import clmm

prices = st.floats(min_value=1e-3, max_value=1e5, allow_nan=False, allow_infinity=False)
liq = st.floats(min_value=1e-3, max_value=1e9, allow_nan=False, allow_infinity=False)


@st.composite
def ranges(draw):
    a = draw(prices)
    width = draw(st.floats(min_value=1.0001, max_value=50.0))
    return a, a * width


def test_regimes_match_closed_form():
    L, pa, pb = 1000.0, 80.0, 100.0
    x, y = clmm.token_amounts(L, 50.0, pa, pb)
    assert x == pytest.approx(L * (1 / math.sqrt(pa) - 1 / math.sqrt(pb)))
    assert y == 0
    x, y = clmm.token_amounts(L, 200.0, pa, pb)
    assert x == 0
    assert y == pytest.approx(L * (math.sqrt(pb) - math.sqrt(pa)))
    P = 90.0
    x, y = clmm.token_amounts(L, P, pa, pb)
    assert x == pytest.approx(L * (1 / math.sqrt(P) - 1 / math.sqrt(pb)))
    assert y == pytest.approx(L * (math.sqrt(P) - math.sqrt(pa)))


def test_in_range_value_formula():
    L, pa, pb, P = 7.0, 4.0, 9.0, 6.25
    expected = L * (2 * math.sqrt(P) - P / math.sqrt(pb) - math.sqrt(pa))
    assert clmm.value(L, P, pa, pb) == pytest.approx(expected)


@given(liq, ranges(), prices)
def test_value_is_continuous_and_bounded(L, rng, P):
    pa, pb = rng
    v = float(clmm.value(L, P, pa, pb))
    # value is at most the all-quote value and at least zero
    assert v >= 0
    assert v <= clmm.max_quote(L, pa, pb) * (1 + 1e-9) + 1e-9
    # continuity at the boundaries
    for b in (pa, pb):
        lo, hi = clmm.value(L, [b * (1 - 1e-9), b * (1 + 1e-9)], pa, pb)
        assert lo == pytest.approx(hi, rel=1e-6, abs=1e-9)


@given(ranges(), st.lists(prices, min_size=2, max_size=20))
def test_value_is_nondecreasing_and_concave(rng, ps):
    pa, pb = rng
    P = np.sort(np.array(ps))
    v = clmm.unit_value(P, pa, pb)
    assert np.all(np.diff(v) >= -1e-9 * np.maximum(1, np.abs(v[1:])))
    assert np.all(clmm.unit_value_second_derivative(P, pa, pb) <= 0)


@given(ranges(), prices)
@settings(max_examples=200)
def test_derivative_matches_finite_difference(rng, P):
    pa, pb = rng
    h = P * 1e-6
    assume(abs(P - pa) > 2 * h and abs(P - pb) > 2 * h)
    num = (clmm.unit_value(P + h, pa, pb) - clmm.unit_value(P - h, pa, pb)) / (2 * h)
    assert clmm.unit_value_derivative(P, pa, pb) == pytest.approx(num, rel=1e-5, abs=1e-9)


@given(liq, ranges(), st.floats(min_value=1.01, max_value=49.0), prices)
def test_additivity_of_split_ranges(L, rng, frac, P):
    """L over [a, c] equals L over [a, b] plus L over [b, c] at every price."""
    pa, pc = rng
    pb = pa * min(frac, pc / pa * 0.999)
    assume(pa < pb < pc)
    whole = clmm.token_amounts(L, P, pa, pc)
    left = clmm.token_amounts(L, P, pa, pb)
    right = clmm.token_amounts(L, P, pb, pc)
    assert whole[0] == pytest.approx(left[0] + right[0], rel=1e-9, abs=1e-9)
    assert whole[1] == pytest.approx(left[1] + right[1], rel=1e-9, abs=1e-9)


@given(liq, ranges(), prices, st.floats(min_value=0.01, max_value=0.99))
def test_borrowed_put_is_self_collateralized(L, rng, P, f):
    """Section 3.2: escrowed quote always covers restoration of a range below spot."""
    pa, pb = rng
    p_open = pb / f
    put = clmm.BorrowedRange(L, pa, pb, p_open)
    assert put.kind == "put"
    ex, ey = put.escrow()
    assert ex == 0
    assert ey == pytest.approx(clmm.max_quote(L, pa, pb))
    assert put.payoff(P) >= -1e-9 * max(1.0, ey)


@given(liq, ranges(), prices, st.floats(min_value=0.01, max_value=0.99))
def test_borrowed_call_is_self_collateralized(L, rng, P, f):
    pa, pb = rng
    p_open = pa * f
    call = clmm.BorrowedRange(L, pa, pb, p_open)
    assert call.kind == "call"
    ex, ey = call.escrow()
    assert ey == 0
    assert ex == pytest.approx(clmm.max_base(L, pa, pb))
    assert call.payoff(P) >= -1e-9 * max(1.0, ex * P)


def test_put_payoff_shape():
    put = clmm.BorrowedRange(1000.0, 80.0, 100.0, 120.0)
    assert put.payoff(150.0) == pytest.approx(0.0, abs=1e-9)
    assert put.payoff(100.0) == pytest.approx(0.0, abs=1e-9)
    deep = put.payoff(40.0)
    _, ey = put.escrow()
    # deep below: restoring costs x * P with x = max_base; payoff -> escrow - max_base * P
    assert deep == pytest.approx(ey - clmm.max_base(1000.0, 80.0, 100.0) * 40.0)
    assert put.payoff(60.0) > put.payoff(90.0) > 0


def test_borrowed_range_must_be_out_of_range():
    with pytest.raises(ValueError):
        clmm.BorrowedRange(1.0, 80.0, 100.0, 90.0)
    with pytest.raises(ValueError):
        clmm.BorrowedRange(1.0, 80.0, 100.0, 100.0)  # boundary-touching is rejected


def test_invalid_inputs():
    with pytest.raises(ValueError):
        clmm.value(1.0, 1.0, 5.0, 5.0)
    with pytest.raises(ValueError):
        clmm.value(1.0, -1.0, 1.0, 2.0)
