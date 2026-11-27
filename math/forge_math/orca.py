"""Exact integer port of Orca Whirlpools math (programs/whirlpool/src/math, tick/fee managers).

Ported from orca-so/whirlpools main @ cc683ec. Every function reproduces Orca's integer
results bit for bit, including rounding direction and overflow errors, and is checked against
`@orca-so/whirlpools-core` golden vectors and live fork state (see math/tests/test_orca*.py).
The on-chain FORGE program uses the same algorithms (programs/forge/src/math/).
"""

from __future__ import annotations

from dataclasses import dataclass

U64_MAX = (1 << 64) - 1
U128 = 1 << 128
U128_MAX = U128 - 1
U256 = 1 << 256
Q64 = 1 << 64
Q64_MASK = U64_MAX

MAX_TICK_INDEX = 443636
MIN_TICK_INDEX = -443636
MAX_SQRT_PRICE_X64 = 79226673515401279992447579055
MIN_SQRT_PRICE_X64 = 4295048016
TICK_ARRAY_SIZE = 88
NUM_REWARDS = 3
FEE_RATE_MUL_VALUE = 1_000_000
PROTOCOL_FEE_RATE_MUL_VALUE = 10_000


class OrcaMathError(ArithmeticError):
    """Raised where the Orca program would return an error (overflow, token max exceeded)."""


# ---------------------------------------------------------------------------
# Tick math
# ---------------------------------------------------------------------------

_POS_FACTORS = [
    (2, 79236085330515764027303304731), (4, 79244008939048815603706035061),
    (8, 79259858533276714757314932305), (16, 79291567232598584799939703904),
    (32, 79355022692464371645785046466), (64, 79482085999252804386437311141),
    (128, 79736823300114093921829183326), (256, 80248749790819932309965073892),
    (512, 81282483887344747381513967011), (1024, 83390072131320151908154831281),
    (2048, 87770609709833776024991924138), (4096, 97234110755111693312479820773),
    (8192, 119332217159966728226237229890), (16384, 179736315981702064433883588727),
    (32768, 407748233172238350107850275304), (65536, 2098478828474011932436660412517),
    (131072, 55581415166113811149459800483533),
    (262144, 38992368544603139932233054999993551),
]
_NEG_FACTORS = [
    (2, 18444899583751176498), (4, 18443055278223354162), (8, 18439367220385604838),
    (16, 18431993317065449817), (32, 18417254355718160513), (64, 18387811781193591352),
    (128, 18329067761203520168), (256, 18212142134806087854), (512, 17980523815641551639),
    (1024, 17526086738831147013), (2048, 16651378430235024244), (4096, 15030750278693429944),
    (8192, 12247334978882834399), (16384, 8131365268884726200), (32768, 3584323654723342297),
    (65536, 696457651847595233), (131072, 26294789957452057), (262144, 37481735321082),
]


def sqrt_price_from_tick_index(tick: int) -> int:
    """Q64.64 sqrt price at a tick (Orca tick_math.rs)."""
    if not MIN_TICK_INDEX <= tick <= MAX_TICK_INDEX:
        raise OrcaMathError(f"tick {tick} out of bounds")
    if tick >= 0:
        ratio = (79232123823359799118286999567 if tick & 1
                 else 79228162514264337593543950336)
        for bit, k in _POS_FACTORS:
            if tick & bit:
                ratio = (ratio * k) >> 96  # mul_shift_96 via U256
        return ratio >> 32
    a = -tick
    ratio = 18445821805675392311 if a & 1 else 18446744073709551616
    for bit, k in _NEG_FACTORS:
        if a & bit:
            ratio = ((ratio * k) >> 64) & U128_MAX
    return ratio


_LOG_B_2_X32 = 59543866431248
_BIT_PRECISION = 14
_LOG_B_P_ERR_MARGIN_LOWER_X64 = 184467440737095516
_LOG_B_P_ERR_MARGIN_UPPER_X64 = 15793534762490258745


def tick_index_from_sqrt_price(sqrt_price_x64: int) -> int:
    """Greatest tick whose sqrt price is <= the given sqrt price (Orca tick_math.rs)."""
    if not MIN_SQRT_PRICE_X64 <= sqrt_price_x64 <= MAX_SQRT_PRICE_X64:
        raise OrcaMathError("sqrt price out of bounds")
    msb = sqrt_price_x64.bit_length() - 1
    log2p_integer_x32 = (msb - 64) << 32
    bit = 0x8000_0000_0000_0000
    precision = 0
    log2p_fraction_x64 = 0
    r = sqrt_price_x64 >> (msb - 63) if msb >= 64 else sqrt_price_x64 << (63 - msb)
    while bit > 0 and precision < _BIT_PRECISION:
        r = (r * r) & U128_MAX
        is_r_more_than_two = r >> 127
        r >>= 63 + is_r_more_than_two
        log2p_fraction_x64 += bit * is_r_more_than_two
        bit >>= 1
        precision += 1
    log2p_fraction_x32 = log2p_fraction_x64 >> 32
    log2p_x32 = log2p_integer_x32 + log2p_fraction_x32
    logbp_x64 = log2p_x32 * _LOG_B_2_X32
    tick_low = (logbp_x64 - _LOG_B_P_ERR_MARGIN_LOWER_X64) >> 64
    tick_high = (logbp_x64 + _LOG_B_P_ERR_MARGIN_UPPER_X64) >> 64
    if tick_low == tick_high:
        return tick_low
    return tick_high if sqrt_price_from_tick_index(tick_high) <= sqrt_price_x64 else tick_low


def tick_array_start_index(tick: int, tick_spacing: int) -> int:
    span = tick_spacing * TICK_ARRAY_SIZE
    return (tick // span) * span


def tick_offset_in_array(tick: int, start: int, tick_spacing: int) -> int:
    off = (tick - start) // tick_spacing
    if not 0 <= off < TICK_ARRAY_SIZE or (tick - start) % tick_spacing:
        raise OrcaMathError("tick not in array or not aligned to tick spacing")
    return off


def is_valid_tick(tick: int, tick_spacing: int) -> bool:
    return MIN_TICK_INDEX <= tick <= MAX_TICK_INDEX and tick % tick_spacing == 0


# ---------------------------------------------------------------------------
# Token math
# ---------------------------------------------------------------------------


def get_amount_delta_a(sqrt_price_0: int, sqrt_price_1: int, liquidity: int,
                       round_up: bool) -> int:
    lo, hi = sorted((sqrt_price_0, sqrt_price_1))
    diff = hi - lo
    num = (liquidity * diff) << 64
    if num >= U256:
        raise OrcaMathError("MultiplicationOverflow")
    den = hi * lo
    q, rem = divmod(num, den)
    if round_up and rem:
        q += 1
    if q > U64_MAX:
        raise OrcaMathError("TokenMaxExceeded")
    return q


def get_amount_delta_b(sqrt_price_0: int, sqrt_price_1: int, liquidity: int,
                       round_up: bool) -> int:
    lo, hi = sorted((sqrt_price_0, sqrt_price_1))
    n1 = hi - lo
    if liquidity == 0 or n1 == 0:
        return 0
    p = liquidity * n1
    if p > U128_MAX:
        raise OrcaMathError("MultiplicationShiftRightOverflow")
    result = p >> 64
    should_round = round_up and (p & Q64_MASK) > 0
    if should_round and result == U64_MAX:
        raise OrcaMathError("MultiplicationOverflow")
    if result > U64_MAX:
        raise OrcaMathError("TokenMaxExceeded")
    return result + 1 if should_round else result


def liquidity_token_deltas(tick_current_index: int, sqrt_price: int, tick_lower: int,
                           tick_upper: int, liquidity_delta: int) -> tuple[int, int]:
    """Token A/B amounts for a liquidity change (Orca calculate_liquidity_token_deltas).

    Positive delta (increase) rounds up, negative (decrease) rounds down.
    """
    if liquidity_delta == 0:
        raise OrcaMathError("LiquidityZero")
    liq = abs(liquidity_delta)
    if liq > (1 << 127) - 1:
        raise OrcaMathError("LiquidityTooHigh")
    round_up = liquidity_delta > 0
    lower = sqrt_price_from_tick_index(tick_lower)
    upper = sqrt_price_from_tick_index(tick_upper)
    a = b = 0
    if tick_current_index < tick_lower:
        a = get_amount_delta_a(lower, upper, liq, round_up)
    elif tick_current_index < tick_upper:
        a = get_amount_delta_a(sqrt_price, upper, liq, round_up)
        b = get_amount_delta_b(lower, sqrt_price, liq, round_up)
    else:
        b = get_amount_delta_b(lower, upper, liq, round_up)
    return a, b


# ---------------------------------------------------------------------------
# Fee and reward growth
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TickGrowth:
    initialized: bool
    fee_growth_outside_a: int = 0
    fee_growth_outside_b: int = 0
    reward_growths_outside: tuple[int, int, int] = (0, 0, 0)


def _inside(current: int, lower_idx: int, upper_idx: int, lower_init: bool, upper_init: bool,
            global_g: int, lower_out: int, upper_out: int) -> int:
    if not lower_init:
        below = global_g
    elif current < lower_idx:
        below = (global_g - lower_out) % U128
    else:
        below = lower_out
    if not upper_init:
        above = 0
    elif current < upper_idx:
        above = upper_out
    else:
        above = (global_g - upper_out) % U128
    return (global_g - below - above) % U128


def fee_growths_inside(tick_current_index: int, lower: TickGrowth, lower_idx: int,
                       upper: TickGrowth, upper_idx: int, fee_growth_global_a: int,
                       fee_growth_global_b: int) -> tuple[int, int]:
    """Orca next_fee_growths_inside: wrapping Q64.64 fee growth inside [lower, upper)."""
    ga = _inside(tick_current_index, lower_idx, upper_idx, lower.initialized, upper.initialized,
                 fee_growth_global_a, lower.fee_growth_outside_a, upper.fee_growth_outside_a)
    gb = _inside(tick_current_index, lower_idx, upper_idx, lower.initialized, upper.initialized,
                 fee_growth_global_b, lower.fee_growth_outside_b, upper.fee_growth_outside_b)
    return ga, gb


def reward_growths_inside(tick_current_index: int, lower: TickGrowth, lower_idx: int,
                          upper: TickGrowth, upper_idx: int,
                          reward_growths_global: tuple[int, ...],
                          reward_initialized: tuple[bool, ...]) -> tuple[int, ...]:
    out = []
    for i in range(NUM_REWARDS):
        if not reward_initialized[i]:
            out.append(0)
            continue
        out.append(_inside(tick_current_index, lower_idx, upper_idx, lower.initialized,
                           upper.initialized, reward_growths_global[i],
                           lower.reward_growths_outside[i], upper.reward_growths_outside[i]))
    return tuple(out)


def fees_owed_delta(growth_inside: int, checkpoint: int, liquidity: int) -> int:
    """(L * (growth_inside - checkpoint)) >> 64 as on a liquidity change (Full mode)."""
    delta = (growth_inside - checkpoint) % U128
    p = liquidity * delta
    if p > U128_MAX:
        return 0  # Orca's checked_mul_shift_right failure path yields 0 owed
    return p >> 64


def swap_fee_growth_increment(fee_amount: int, protocol_fee_rate: int, liquidity: int) -> int:
    """Fee growth added to the global accumulator for one swap step."""
    protocol = fee_amount * protocol_fee_rate // PROTOCOL_FEE_RATE_MUL_VALUE
    if liquidity == 0:
        return 0
    return ((fee_amount - protocol) << 64) // liquidity


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------


def sqrt_price_to_price(sqrt_price_x64: int, decimals_a: int, decimals_b: int) -> float:
    """Human price (token B per token A) from a Q64.64 sqrt price, for display only."""
    return (sqrt_price_x64 / Q64) ** 2 * 10 ** (decimals_a - decimals_b)


def price_x64_from_sqrt(sqrt_price_x64: int) -> int:
    """Token B atoms per token A atom in Q64.64, rounded down."""
    return (sqrt_price_x64 * sqrt_price_x64) >> 64
