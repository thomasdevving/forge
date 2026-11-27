# Benchmark 1: replication accuracy

| method / liquidity | payoffs | feasible | median error (bps of notional) | max error (bps) | mean legs | mean solve (ms) |
|---|---|---|---|---|---|---|
| baseline/deep | 23 | 15 | 27.9 | 70.8 | 1.9 | 1.9 |
| optimizer/deep | 23 | 20 | 17.8 | 84.0 | 3.6 | 442.5 |
| baseline/thin | 23 | 1 | 49.6 | 49.6 | 3.0 | 1.9 |
| optimizer/thin | 23 | 19 | 25.5 | 62.0 | 5.8 | 315.1 |

Certificate bound violations on dense checks: 0
