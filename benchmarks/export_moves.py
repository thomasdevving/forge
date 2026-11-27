"""Export the historical distribution of SOL/USDC moves for the Studio chart.

For each horizon, every hourly start in the Binance 1-minute history is paired with the close one horizon
later; the ratio close[t+h] / close[t] is binned. The Studio scales the bins by the current pool price to
show where SOL has historically closed relative to today, behind the payoff. No smoothing, no fitting.

Usage: uv run --project compiler python benchmarks/export_moves.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "app" / "src" / "data" / "moves.json"
HORIZONS = {"1d": 1, "7d": 7, "30d": 30}
EDGES = np.linspace(0.50, 1.70, 97)  # covers the Studio's 0.55x-1.6x price domain


def main() -> None:
    data = np.load(ROOT / "data" / "SOLUSDC-1m.npz")
    t, close = data["open_ms"], data["close"]
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text())
    hourly = np.arange(0, len(t), 60)
    out: dict = {
        "source": manifest["source"],
        "symbol": manifest["symbol"],
        "from_ms": int(t[0]),
        "to_ms": int(t[-1]),
        "edges": [round(float(e), 4) for e in EDGES],
        "horizons": {},
    }
    for name, days in HORIZONS.items():
        target = t[hourly] + days * 86_400_000
        j = np.searchsorted(t, target)
        ok = (j < len(t)) & (t[np.minimum(j, len(t) - 1)] == target)  # exact minute exists; gaps are skipped
        ratio = close[j[ok]] / close[hourly[ok]]
        counts, _ = np.histogram(ratio, bins=EDGES)
        q = np.quantile(ratio, [0.05, 0.25, 0.5, 0.75, 0.95])
        out["horizons"][name] = {
            "samples": int(ok.sum()),
            "outside": int(((ratio < EDGES[0]) | (ratio >= EDGES[-1])).sum()),
            "counts": [int(c) for c in counts],
            "quantiles": {k: round(float(v), 5) for k, v in zip(["p5", "p25", "p50", "p75", "p95"], q, strict=True)},
        }
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    for name, h in out["horizons"].items():
        print(name, h["samples"], "samples", h["quantiles"])


if __name__ == "__main__":
    main()
