"""Decoders for Orca Whirlpool accounts (layouts in docs/orca-integration.md)."""

from __future__ import annotations

import base64
import struct
from dataclasses import dataclass

from forge_math.orca import TICK_ARRAY_SIZE, TickGrowth

WHIRLPOOL_DISC = bytes([63, 149, 209, 12, 225, 128, 99, 9])
POSITION_DISC = bytes([170, 188, 143, 228, 122, 64, 247, 208])
FIXED_TICK_ARRAY_DISC = bytes([69, 97, 189, 190, 110, 7, 66, 187])
DYNAMIC_TICK_ARRAY_DISC = bytes([17, 216, 246, 142, 225, 199, 218, 56])
TICK_LEN = 113

_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _ALPHABET[r] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def _u128(b: bytes, o: int) -> int:
    return int.from_bytes(b[o:o + 16], "little")


def _i128(b: bytes, o: int) -> int:
    return int.from_bytes(b[o:o + 16], "little", signed=True)


def _data(raw: bytes | str) -> bytes:
    return base64.b64decode(raw) if isinstance(raw, str) else raw


@dataclass(frozen=True)
class RewardInfo:
    mint: str
    vault: str
    emissions_per_second_x64: int
    growth_global_x64: int

    @property
    def initialized(self) -> bool:
        return self.mint != "11111111111111111111111111111111"


@dataclass(frozen=True)
class Whirlpool:
    whirlpools_config: str
    tick_spacing: int
    fee_tier_index: int
    fee_rate: int
    protocol_fee_rate: int
    liquidity: int
    sqrt_price: int
    tick_current_index: int
    token_mint_a: str
    token_vault_a: str
    fee_growth_global_a: int
    token_mint_b: str
    token_vault_b: str
    fee_growth_global_b: int
    reward_last_updated_timestamp: int
    reward_infos: tuple[RewardInfo, ...]
    control_flags: int


def decode_whirlpool(raw: bytes | str) -> Whirlpool:
    b = _data(raw)
    if b[:8] != WHIRLPOOL_DISC or len(b) < 653:
        raise ValueError("not a Whirlpool account")
    rewards = []
    for i in range(3):
        o = 269 + 128 * i
        rewards.append(RewardInfo(b58(b[o:o + 32]), b58(b[o + 32:o + 64]), _u128(b, o + 96),
                                  _u128(b, o + 112)))
    flags = struct.unpack_from("<H", b, 269 + 128 + 64)[0]
    return Whirlpool(
        whirlpools_config=b58(b[8:40]),
        tick_spacing=struct.unpack_from("<H", b, 41)[0],
        fee_tier_index=struct.unpack_from("<H", b, 43)[0],
        fee_rate=struct.unpack_from("<H", b, 45)[0],
        protocol_fee_rate=struct.unpack_from("<H", b, 47)[0],
        liquidity=_u128(b, 49),
        sqrt_price=_u128(b, 65),
        tick_current_index=struct.unpack_from("<i", b, 81)[0],
        token_mint_a=b58(b[101:133]),
        token_vault_a=b58(b[133:165]),
        fee_growth_global_a=_u128(b, 165),
        token_mint_b=b58(b[181:213]),
        token_vault_b=b58(b[213:245]),
        fee_growth_global_b=_u128(b, 245),
        reward_last_updated_timestamp=struct.unpack_from("<Q", b, 261)[0],
        reward_infos=tuple(rewards),
        control_flags=flags,
    )


@dataclass(frozen=True)
class Position:
    whirlpool: str
    position_mint: str
    liquidity: int
    tick_lower_index: int
    tick_upper_index: int
    fee_growth_checkpoint_a: int
    fee_owed_a: int
    fee_growth_checkpoint_b: int
    fee_owed_b: int
    reward_growth_checkpoints: tuple[int, int, int]
    reward_amounts_owed: tuple[int, int, int]


def decode_position(raw: bytes | str) -> Position:
    b = _data(raw)
    if b[:8] != POSITION_DISC or len(b) < 216:
        raise ValueError("not a Position account")
    rg, ro = [], []
    for i in range(3):
        o = 144 + 24 * i
        rg.append(_u128(b, o))
        ro.append(struct.unpack_from("<Q", b, o + 16)[0])
    return Position(
        whirlpool=b58(b[8:40]), position_mint=b58(b[40:72]), liquidity=_u128(b, 72),
        tick_lower_index=struct.unpack_from("<i", b, 88)[0],
        tick_upper_index=struct.unpack_from("<i", b, 92)[0],
        fee_growth_checkpoint_a=_u128(b, 96), fee_owed_a=struct.unpack_from("<Q", b, 112)[0],
        fee_growth_checkpoint_b=_u128(b, 120), fee_owed_b=struct.unpack_from("<Q", b, 136)[0],
        reward_growth_checkpoints=tuple(rg), reward_amounts_owed=tuple(ro),  # type: ignore[arg-type]
    )


@dataclass(frozen=True)
class Tick:
    initialized: bool
    liquidity_net: int
    liquidity_gross: int
    fee_growth_outside_a: int
    fee_growth_outside_b: int
    reward_growths_outside: tuple[int, int, int]

    def growth(self) -> TickGrowth:
        return TickGrowth(self.initialized, self.fee_growth_outside_a, self.fee_growth_outside_b,
                          self.reward_growths_outside)


def _tick_body(b: bytes, o: int, initialized: bool) -> Tick:
    return Tick(initialized, _i128(b, o), _u128(b, o + 16), _u128(b, o + 32), _u128(b, o + 48),
                (_u128(b, o + 64), _u128(b, o + 80), _u128(b, o + 96)))


@dataclass(frozen=True)
class TickArray:
    start_tick_index: int
    whirlpool: str
    ticks: tuple[Tick, ...]
    dynamic: bool

    def tick(self, tick_index: int, tick_spacing: int) -> Tick:
        off = (tick_index - self.start_tick_index) // tick_spacing
        if not 0 <= off < TICK_ARRAY_SIZE or (tick_index - self.start_tick_index) % tick_spacing:
            raise ValueError("tick not in this array")
        return self.ticks[off]


def decode_tick_array(raw: bytes | str) -> TickArray:
    b = _data(raw)
    start = struct.unpack_from("<i", b, 8)[0]
    if b[:8] == FIXED_TICK_ARRAY_DISC:
        ticks = []
        for i in range(TICK_ARRAY_SIZE):
            o = 12 + TICK_LEN * i
            ticks.append(_tick_body(b, o + 1, bool(b[o])))
        return TickArray(start, b58(b[9956:9988]), tuple(ticks), dynamic=False)
    if b[:8] == DYNAMIC_TICK_ARRAY_DISC:
        o = 60
        ticks = []
        for _ in range(TICK_ARRAY_SIZE):
            tag = b[o]
            if tag == 0:
                ticks.append(Tick(False, 0, 0, 0, 0, (0, 0, 0)))
                o += 1
            elif tag == 1:
                ticks.append(_tick_body(b, o + 1, True))
                o += 1 + 112
            else:
                raise ValueError("corrupt dynamic tick array")
        return TickArray(start, b58(b[12:44]), tuple(ticks), dynamic=True)
    raise ValueError("not a TickArray account")
