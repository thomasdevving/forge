"""Replication certificate (section 7): JSON document plus a SHA-256 hash stored on-chain."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from forge_verifier.exact import VConstruction, VLeg, max_error, tick_to_price

DISCLAIMER = (
    "The certified bound covers gross replication error of the construction against the target "
    "over the stated price domain only. Premiums, pool fees, restoration swap costs and price "
    "impact at settlement are excluded from the bound and reported separately."
)


def construction_from_dict(d: dict, base_decimals: int, quote_decimals: int) -> VConstruction:
    return VConstruction(
        cash=float(d["cash"]),
        base=float(d["base"]),
        legs=tuple(VLeg(leg["kind"], int(leg["tick_lower"]), int(leg["tick_upper"]), int(leg["liquidity_onchain"]))
                   for leg in d["legs"]),
        base_decimals=base_decimals,
        quote_decimals=quote_decimals,
    )


def canonical_json(doc: dict) -> bytes:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def certificate_hash(doc: dict) -> str:
    body = {k: v for k, v in doc.items() if k != "hash"}
    return hashlib.sha256(canonical_json(body)).hexdigest()


def build_certificate(
    *,
    market: dict[str, Any],
    target: list[tuple[float, float]],
    construction: dict,
    premium_budget: float,
    liquidity_check: list[dict],
    simulation: dict | None = None,
) -> dict:
    bd, qd = int(market["base_decimals"]), int(market["quote_decimals"])
    vc = construction_from_dict(construction, bd, qd)
    eb = max_error([(float(x), float(y)) for x, y in target], vc)
    legs = []
    for leg in vc.legs:
        legs.append({
            "kind": leg.kind,
            "side": "borrowed" if leg.kind.startswith("borrow") else "provided",
            "tick_lower": leg.tick_lower,
            "tick_upper": leg.tick_upper,
            "price_lower": tick_to_price(leg.tick_lower, bd, qd),
            "price_upper": tick_to_price(leg.tick_upper, bd, qd),
            "liquidity_onchain": leg.liquidity_onchain,
        })
    doc = {
        "version": 1,
        "market": market,
        "target": {"breakpoints": [[float(x), float(y)] for x, y in target],
                   "domain": [float(target[0][0]), float(target[-1][0])]},
        "construction": {"cash": vc.cash, "base": vc.base, "legs": legs},
        "error": {
            "max_gross_error": eb.max_error,
            "at_price": eb.at_price,
            "target_at": eb.target_at,
            "construction_at": eb.construction_at,
            "rounding_bound": eb.rounding_bound,
            "certified_bound": eb.certified_bound,
            "method": "exact: piecewise a + bS + c*sqrt(S) extrema",
        },
        "collateral": {
            "escrow_quote": float(construction.get("escrow_quote", 0.0)),
            "escrow_base": float(construction.get("escrow_base", 0.0)),
            "buffer_quote": float(construction.get("buffer_quote", 0.0)),
            "buffer_base": float(construction.get("buffer_base", 0.0)),
            "provided_quote": float(construction.get("provided_quote", 0.0)),
            "provided_base": float(construction.get("provided_base", 0.0)),
            "capital_locked": float(construction.get("capital_locked", 0.0)),
        },
        "premium_budget": float(premium_budget),
        "liquidity_check": liquidity_check,
        "simulation": simulation,
        "disclaimer": DISCLAIMER,
    }
    for v in (eb.max_error, eb.certified_bound):
        if not math.isfinite(v):
            raise ValueError("non-finite error bound")
    doc["hash"] = certificate_hash(doc)
    return doc


def verify_certificate(doc: dict) -> bool:
    """Recompute the hash and the exact bound from the document alone."""
    if certificate_hash(doc) != doc.get("hash"):
        return False
    m = doc["market"]
    vc = construction_from_dict({"cash": doc["construction"]["cash"], "base": doc["construction"]["base"],
                                 "legs": doc["construction"]["legs"]}, m["base_decimals"], m["quote_decimals"])
    eb = max_error([tuple(p) for p in doc["target"]["breakpoints"]], vc)
    return math.isclose(eb.certified_bound, doc["error"]["certified_bound"], rel_tol=1e-9, abs_tol=1e-12)
