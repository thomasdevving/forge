"""Download and verify historical prices (SOL/USDC, JUP/USDC, ...) from Binance Public Data.

Source: https://data.binance.vision/ (documented at
https://github.com/binance/binance-public-data). Every archive is verified against the
published SHA-256 checksum. Timestamps are normalized to milliseconds (Binance spot files
switched to microseconds in 2025). Gaps are detected and recorded, never interpolated.

Usage:
    uv run python benchmarks/fetch_history.py                     # default window
    uv run python benchmarks/fetch_history.py --agg-trades        # also trade-level data
    uv run python benchmarks/fetch_history.py --symbol SOLUSDT    # labelled price proxy
    uv run python benchmarks/fetch_history.py --symbol JUPUSDC    # JUP/USDC market

Writes benchmarks/data/<symbol>-<interval>.npz and a per-symbol manifest: benchmarks/data/manifest.json
for SOLUSDC (kept for existing readers), benchmarks/data/manifest-<SYMBOL>.json for every other symbol.
Raw zips are cached in benchmarks/data/raw/ (gitignored).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from markets import manifest_path  # noqa: E402

BASE = "https://data.binance.vision/data/spot/monthly"
HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RAW = DATA / "raw"
DEFAULT_MONTHS = [f"2026-{m:02d}" for m in range(1, 11)]  # Jan..Oct 2026, completed months
INTERVAL_MS = {"1m": 60_000}
PROXY_SYMBOLS = {"SOLUSDT": "SOL/USDT used as an explicitly labelled price proxy for SOL/USDC"}


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "forge-benchmarks/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def fetch_verified(url: str) -> tuple[bytes, str]:
    """Download (or reuse cached) archive and verify it against the published checksum."""
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / url.rsplit("/", 1)[1]
    expected = _get(url + ".CHECKSUM").decode().split()[0].lower()
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        return path.read_bytes(), expected
    body = _get(url)
    got = hashlib.sha256(body).hexdigest()
    if got != expected:
        raise RuntimeError(f"checksum mismatch for {url}: expected {expected}, got {got}")
    path.write_bytes(body)
    return body, expected


def to_ms(ts: int) -> int:
    """Normalize Binance timestamps (ms before 2025, us after) to milliseconds."""
    if ts >= 10**15:  # microseconds
        return ts // 1000
    return ts


def read_klines(body: bytes) -> np.ndarray:
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        name = z.namelist()[0]
        text = z.read(name).decode()
    rows = []
    for rec in csv.reader(io.StringIO(text)):
        if not rec or not rec[0].isdigit():  # some files carry a header row
            continue
        rows.append((to_ms(int(rec[0])), float(rec[1]), float(rec[2]), float(rec[3]),
                     float(rec[4]), float(rec[5])))
    return np.array(rows, dtype=np.float64)


def find_gaps(open_ms: np.ndarray, step_ms: int, start_ms: int, end_ms: int) -> list[dict]:
    gaps = []
    expected_next = start_ms
    for t in open_ms.astype(np.int64):
        if t > expected_next:
            gaps.append({"from_ms": int(expected_next), "to_ms": int(t - step_ms),
                         "missing_bars": int((t - expected_next) // step_ms)})
        expected_next = max(expected_next, int(t) + step_ms)
    if expected_next < end_ms:
        gaps.append({"from_ms": int(expected_next), "to_ms": int(end_ms - step_ms),
                     "missing_bars": int((end_ms - expected_next) // step_ms)})
    return gaps


def month_bounds_ms(month: str) -> tuple[int, int]:
    y, m = map(int, month.split("-"))
    start = datetime(y, m, 1, tzinfo=UTC)
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=UTC)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--symbol", default="SOLUSDC")
    ap.add_argument("--interval", default="1m", choices=sorted(INTERVAL_MS))
    ap.add_argument("--months", nargs="*", default=DEFAULT_MONTHS)
    ap.add_argument("--agg-trades", action="store_true", help="also fetch aggregate trades")
    args = ap.parse_args(argv)

    step = INTERVAL_MS[args.interval]
    DATA.mkdir(parents=True, exist_ok=True)
    manifest = {
        "source": "Binance Public Data (https://data.binance.vision/)",
        "symbol": args.symbol,
        "label": PROXY_SYMBOLS.get(args.symbol, f"{args.symbol} spot"),
        "interval": args.interval,
        "timestamp_unit": "ms (normalized)",
        "interpolation": "none; gaps are recorded below",
        "generated_at_utc": datetime.now(UTC).isoformat(timespec="seconds"),
        "archives": [],
        "missing_intervals": [],
    }
    frames = []
    for month in args.months:
        sym, iv = args.symbol, args.interval
        url = f"{BASE}/klines/{sym}/{iv}/{sym}-{iv}-{month}.zip"
        try:
            body, sha = fetch_verified(url)
        except urllib.error.HTTPError as e:
            print(f"missing archive {url}: HTTP {e.code}", file=sys.stderr)
            manifest["missing_intervals"].append({"month": month, "reason": f"HTTP {e.code}"})
            continue
        k = read_klines(body)
        lo, hi = month_bounds_ms(month)
        gaps = find_gaps(k[:, 0], step, lo, hi)
        manifest["archives"].append({
            "url": url, "sha256": sha, "rows": int(len(k)),
            "first_open_ms": int(k[0, 0]), "last_open_ms": int(k[-1, 0]),
        })
        manifest["missing_intervals"].extend({"month": month, **g} for g in gaps)
        frames.append(k)
        print(f"{month}: {len(k)} bars, {sum(g['missing_bars'] for g in gaps)} missing")

        if args.agg_trades:
            turl = f"{BASE}/aggTrades/{args.symbol}/{args.symbol}-aggTrades-{month}.zip"
            try:
                _, tsha = fetch_verified(turl)
                manifest["archives"].append({"url": turl, "sha256": tsha, "kind": "aggTrades"})
            except urllib.error.HTTPError as e:
                manifest["missing_intervals"].append(
                    {"month": month, "kind": "aggTrades", "reason": f"HTTP {e.code}"})

    if not frames:
        print("no data downloaded", file=sys.stderr)
        return 1
    k = np.concatenate(frames)
    order = np.argsort(k[:, 0], kind="stable")
    k = k[order]
    out = DATA / f"{args.symbol}-{args.interval}.npz"
    np.savez_compressed(out, open_ms=k[:, 0].astype(np.int64), open=k[:, 1], high=k[:, 2],
                        low=k[:, 3], close=k[:, 4], volume=k[:, 5])
    manifest["output"] = {"path": str(out.relative_to(HERE)),
                          "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
                          "rows": int(len(k))}
    mpath = manifest_path(args.symbol)
    mpath.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {out} ({len(k)} rows) and {mpath.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
