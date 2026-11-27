# ruff: noqa: E501  (wide result tables and formulas read better unwrapped)
"""Fetch the price data for the November 2026 recent-regime study (real data only).

* Binance Public Data 1-minute spot klines for SOLUSDC, JUPUSDC, BONKUSDC, KMNOUSDC:
  monthly archives for 2026-09 and 2026-10, daily archives for 2026-11-01 .. the latest published day.
  Every archive is verified against Binance's published SHA-256 checksum; timestamps are normalized to
  ms; gaps are recorded, never interpolated. (JLP is not listed on Binance and is skipped.)
* Deribit public API (no key): every SOL_USDC option trade (with its implied vol) over the study period
  from history.deribit.com, and a snapshot of today's SOL_USDC option book (mark IV per instrument).

Writes data/<SYMBOL>-1m.npz, data/deribit_sol_trades.json, data/deribit_sol_book.json and
data/manifest.json next to this script. Raw zips are cached in data/raw/.

Usage: uv run --project compiler python benchmarks/research/2026-11-recent/fetch_recent.py
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
RAW = DATA / "raw"
SYMBOLS = ("SOLUSDC", "JUPUSDC", "BONKUSDC", "KMNOUSDC")
MONTHS = ("2026-09", "2026-10")
NOV_FIRST = date(2026, 11, 1)
BASE = "https://data.binance.vision/data/spot"
DERIBIT_HIST = "https://history.deribit.com/api/v2/public/get_last_trades_by_currency_and_time"
DERIBIT_BOOK = "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=USDC&kind=option"
UA = {"User-Agent": "forge-research/0.1"}


def _get(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def fetch_verified(url: str) -> tuple[bytes, str]:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / url.rsplit("/", 1)[1]
    expected = _get(url + ".CHECKSUM").decode().split()[0].lower()
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        return path.read_bytes(), expected
    body = _get(url)
    got = hashlib.sha256(body).hexdigest()
    if got != expected:
        raise RuntimeError(f"checksum mismatch for {url}")
    path.write_bytes(body)
    return body, expected


def read_klines(body: bytes) -> np.ndarray:
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        text = z.read(z.namelist()[0]).decode()
    rows = []
    for rec in csv.reader(io.StringIO(text)):
        if not rec or not rec[0].isdigit():
            continue
        t = int(rec[0])
        t = t // 1000 if t >= 10**15 else t
        rows.append((t, float(rec[1]), float(rec[2]), float(rec[3]), float(rec[4]), float(rec[5])))
    return np.array(rows, dtype=np.float64)


def latest_day(symbol: str) -> date:
    d = datetime.now(UTC).date()
    for _ in range(10):
        url = f"{BASE}/daily/klines/{symbol}/1m/{symbol}-1m-{d:%Y-%m-%d}.zip.CHECKSUM"
        try:
            _get(url, 30)
            return d
        except urllib.error.HTTPError:
            d -= timedelta(days=1)
    raise RuntimeError(f"no recent daily archive for {symbol}")


def fetch_symbol(symbol: str, last: date) -> dict:
    urls = [f"{BASE}/monthly/klines/{symbol}/1m/{symbol}-1m-{m}.zip" for m in MONTHS]
    d = NOV_FIRST
    while d <= last:
        urls.append(f"{BASE}/daily/klines/{symbol}/1m/{symbol}-1m-{d:%Y-%m-%d}.zip")
        d += timedelta(days=1)
    frames, archives, missing = [], [], []
    for url in urls:
        try:
            body, sha = fetch_verified(url)
        except urllib.error.HTTPError as e:
            missing.append({"url": url, "reason": f"HTTP {e.code}"})
            continue
        k = read_klines(body)
        frames.append(k)
        archives.append({"url": url, "sha256": sha, "rows": int(len(k))})
    k = np.concatenate(frames)
    k = k[np.argsort(k[:, 0], kind="stable")]
    t = k[:, 0].astype(np.int64)
    gaps = np.where(np.diff(t) != 60_000)[0]
    gap_list = [{"after_ms": int(t[i]), "next_ms": int(t[i + 1]), "missing_bars": int((t[i + 1] - t[i]) // 60_000 - 1)}
                for i in gaps]
    out = DATA / f"{symbol}-1m.npz"
    np.savez_compressed(out, open_ms=t, open=k[:, 1], high=k[:, 2], low=k[:, 3], close=k[:, 4], volume=k[:, 5])
    print(f"{symbol}: {len(k)} bars {datetime.fromtimestamp(t[0] / 1000, UTC):%Y-%m-%d} .. "
          f"{datetime.fromtimestamp(t[-1] / 1000, UTC):%Y-%m-%d %H:%M}, {len(gap_list)} gaps, {len(missing)} missing")
    return {"symbol": symbol, "archives": archives, "missing_archives": missing, "gaps": gap_list,
            "output": {"path": out.name, "rows": int(len(k)), "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
                       "first_open_ms": int(t[0]), "last_open_ms": int(t[-1])}}


def fetch_deribit(start_ms: int, end_ms: int) -> dict:
    """All USDC-settled option trades in [start, end], kept only for SOL_USDC instruments."""
    sol, total, pages, s = [], 0, 0, start_ms
    while s < end_ms:
        url = (f"{DERIBIT_HIST}?currency=USDC&kind=option&start_timestamp={s}&end_timestamp={end_ms}"
               "&count=1000&sorting=asc")
        for attempt in range(5):
            try:
                r = json.loads(_get(url, 60))["result"]
                break
            except Exception:  # noqa: BLE001 - transient network errors are retried
                time.sleep(2 * (attempt + 1))
        else:
            raise RuntimeError(f"deribit history failed at {s}")
        tr = r["trades"]
        pages += 1
        total += len(tr)
        sol += [{k: x.get(k) for k in ("timestamp", "instrument_name", "iv", "price", "mark_price", "index_price",
                                       "amount", "direction")}
                for x in tr if x["instrument_name"].startswith("SOL_")]
        if not tr or not r.get("has_more"):
            break
        nxt = tr[-1]["timestamp"]
        s = nxt + 1 if nxt >= s else s + 1
        if pages % 50 == 0:
            print(f"  deribit: {pages} pages, {total} trades, {len(sol)} SOL, at "
                  f"{datetime.fromtimestamp(nxt / 1000, UTC):%Y-%m-%d}", flush=True)
    print(f"deribit: {total} USDC option trades, {len(sol)} SOL_USDC, {pages} pages")
    return {"source": DERIBIT_HIST, "start_ms": start_ms, "end_ms": end_ms, "usdc_option_trades": total,
            "sol_trades": sol}


def main() -> int:
    DATA.mkdir(parents=True, exist_ok=True)
    manifest = {"generated_at_utc": datetime.now(UTC).isoformat(timespec="seconds"),
                "source": "Binance Public Data (https://data.binance.vision/), Deribit public API", "symbols": {},
                "skipped": {"JLP": "not listed on Binance"}}
    last = min(latest_day(s) for s in SYMBOLS)
    manifest["last_day"] = f"{last:%Y-%m-%d}"
    for s in SYMBOLS:
        manifest["symbols"][s] = fetch_symbol(s, last)
    start = int(datetime(2026, 9, 1, tzinfo=UTC).timestamp() * 1000)
    end = int(datetime.combine(last + timedelta(days=1), datetime.min.time(), UTC).timestamp() * 1000)
    trades = fetch_deribit(start, end)
    (DATA / "deribit_sol_trades.json").write_text(json.dumps(trades) + "\n")
    book = json.loads(_get(DERIBIT_BOOK, 60))["result"]
    snap = {"fetched_at_utc": datetime.now(UTC).isoformat(timespec="seconds"), "source": DERIBIT_BOOK,
            "instruments": [{k: b.get(k) for k in ("instrument_name", "mark_iv", "mark_price", "bid_price", "ask_price",
                                                   "underlying_price", "open_interest", "volume")}
                            for b in book if b["instrument_name"].startswith("SOL_")]}
    (DATA / "deribit_sol_book.json").write_text(json.dumps(snap, indent=1) + "\n")
    manifest["deribit"] = {"trades_file": "deribit_sol_trades.json", "usdc_option_trades_scanned":
                           trades["usdc_option_trades"], "sol_trades": len(trades["sol_trades"]),
                           "book_file": "deribit_sol_book.json", "book_instruments": len(snap["instruments"])}
    (DATA / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"last day {last}; wrote {DATA}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
