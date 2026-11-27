"""FORGE compiler API: wraps the compiler and the independent verifier (section 9).

Endpoints
  GET  /health                      liveness + solver check
  POST /compile                     payoff + market grid + limits -> construction + certificate
  POST /feasibility                 fast, coarse compile for live feedback while drawing
  POST /evaluate                    construction/target values of a certificate at prices
  POST /verify                      recompute a certificate's hash and exact bound
  POST /certificates                store a certificate (content-addressed by its hash)
  GET  /certificates/{hash}         fetch a stored certificate
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from forge_compiler.cli import compile_request, evaluate
from forge_verifier.certificate import certificate_hash, verify_certificate

STORE = Path(os.environ.get("FORGE_CERT_STORE", "/tmp/forge-certificates"))
STORE.mkdir(parents=True, exist_ok=True)
ORIGINS = [o for o in os.environ.get("FORGE_ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o]

app = FastAPI(title="FORGE compiler API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])


class Limits(BaseModel):
    base_holdings: float = Field(ge=0)
    quote_holdings: float = Field(ge=0)
    premium_budget: float = Field(ge=0)
    max_legs: int = Field(default=8, ge=1, le=8)


class Market(BaseModel):
    whirlpool: str = ""
    base_decimals: int = 9
    quote_decimals: int = 6


class CompileRequest(BaseModel):
    payoff: list[tuple[float, float]] = Field(min_length=2, max_length=64)
    spot: float = Field(gt=0)
    tick_spacing: int = Field(gt=0)
    bucket_multiplier: int = Field(ge=1)
    n_each_side: int = Field(default=10, ge=1, le=40)
    borrowable: dict[str, int] = {}
    limits: Limits
    method: Literal["optimizer", "baseline"] = "optimizer"
    tolerance: float | None = None
    market: Market = Market()


class EvaluateRequest(BaseModel):
    certificate: dict
    prices: list[float] = Field(min_length=1, max_length=2000)


@app.get("/health")
def health() -> dict:
    t0 = time.perf_counter()
    r = compile_request({
        "payoff": [[40.0, 650.0], [65.0, 650.0], [120.0, 1200.0]], "spot": 72.6, "tick_spacing": 64,
        "bucket_multiplier": 4, "n_each_side": 6, "borrowable": {}, "market": {},
        "limits": {"base_holdings": 10, "quote_holdings": 1000, "premium_budget": 10, "max_legs": 4},
    })
    return {"ok": r["result"]["construction"] is not None, "solver_ms": round((time.perf_counter() - t0) * 1e3, 1)}


@app.post("/compile")
def compile_payoff(req: CompileRequest) -> dict:
    try:
        return compile_request(req.model_dump())
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@app.post("/feasibility")
def feasibility(req: CompileRequest) -> dict:
    """Coarse grid + short time limit: quick enough to run while the user drags a breakpoint."""
    try:
        out = compile_request({**req.model_dump(), "n_each_side": min(req.n_each_side, 10)})
    except ValueError as e:
        return {"status": "invalid", "reasons": [str(e)]}
    r = out["result"]
    return {
        "status": r["status"],
        "reasons": r["reasons"],
        "sampled_max_error": r["sampled_max_error"],
        "tolerance": out["tolerance"],
        "legs": len(r["construction"]["legs"]) if r["construction"] else 0,
        "closest_feasible": r["closest_feasible"],
    }


@app.post("/evaluate")
def evaluate_certificate(req: EvaluateRequest) -> dict:
    return evaluate(req.certificate, req.prices)


@app.post("/verify")
def verify(cert: dict) -> dict:
    return {"valid": verify_certificate(cert), "hash": certificate_hash(cert)}


@app.post("/certificates")
def store_certificate(cert: dict) -> dict:
    if not verify_certificate(cert):
        raise HTTPException(422, "certificate does not verify")
    h = cert["hash"]
    (STORE / f"{h}.json").write_text(json.dumps(cert))
    return {"hash": h}


@app.get("/certificates/{h}")
def get_certificate(h: str) -> dict:
    if not (len(h) == 64 and all(c in "0123456789abcdef" for c in h)):
        raise HTTPException(400, "bad hash")
    p = STORE / f"{h}.json"
    if not p.exists():
        raise HTTPException(404, "unknown certificate")
    return json.loads(p.read_text())
