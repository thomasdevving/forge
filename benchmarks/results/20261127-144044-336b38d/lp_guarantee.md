# Benchmark 3: conditional LP guarantee (SOL/USDC)

Historical paths: Binance SOLUSDC 1m bars. Synthetic GBM start 70. Pool fee 0.30%. Program defaults read from programs/forge (parity checked). The pool follows the price outside the fee's no-arbitrage band; noise volume (base+noise) is 1x the LP ladder's value per day; base+keeper closes positions 5 min after accrued premium reaches 80% of the LP cap. legacy-fee-model (fee on every path point, the model of earlier runs) is shown for comparison and excluded from 'all'.

Per borrow (the guarantee is per borrowed range): eligible = fully funded. Refused restorations are retried after 1 h with premium still accruing; they are counted, not dropped.

| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration refusals | keeper closes | median fee APR (world A) |
|---|---|---|---|---|---|---|---|---|
| historical-price-driven/base | 10759 | 9621 | 9621 | 0 | 1138 | 0 | 0 | 59.9% |
| historical-price-driven/base+noise | 10759 | 9556 | 9556 | 0 | 1203 | 0 | 0 | 83.7% |
| historical-price-driven/fully-funded | 10759 | 10759 | 10759 | 0 | 0 | 0 | 0 | 59.9% |
| historical-price-driven/base+keeper | 11368 | 11137 | 11137 | 0 | 231 | 0 | 1320 | 59.9% |
| historical-price-driven/stress-restoration | 10722 | 9573 | 9573 | 0 | 1149 | 148 | 0 | 59.9% |
| historical-price-driven/legacy-fee-model | 10753 | 8866 | 8866 | 0 | 1887 | 0 | 0 | 1106.7% |
| synthetic-gbm/base | 2139 | 1690 | 1690 | 0 | 449 | 0 | 0 | 78.9% |
| synthetic-gbm/base+noise | 2139 | 1656 | 1656 | 0 | 483 | 0 | 0 | 85.3% |
| synthetic-gbm/fully-funded | 2139 | 2139 | 2139 | 0 | 0 | 0 | 0 | 78.9% |
| synthetic-gbm/base+keeper | 2483 | 2434 | 2434 | 0 | 49 | 0 | 601 | 78.9% |
| synthetic-gbm/stress-restoration | 2141 | 1691 | 1691 | 0 | 450 | 51 | 0 | 78.9% |
| synthetic-gbm/legacy-fee-model | 2130 | 1533 | 1533 | 0 | 597 | 0 | 0 | 382.7% |
| all | 65408 | 60256 | 60256 | 0 | 5152 | 199 | 1921 | 69.7% |

Per path (all borrows on the path eligible):

| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |
|---|---|---|---|---|
| historical-price-driven/base | 86 | 0 | 0 | 10 |
| historical-price-driven/base+noise | 86 | 0 | 0 | 12 |
| historical-price-driven/fully-funded | 86 | 86 | 86 | 0 |
| historical-price-driven/base+keeper | 86 | 8 | 8 | 0 |
| historical-price-driven/stress-restoration | 86 | 0 | 0 | 9 |
| historical-price-driven/legacy-fee-model | 86 | 0 | 0 | 86 |
| synthetic-gbm/base | 60 | 0 | 0 | 40 |
| synthetic-gbm/base+noise | 60 | 0 | 0 | 46 |
| synthetic-gbm/fully-funded | 60 | 60 | 60 | 0 |
| synthetic-gbm/base+keeper | 60 | 28 | 28 | 0 |
| synthetic-gbm/stress-restoration | 60 | 0 | 0 | 38 |
| synthetic-gbm/legacy-fee-model | 60 | 0 | 0 | 60 |
| all | 730 | 182 | 182 | 155 |
