import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from forge_math import premium as pm

u64 = st.integers(min_value=0, max_value=pm.U64_MAX)
u128 = st.integers(min_value=0, max_value=pm.U128 - 1)


def test_default_curve_matches_brief():
    c = pm.UtilizationCurve()
    assert c.multiplier_ppm(0) == 1_000_000
    assert c.multiplier_ppm(300_000) == 1_300_000
    assert c.multiplier_ppm(600_000) == 1_600_000
    assert c.multiplier_ppm(700_000) == 2_200_000
    assert c.multiplier_ppm(800_000) == 2_800_000
    with pytest.raises(ValueError):
        c.multiplier_ppm(800_001)


@given(st.integers(0, 800_000), st.integers(0, 800_000))
def test_curve_monotone_and_at_least_one(a, b):
    c = pm.UtilizationCurve()
    lo, hi = sorted((a, b))
    assert pm.PPM <= c.multiplier_ppm(lo) <= c.multiplier_ppm(hi)


def test_invalid_curves_rejected():
    with pytest.raises(ValueError):
        pm.UtilizationCurve(base_ppm=999_999)
    with pytest.raises(ValueError):
        pm.UtilizationCurve(kink_ppm=900_000, cap_ppm=800_000)
    with pytest.raises(ValueError):
        pm.UtilizationCurve(cap_ppm=1_000_001)


def test_utilization_rounds_up():
    assert pm.utilization_ppm(1, 3) == 333_334
    assert pm.utilization_ppm(0, 10) == 0
    with pytest.raises(ValueError):
        pm.utilization_ppm(11, 10)
    with pytest.raises(ValueError):
        pm.utilization_ppm(1, 0)


@given(u128, u128, u64)
def test_forgone_handles_wrapping(g0, d, L):
    g1 = (g0 + d) % pm.U128
    assert pm.forgone_from_growth(g0, g1, L) == pm.ceil_div(d * L, pm.Q64)


def test_forgone_wraps_across_u128_boundary():
    g0 = pm.U128 - pm.Q64  # one unit of fee per liquidity below the wrap
    g1 = pm.Q64            # one unit above the wrap
    assert pm.forgone_from_growth(g0, g1, 5) == 10


def test_time_floor_examples():
    # 5% on 1_000_000 atoms for a full year = 50_000 atoms
    assert pm.time_floor(1_000_000, 500, pm.SECONDS_PER_YEAR) == 50_000
    # any positive elapsed time yields at least one atom (rounded up)
    assert pm.time_floor(1_000_000, 500, 1) == 1
    assert pm.time_floor(1_000_000, 500, 0) == 0


def test_base_to_quote_rounds_up():
    price = 150 * pm.Q64 // 1000  # 0.15 quote atoms per base atom
    assert pm.base_to_quote(1000, price) == 150
    assert pm.base_to_quote(1, price) == 1


def _leg(**kw):
    d = dict(liquidity=10**9, multiplier_ppm=1_600_000, notional_quote=10**8, opened_at=0,
             growth_base_x64=0, growth_quote_x64=0)
    d.update(kw)
    return pm.LegAccrual(**d)


def test_leg_premium_is_max_not_sum():
    leg = _leg()
    # no fee growth: premium equals the time floor
    assert leg.premium(pm.SECONDS_PER_YEAR, 500) == 5_000_000
    leg.checkpoint(0, 10 * pm.Q64 // 10**6, ref_price_x64=pm.Q64)  # quote fees only
    forgone = leg.cum_forgone_quote
    assert forgone == 10_000
    assert leg.premium(1, 500) == pm.ceil_div(1_600_000 * forgone, pm.PPM)


def test_checkpoint_never_revalues_past_accrual():
    leg = _leg(multiplier_ppm=1_000_000)
    g = pm.Q64 // 10**6
    leg.checkpoint(g, 0, ref_price_x64=100 * pm.Q64)  # 1000 base atoms at 100
    first = leg.cum_forgone_quote
    assert first == 100_000
    # price crashes: earlier accrual is unchanged, only the new increment uses the new price
    leg.checkpoint(g, 0, ref_price_x64=1 * pm.Q64)
    assert leg.cum_forgone_quote == first
    leg.checkpoint(2 * g, 0, ref_price_x64=1 * pm.Q64)
    assert leg.cum_forgone_quote == first + 1000


@given(st.lists(st.tuples(st.integers(0, 2**40), st.integers(0, 2**40),
                          st.integers(1, 2**70)), min_size=1, max_size=10))
def test_cumulative_forgone_is_monotone(steps):
    leg = _leg()
    gb = gq = 0
    last = 0
    for db, dq, px in steps:
        gb, gq = (gb + db) % pm.U128, (gq + dq) % pm.U128
        leg.checkpoint(gb, gq, px)
        assert leg.cum_forgone_quote >= last
        last = leg.cum_forgone_quote


def test_budget_split_and_trigger():
    b = pm.Budget(total=100_000)
    assert b.bounty_reserve == 1_000
    assert b.lp_cap == 99_000
    assert not b.crank_allowed(79_199)
    assert b.crank_allowed(79_200)
    s = b.settle(accrued=50_000, keeper_paid=False)
    assert s == pm.Settlement(to_lp=50_000, lp_shortfall=0, keeper_bounty=0, refund_to_user=50_000)
    s = b.settle(accrued=150_000, keeper_paid=True)
    assert s == pm.Settlement(to_lp=99_000, lp_shortfall=51_000, keeper_bounty=1_000,
                              refund_to_user=0)


@given(st.integers(0, 10**15), st.integers(0, 10**16), st.booleans(),
       st.integers(0, 9_999), st.integers(1, 10_000))
def test_settlement_never_exceeds_budget(total, accrued, keeper, bounty_bps, trig):
    b = pm.Budget(total=total, bounty_bps=bounty_bps, trigger_bps=trig)
    s = b.settle(accrued, keeper)
    assert s.to_lp + s.keeper_bounty + s.refund_to_user == total
    assert min(s.to_lp, s.keeper_bounty, s.refund_to_user, s.lp_shortfall) >= 0
    assert s.to_lp + s.lp_shortfall == accrued


@settings(max_examples=200)
@given(st.lists(st.integers(1, 10**12), min_size=1, max_size=6),
       st.lists(st.integers(0, 10**9), min_size=1, max_size=20))
def test_premium_index_never_overpays(shares, amounts):
    idx = pm.PremiumIndex(total_shares=sum(shares))
    lps = [pm.LpCheckpoint(shares=s, index_x64=0) for s in shares]
    for a in amounts:
        idx.distribute(a)
    for lp in lps:
        lp.sync(idx)
    paid = sum(lp.owed for lp in lps)
    assert paid <= idx.deposited
    # dust is bounded: at most one atom per LP plus the carried bucket dust
    assert idx.deposited - paid <= len(lps) + idx.dust + 1


def test_late_joiner_cannot_claim_history():
    idx = pm.PremiumIndex(total_shares=100)
    early = pm.LpCheckpoint(shares=100, index_x64=0)
    idx.distribute(1_000)
    early.sync(idx)
    idx.total_shares += 100
    late = pm.LpCheckpoint(shares=100, index_x64=idx.index_x64)
    idx.distribute(1_000)
    early.sync(idx)
    late.sync(idx)
    assert early.owed == 1_500
    assert late.owed == 500
