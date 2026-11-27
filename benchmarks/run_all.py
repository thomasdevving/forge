"""Run every benchmark with one command; results go to one versioned folder.

    uv run python benchmarks/run_all.py            # all offline benchmarks
    uv run python benchmarks/run_all.py --fork     # also Benchmark 2 (needs a bootstrapped fork)

Benchmark 1 (replication) and 3 (LP guarantee) are offline and deterministic. Benchmark 2
(theoretical vs realized) executes real positions on the Surfpool fork.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lp_guarantee import run_id  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fork", action="store_true", help="also run Benchmark 2 on the fork")
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    out = HERE / "results" / run_id()
    out.mkdir(parents=True, exist_ok=True)
    py = [sys.executable]
    steps = []
    if not (HERE / "data" / "SOLUSDC-1m.npz").exists():
        steps.append(py + [str(HERE / "fetch_history.py")])
    q = ["--quick"] if args.quick else []
    steps.append(py + [str(HERE / "replication.py"), "--out", str(out)] + q)
    steps.append(py + [str(HERE / "lp_guarantee.py"), "--out", str(out)] + q)
    if args.fork:
        steps.append(["pnpm", "--dir", str(HERE.parent / "tests"), "exec", "vitest", "run", "--dir", "bench",
                      "--", f"--out={out}"])
    failed = 0
    for cmd in steps:
        print(f"\n$ {' '.join(cmd)}", flush=True)
        failed |= subprocess.run(cmd, cwd=HERE.parent).returncode != 0
    print(f"\nresults: {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
