"""Run every benchmark with one command; results go to one versioned folder.

    uv run python benchmarks/run_all.py            # all offline benchmarks
    uv run python benchmarks/run_all.py --fork     # also Benchmark 2 (needs a bootstrapped fork)
    uv run python benchmarks/run_all.py --market JUP/USDC   # another market from benchmarks/markets.py

Benchmark 1 (replication), 3 (LP guarantee) and 4 (LP profitability) are offline and deterministic. Benchmark 2
(theoretical vs realized) executes real positions on the Surfpool fork.

Results go to benchmarks/results/<run_id> for SOL/USDC and benchmarks/results/<run_id>-<base> for
other markets (e.g. -jup). Subprocesses get FORGE_BENCH_OUT (the folder) and FORGE_MARKET (the
market name, read by the fork benchmark).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import markets  # noqa: E402
from lp_guarantee import run_id  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fork", action="store_true", help="also run Benchmark 2 on the fork")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--market", default=markets.DEFAULT, choices=sorted(markets.MARKETS))
    args = ap.parse_args()
    mk = markets.get(args.market)
    out = HERE / "results" / markets.results_name(run_id(), mk)
    out.mkdir(parents=True, exist_ok=True)
    py = [sys.executable]
    steps = []
    if not mk.history_path().exists():
        steps.append(py + [str(HERE / "fetch_history.py"), "--symbol", mk.symbol])
    q = ["--quick"] if args.quick else []
    m = ["--market", mk.name]
    steps.append(py + [str(HERE / "replication.py"), "--out", str(out)] + q + m)
    steps.append(py + [str(HERE / "lp_guarantee.py"), "--out", str(out)] + q + m)
    steps.append(py + [str(HERE / "lp_profitability.py"), "--out", str(out)] + q + m)
    if args.fork:
        steps.append(["pnpm", "--dir", str(HERE.parent / "tests"), "exec", "vitest", "run", "--dir", "bench"])
    failed = 0
    env = {**os.environ, "FORGE_BENCH_OUT": str(out), "FORGE_MARKET": mk.name}
    for cmd in steps:
        print(f"\n$ {' '.join(cmd)}", flush=True)
        failed |= subprocess.run(cmd, cwd=HERE.parent, env=env).returncode != 0
    print(f"\nresults: {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
