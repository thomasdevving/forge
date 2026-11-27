"""Markets the offline benchmarks can run on, and the per-market numbers derived from them.

Every benchmark takes ``--market`` (default "SOL/USDC", whose numbers are pinned so earlier results
reproduce exactly). Other markets are scaled to the same USD sizes:

* spot: the last 1-minute close in the market's Binance history (SOL/USDC keeps its pinned 73.23).
* payoff units and base holdings: the same USD notional as SOL's (10 SOL x 73.23 ~ $732).
* thin/deep liquidity: the same USD of quote per bucket, measured on the bucket just below price
  with the Whirlpool formula quote = L * (sqrt(p_b) - sqrt(p_a)) / 10^quote_decimals on raw prices
  p_raw = p * 10^(quote_decimals - base_decimals), then converted back to raw L for each market.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"


@dataclass(frozen=True)
class Market:
    name: str                      # "SOL/USDC"
    symbol: str                    # Binance spot symbol used for price history
    base_decimals: int
    quote_decimals: int
    fee_rate: float                # target Orca pool fee (Orca API feeRate / 1e6)
    label: str                     # written into certificates as market.whirlpool
    whirlpool: str                 # target pool address on mainnet
    tick_spacing: int = 64
    bucket_multiplier: int = 4
    pinned_spot: float | None = None  # overrides the history-derived spot (SOL: published runs)
    gbm_start: float | None = None    # synthetic path start; None = spot

    @property
    def base(self) -> str:
        return self.name.split("/")[0]

    @property
    def bucket_ticks(self) -> int:
        return self.tick_spacing * self.bucket_multiplier

    @property
    def is_default(self) -> bool:
        return self.name == DEFAULT

    def history_path(self, interval: str = "1m") -> Path:
        return DATA / f"{self.symbol}-{interval}.npz"

    def to_dict(self) -> dict:
        return asdict(self)


MARKETS = {
    m.name: m
    for m in (
        Market("SOL/USDC", "SOLUSDC", 9, 6, 0.003, "SOL/USDC ts64",
               "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", pinned_spot=73.23, gbm_start=70.0),
        Market("JUP/USDC", "JUPUSDC", 6, 6, 0.003, "JUP/USDC ts64",
               "HrLmpzp8Nu5wkn9SGZYSS9Ms6deTvMgGc6BETp4161ZX"),
    )
}
DEFAULT = "SOL/USDC"

# Reference sizes, defined on SOL/USDC (the published runs) and carried to other markets in USD.
REF = "SOL/USDC"
REF_UNITS = 10.0
REF_BASE_HOLDINGS = 40.0
REF_LIQUIDITY_RAW = {"deep": 4 * 10**13, "thin": 6 * 10**10}


def get(name: str) -> Market:
    try:
        return MARKETS[name]
    except KeyError:
        raise SystemExit(f"unknown market {name!r}; choose from {', '.join(MARKETS)}") from None


def manifest_path(symbol: str) -> Path:
    """SOLUSDC keeps the original manifest.json; every other symbol gets manifest-<SYMBOL>.json."""
    return DATA / ("manifest.json" if symbol == "SOLUSDC" else f"manifest-{symbol}.json")


def spot(m: Market) -> tuple[float, str]:
    """(spot, how it was chosen)."""
    if m.pinned_spot is not None:
        return m.pinned_spot, "pinned: the spot used for the published SOL/USDC runs"
    path = m.history_path()
    if not path.exists():
        raise SystemExit(f"missing {path}: run benchmarks/fetch_history.py --symbol {m.symbol} first")
    d = np.load(path)
    t = int(d["open_ms"][-1])
    return float(d["close"][-1]), f"last 1m close in {path.name} (bar opening at {t} ms UTC)"


def notional_scale(m: Market) -> float:
    """Multiplier on SOL's base-unit sizes so the USD notional matches (1.0 for SOL)."""
    return MARKETS[REF].pinned_spot / spot(m)[0]


def _below_spot_sqrt_raw(m: Market, s: float) -> tuple[float, float]:
    """sqrt of raw prices at the edges of the grid bucket just below spot (same anchoring as the compiler)."""
    w = m.bucket_ticks
    spot_tick = math.log(s * 10 ** (m.quote_decimals - m.base_decimals)) / math.log(1.0001)
    upper = math.floor(spot_tick / w) * w  # lower edge of the spot bucket = upper edge of the one below
    return 1.0001 ** ((upper - w) / 2), 1.0001 ** (upper / 2)


def quote_usd_per_bucket(m: Market, s: float, liquidity_raw: float) -> float:
    sa, sb = _below_spot_sqrt_raw(m, s)
    return liquidity_raw * (sb - sa) / 10**m.quote_decimals


def liquidity_raw_for_usd(m: Market, s: float, usd: float) -> int:
    sa, sb = _below_spot_sqrt_raw(m, s)
    return round(usd * 10**m.quote_decimals / (sb - sa))


def liquidity_usd() -> dict[str, float]:
    ref = MARKETS[REF]
    return {k: quote_usd_per_bucket(ref, ref.pinned_spot, v) for k, v in REF_LIQUIDITY_RAW.items()}


def liquidity_raw(m: Market) -> dict[str, int]:
    """Raw on-chain borrowable L per bucket giving the reference USD depth in market m."""
    s = spot(m)[0]
    return {k: liquidity_raw_for_usd(m, s, usd) for k, usd in liquidity_usd().items()}


def results_name(run: str, m: Market) -> str:
    """Plain <run_id> for SOL/USDC (existing tooling), <run_id>-<base> for other markets."""
    return run if m.is_default else f"{run}-{m.base.lower()}"
