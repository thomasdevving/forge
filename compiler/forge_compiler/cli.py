"""JSON command-line entry point: compile a payoff and certify it.

    echo '{...}' | uv run python -m forge_compiler.cli

Input:
  {"payoff": [[S, f], ...], "spot": 72.6, "tick_spacing": 64, "bucket_multiplier": 4,
   "n_each_side": 12, "borrowable": {"-26368": 1000, ...},
   "limits": {"base_holdings": 10, "quote_holdings": 2000, "premium_budget": 20, "max_legs": 8},
   "method": "optimizer" | "baseline", "tolerance": null,
   "market": {"whirlpool": "...", "base_decimals": 9, "quote_decimals": 6}}

Output: {"result": CompileResult, "certificate": certificate or null}
"""

from __future__ import annotations

import json
import sys

from forge_compiler import presets
from forge_compiler.baseline import compile_baseline
from forge_compiler.model import Payoff, UserLimits, grid_for_market
from forge_compiler.optimizer import compile_optimizer
from forge_verifier.certificate import build_certificate, construction_from_dict
from forge_verifier.exact import construction_value


def _payoff(req: dict) -> Payoff:
    if "preset" in req:
        p = req["preset"]
        return getattr(presets, p["name"])(*p["args"])
    return Payoff(tuple((float(s), float(f)) for s, f in req["payoff"]))


def evaluate(cert: dict, prices: list[float]) -> dict:
    """Evaluate a certificate's construction and target at prices (verifier code only)."""
    m = cert["market"]
    vc = construction_from_dict(cert["construction"], m["base_decimals"], m["quote_decimals"])
    bps = [tuple(b) for b in cert["target"]["breakpoints"]]
    payoff = Payoff(tuple(bps))
    return {"fhat": [construction_value(vc, float(s)) for s in prices],
            "target": [float(payoff(float(s))) for s in prices]}


def compile_request(req: dict) -> dict:
    payoff = _payoff(req)
    m = req.get("market", {})
    bd, qd = int(m.get("base_decimals", 9)), int(m.get("quote_decimals", 6))
    borrowable = {int(k): int(v) for k, v in req.get("borrowable", {}).items()}
    grid = grid_for_market(float(req["spot"]), int(req["tick_spacing"]), int(req["bucket_multiplier"]),
                           int(req.get("n_each_side", 12)), borrowable=borrowable, base_decimals=bd,
                           quote_decimals=qd)
    lim = req["limits"]
    limits = UserLimits(float(lim["base_holdings"]), float(lim["quote_holdings"]), float(lim["premium_budget"]),
                        int(lim.get("max_legs", 8)))
    fn = compile_baseline if req.get("method") == "baseline" else compile_optimizer
    res = fn(payoff, grid, limits, tolerance=req.get("tolerance"))
    cert = None
    if res.construction is not None:
        liquidity_check = []
        for leg in res.construction.legs:
            if leg.kind.startswith("borrow"):
                avail = borrowable.get(leg.tick_lower, 0)
                liquidity_check.append({"tick_lower": leg.tick_lower, "requested": leg.liquidity_onchain,
                                        "borrowable": avail, "ok": leg.liquidity_onchain <= avail})
        cert = build_certificate(
            market={"whirlpool": m.get("whirlpool", ""), "base_decimals": bd, "quote_decimals": qd,
                    "spot": float(req["spot"])},
            target=list(payoff.breakpoints), construction=res.construction.to_dict(),
            premium_budget=limits.premium_budget, liquidity_check=liquidity_check,
            simulation=req.get("simulation"))
    tolerance = req.get("tolerance") or payoff.default_tolerance()
    return {"result": res.to_dict(), "certificate": cert, "tolerance": tolerance}


def main() -> int:
    req = json.load(sys.stdin)
    out = evaluate(req["evaluate"], req["prices"]) if "evaluate" in req else compile_request(req)
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
