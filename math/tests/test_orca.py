"""Program-specific branches of the Orca port that the SDK quote functions do not cover."""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from forge_math import orca

U128 = orca.U128
ticks = st.integers(orca.MIN_TICK_INDEX, orca.MAX_TICK_INDEX)


def test_bounds_match_constants():
    assert orca.sqrt_price_from_tick_index(orca.MIN_TICK_INDEX) == orca.MIN_SQRT_PRICE_X64
    assert orca.sqrt_price_from_tick_index(orca.MAX_TICK_INDEX) == orca.MAX_SQRT_PRICE_X64
    assert orca.sqrt_price_from_tick_index(0) == orca.Q64
    with pytest.raises(orca.OrcaMathError):
        orca.sqrt_price_from_tick_index(orca.MAX_TICK_INDEX + 1)


@given(ticks)
def test_tick_round_trip(t):
    sp = orca.sqrt_price_from_tick_index(t)
    assert orca.tick_index_from_sqrt_price(sp) == t
    if t < orca.MAX_TICK_INDEX:
        nxt = orca.sqrt_price_from_tick_index(t + 1)
        assert nxt > sp
        assert orca.tick_index_from_sqrt_price(nxt - 1) == t


def test_uninitialized_ticks_follow_program_semantics():
    g = 1000 << 64
    init = orca.TickGrowth(True, 100 << 64, 0)
    uninit = orca.TickGrowth(False)
    # uninitialized lower tick: everything below counts as global, so inside is 0 - above
    ga, _ = orca.fee_growths_inside(50, uninit, 0, init, 100, g, 0)
    assert ga == (g - g - (100 << 64)) % U128
    # uninitialized upper tick: above is 0
    ga, _ = orca.fee_growths_inside(50, init, 0, uninit, 100, g, 0)
    assert ga == (g - (100 << 64)) % U128


@given(st.integers(0, U128 - 1), st.integers(0, U128 - 1), st.integers(0, U128 - 1),
       st.integers(-1000, 1000))
def test_fee_growth_inside_consistency(global_g, lo_out, hi_out, cur):
    """inside(lower, upper) = inside(lower, mid) + inside(mid, upper) for initialized ticks."""
    lo, mid, hi = -100, 0, 100
    mid_out = (global_g // 3) % U128
    t_lo = orca.TickGrowth(True, lo_out, 0)
    t_mid = orca.TickGrowth(True, mid_out, 0)
    t_hi = orca.TickGrowth(True, hi_out, 0)
    whole, _ = orca.fee_growths_inside(cur, t_lo, lo, t_hi, hi, global_g, 0)
    left, _ = orca.fee_growths_inside(cur, t_lo, lo, t_mid, mid, global_g, 0)
    right, _ = orca.fee_growths_inside(cur, t_mid, mid, t_hi, hi, global_g, 0)
    assert whole == (left + right) % U128


def test_fees_owed_overflow_yields_zero_like_program():
    assert orca.fees_owed_delta(U128 - 1, 0, U128 - 1) == 0
    assert orca.fees_owed_delta(5 << 64, 2 << 64, 10) == 30


def test_tick_array_addressing():
    assert orca.tick_array_start_index(0, 4) == 0
    assert orca.tick_array_start_index(351, 4) == 0
    assert orca.tick_array_start_index(352, 4) == 352
    assert orca.tick_array_start_index(-1, 4) == -352
    assert orca.tick_offset_in_array(-4, -352, 4) == 87
    with pytest.raises(orca.OrcaMathError):
        orca.tick_offset_in_array(3, 0, 4)


def test_liquidity_deltas_regimes_and_rounding():
    lo, hi = -400, 400
    sp = orca.sqrt_price_from_tick_index(0)
    inc = orca.liquidity_token_deltas(0, sp, lo, hi, 10**12)
    dec = orca.liquidity_token_deltas(0, sp, lo, hi, -(10**12))
    assert inc[0] >= dec[0] and inc[1] >= dec[1]
    assert inc[0] - dec[0] <= 1 and inc[1] - dec[1] <= 1
    below = orca.liquidity_token_deltas(-1000, orca.sqrt_price_from_tick_index(-1000), lo, hi,
                                        10**12)
    assert below[1] == 0 and below[0] > 0
    above = orca.liquidity_token_deltas(400, orca.sqrt_price_from_tick_index(400), lo, hi, 10**12)
    assert above[0] == 0 and above[1] > 0  # tick_current == upper is "above"
    with pytest.raises(orca.OrcaMathError):
        orca.liquidity_token_deltas(0, sp, lo, hi, 0)


@given(st.integers(1, 2**100), st.integers(-2000, 2000), st.integers(1, 400))
def test_increase_then_decrease_never_returns_more(L, lower, width):
    """Rounding favors the pool: removing liquidity never returns more than adding cost."""
    lo = lower * 4
    hi = lo + width * 4
    for cur in (lo - 8, lo, (lo + hi) // 2, hi - 1, hi + 8):
        sp = orca.sqrt_price_from_tick_index(cur)
        try:
            a_in, b_in = orca.liquidity_token_deltas(cur, sp, lo, hi, L)
        except orca.OrcaMathError:
            continue
        a_out, b_out = orca.liquidity_token_deltas(cur, sp, lo, hi, -L)
        assert a_out <= a_in and b_out <= b_in


def test_swap_fee_growth_increment():
    # 1_000 atoms of fee, 13% protocol share, liquidity 10**6: (870 << 64) // 10**6
    assert orca.swap_fee_growth_increment(1000, 1300, 10**6) == (870 << 64) // 10**6
    assert orca.swap_fee_growth_increment(1000, 1300, 0) == 0
