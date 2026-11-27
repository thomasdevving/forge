"""The Python port of Orca's math must match @orca-so/whirlpools-core bit for bit."""

import json
from pathlib import Path

import pytest
from forge_math import orca

FIXTURE = Path(__file__).parent / "fixtures" / "orca_core_vectors.json"
V = json.loads(FIXTURE.read_text())["vectors"]


def _int(v):
    return None if v is None else int(v)


def _try(f, *args):
    try:
        return f(*args)
    except orca.OrcaMathError:
        return None


def test_tick_to_sqrt_price():
    for v in V["tick_to_sqrt"]:
        assert orca.sqrt_price_from_tick_index(v["tick"]) == int(v["sqrt_price"]), v


def test_sqrt_price_to_tick():
    for v in V["sqrt_to_tick"]:
        assert orca.tick_index_from_sqrt_price(int(v["sqrt_price"])) == v["tick"], v


@pytest.mark.parametrize("name,fn", [("amount_delta_a", orca.get_amount_delta_a),
                                     ("amount_delta_b", orca.get_amount_delta_b)])
def test_amount_deltas(name, fn):
    for v in V[name]:
        got = _try(fn, int(v["p0"]), int(v["p1"]), int(v["liquidity"]), v["round_up"])
        assert got == _int(v["amount"]), v


@pytest.mark.parametrize("name,sign", [("increase_quote", 1), ("decrease_quote", -1)])
def test_liquidity_quotes(name, sign):
    checked = 0
    for v in V[name]:
        if v["a"] is None:
            continue
        got = _try(orca.liquidity_token_deltas, v["tick_current"], int(v["sqrt_price"]),
                   v["tick_lower"], v["tick_upper"], sign * int(v["liquidity"]))
        assert got == (int(v["a"]), int(v["b"])), v
        checked += 1
    assert checked > 500


def test_fee_growth_inside_and_owed():
    checked = 0
    for v in V["collect_fees"]:
        if v["owed_a"] is None:
            continue
        lower = orca.TickGrowth(v["lower_init"], int(v["lower_out_a"]), int(v["lower_out_b"]))
        upper = orca.TickGrowth(v["upper_init"], int(v["upper_out_a"]), int(v["upper_out_b"]))
        ga, gb = orca.fee_growths_inside(v["tick_current"], lower, v["tick_lower"], upper,
                                         v["tick_upper"], int(v["global_a"]), int(v["global_b"]))
        L = int(v["liquidity"])
        assert orca.fees_owed_delta(ga, int(v["checkpoint_a"]), L) == int(v["owed_a"]), v
        assert orca.fees_owed_delta(gb, int(v["checkpoint_b"]), L) == int(v["owed_b"]), v
        checked += 1
    assert checked > 500
