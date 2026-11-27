"""Turn chosen candidate weights into an executable Construction (shared by both compilers)."""

from __future__ import annotations

import math

import numpy as np

from forge_compiler.basis import Candidate
from forge_compiler.model import Construction, Leg, MarketGrid


def build_construction(grid: MarketGrid, cash: float, base: float,
                       chosen: list[tuple[Candidate, float]]) -> Construction:
    """`chosen` holds (candidate, human liquidity). Liquidity is rounded down to on-chain units."""
    legs = []
    esc_q = esc_b = buf_q = buf_b = prov_q = prov_b = 0.0
    buf = grid.restoration_buffer_bps / 10_000
    for cand, liq in chosen:
        onchain = math.floor(liq / grid.liquidity_scale)
        if onchain <= 0:
            continue
        liq_h = onchain * grid.liquidity_scale
        b = cand.bucket
        legs.append(Leg(cand.kind, b.tick_lower, b.tick_upper, b.price_lower, b.price_upper, liq_h, onchain))
        if cand.kind == "borrow_put":
            esc_q += liq_h * cand.y_full
            buf_q += liq_h * cand.y_full * buf
        elif cand.kind == "borrow_call":
            esc_b += liq_h * cand.x_full
            buf_b += liq_h * cand.x_full * buf
        elif cand.kind == "provide_put":
            prov_q += liq_h * cand.y_full
        else:
            prov_b += liq_h * cand.x_full
    return Construction(cash=cash, base=base, legs=tuple(legs), spot=grid.spot, escrow_quote=esc_q,
                        escrow_base=esc_b, buffer_quote=buf_q, buffer_base=buf_b,
                        provided_quote=prov_q, provided_base=prov_b)


def construction_payoff(c: Construction, s: np.ndarray, by_kind: dict) -> np.ndarray:
    """Gross payoff of a construction (compiler-side evaluation; the verifier has its own)."""
    out = c.cash + c.base * np.asarray(s, dtype=float)
    for leg in c.legs:
        cand = by_kind[(leg.tick_lower, leg.kind)]
        out = out + leg.liquidity * cand.payoff_per_liquidity(np.asarray(s, dtype=float))
    return out
