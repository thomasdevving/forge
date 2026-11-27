# Benchmark 1: replication accuracy (JUP/USDC)

Spot 0.2582 (last 1m close in JUPUSDC-1m.npz (bar opening at 1793491140000 ms UTC)); payoff units 2836.17 JUP; borrowable liquidity deep 21092371861831 raw L (~$136,121 quote per bucket), thin 31638557793 raw L (~$204 quote per bucket).

| method / liquidity | payoffs | feasible | median error (bps of notional) | max error (bps) | mean legs | mean solve (ms) |
|---|---|---|---|---|---|---|
| baseline/deep | 23 | 18 | 25.1 | 58.6 | 2.0 | 2.0 |
| optimizer/deep | 23 | 20 | 15.1 | 86.8 | 3.8 | 464.5 |
| baseline/thin | 23 | 1 | 23.5 | 23.5 | 3.0 | 2.3 |
| optimizer/thin | 23 | 19 | 23.0 | 76.0 | 5.7 | 281.1 |

Certificate bound violations on dense checks: 0
