# Benchmark 3: conditional LP guarantee (SOL/USDC)

Historical paths: Binance SOLUSDC 1m bars. Synthetic GBM start 70. Pool fee 0.30%. Program defaults read from programs/forge (parity checked). The pool follows the price outside the fee's no-arbitrage band; noise volume (base+noise) is 1x the LP ladder's value per day; base+keeper closes positions 5 min after accrued premium reaches 80% of the LP cap. legacy-fee-model (fee on every path point, the model of earlier runs) is shown for comparison and excluded from 'all'.

Per borrow (the guarantee is per borrowed range): eligible = fully funded. Refused restorations are retried after 1 h with premium still accruing; they are counted, not dropped.

| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration refusals | keeper closes | median fee APR (world A) |
|---|---|---|---|---|---|---|---|---|
| historical-price-driven/base | 10759 | 9681 | 9681 | 0 | 1078 | 0 | 0 | 59.9% |
| historical-price-driven/base+noise | 10759 | 9627 | 9627 | 0 | 1132 | 0 | 0 | 83.7% |
| historical-price-driven/fully-funded | 10759 | 10759 | 10759 | 0 | 0 | 0 | 0 | 59.9% |
| historical-price-driven/base+keeper | 11319 | 11131 | 11131 | 0 | 188 | 0 | 1223 | 59.9% |
| historical-price-driven/stress-restoration | 10722 | 9631 | 9631 | 0 | 1091 | 148 | 0 | 59.9% |
| historical-price-driven/legacy-fee-model | 10753 | 8911 | 8911 | 0 | 1842 | 0 | 0 | 1106.7% |
| synthetic-gbm/base | 2139 | 1723 | 1723 | 0 | 416 | 0 | 0 | 78.9% |
| synthetic-gbm/base+noise | 2139 | 1699 | 1699 | 0 | 440 | 0 | 0 | 85.3% |
| synthetic-gbm/fully-funded | 2139 | 2139 | 2139 | 0 | 0 | 0 | 0 | 78.9% |
| synthetic-gbm/base+keeper | 2440 | 2396 | 2396 | 0 | 44 | 0 | 541 | 78.9% |
| synthetic-gbm/stress-restoration | 2141 | 1725 | 1725 | 0 | 416 | 51 | 0 | 78.9% |
| synthetic-gbm/legacy-fee-model | 2130 | 1550 | 1550 | 0 | 580 | 0 | 0 | 382.7% |
| all | 65316 | 60511 | 60511 | 0 | 4805 | 199 | 1764 | 69.7% |

Per path (all borrows on the path eligible):

| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |
|---|---|---|---|---|
| historical-price-driven/base | 86 | 0 | 0 | 20 |
| historical-price-driven/base+noise | 86 | 0 | 0 | 23 |
| historical-price-driven/fully-funded | 86 | 86 | 86 | 0 |
| historical-price-driven/base+keeper | 86 | 13 | 13 | 0 |
| historical-price-driven/stress-restoration | 86 | 0 | 0 | 20 |
| historical-price-driven/legacy-fee-model | 86 | 0 | 0 | 86 |
| synthetic-gbm/base | 60 | 0 | 0 | 47 |
| synthetic-gbm/base+noise | 60 | 0 | 0 | 49 |
| synthetic-gbm/fully-funded | 60 | 60 | 60 | 0 |
| synthetic-gbm/base+keeper | 60 | 28 | 28 | 0 |
| synthetic-gbm/stress-restoration | 60 | 0 | 0 | 46 |
| synthetic-gbm/legacy-fee-model | 60 | 0 | 0 | 60 |
| all | 730 | 187 | 187 | 205 |
