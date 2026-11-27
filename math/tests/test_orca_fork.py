"""The math port must reproduce Orca's deployed program, observed on the mainnet fork.

Fixture produced by `pnpm --filter @forge/fork exec tsx scripts/observe-orca.ts` against a
Surfpool fork of mainnet. It contains raw account bytes before each instruction and the
observed token balance changes, so these tests need no network.
"""

import json
from pathlib import Path

from forge_math import orca
from forge_math.orca_accounts import decode_position, decode_tick_array, decode_whirlpool

FIXTURE = Path(__file__).parent / "fixtures" / "orca_fork_observations.json"
DATA = json.loads(FIXTURE.read_text())
OBS = DATA["observations"]
SOL_USDC_TS4 = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE"


def test_fixture_covers_all_regimes():
    regimes = {(o["regime"], o["op"]) for o in OBS if o["kind"] == "liquidity"}
    for r in ("below", "around", "above"):
        assert (r, "increase") in regimes and (r, "decrease") in regimes


def test_decoders_read_live_accounts():
    o = next(o for o in OBS if o["kind"] == "liquidity")
    w = decode_whirlpool(o["before"]["whirlpool"])
    assert w.tick_spacing == 4 and w.fee_rate == 400
    assert w.token_mint_a == "So11111111111111111111111111111111111111112"
    assert w.token_mint_b == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    assert orca.tick_index_from_sqrt_price(w.sqrt_price) == w.tick_current_index
    p = decode_position(o["before"]["position"])
    assert p.whirlpool == SOL_USDC_TS4
    assert (p.tick_lower_index, p.tick_upper_index) == (o["tick_lower"], o["tick_upper"])
    ta = decode_tick_array(o["before"]["tick_lower_array"])
    assert ta.whirlpool == SOL_USDC_TS4
    assert ta.start_tick_index == orca.tick_array_start_index(o["tick_lower"], 4)


def test_liquidity_token_deltas_match_chain():
    for o in OBS:
        if o["kind"] != "liquidity":
            continue
        w = decode_whirlpool(o["before"]["whirlpool"])
        L = int(o["liquidity"])
        sign = 1 if o["op"] == "increase" else -1
        a, b = orca.liquidity_token_deltas(w.tick_current_index, w.sqrt_price, o["tick_lower"],
                                           o["tick_upper"], sign * L)
        # owner balance change is the negative of what the pool takes on increase
        assert int(o["delta_a"]) == -sign * a, o["regime"] + " " + o["op"]
        assert int(o["delta_b"]) == -sign * b, o["regime"] + " " + o["op"]


def test_fee_growth_inside_matches_position_checkpoint():
    o = next(o for o in OBS if o["kind"] == "fee_growth")
    s = o["after"]
    w = decode_whirlpool(s["whirlpool"])
    p = decode_position(s["position"])
    lo_arr = decode_tick_array(s["tick_lower_array"])
    hi_arr = decode_tick_array(s["tick_upper_array"])
    lo = lo_arr.tick(p.tick_lower_index, w.tick_spacing)
    hi = hi_arr.tick(p.tick_upper_index, w.tick_spacing)
    assert lo.initialized and hi.initialized
    ga, gb = orca.fee_growths_inside(w.tick_current_index, lo.growth(), p.tick_lower_index,
                                     hi.growth(), p.tick_upper_index, w.fee_growth_global_a,
                                     w.fee_growth_global_b)
    # a liquidity change sets the checkpoint to the growth inside (Full mode)
    assert p.fee_growth_checkpoint_a == ga
    assert p.fee_growth_checkpoint_b == gb
    # and the swaps through the range produced real fees for the position
    assert p.fee_owed_a > 0 or p.fee_owed_b > 0
