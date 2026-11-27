# Benchmark 3: conditional LP guarantee (JUP/USDC)

Historical paths: Binance JUPUSDC 1m bars. Synthetic GBM start 0.2582. Pool fee 0.30%. Program defaults read from programs/forge (parity checked). The pool follows the price outside the fee's no-arbitrage band; noise volume (base+noise) is 1x the LP ladder's value per day; base+keeper closes positions 5 min after accrued premium reaches 80% of the LP cap. legacy-fee-model (fee on every path point, the model of earlier runs) is shown for comparison and excluded from 'all'.

Per borrow (the guarantee is per borrowed range): eligible = fully funded. Refused restorations are retried after 1 h with premium still accruing; they are counted, not dropped.

| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration refusals | keeper closes | median fee APR (world A) |
|---|---|---|---|---|---|---|---|---|
| historical-price-driven/base | 11019 | 9722 | 9722 | 0 | 1297 | 1 | 0 | 87.8% |
| historical-price-driven/base+noise | 11019 | 9663 | 9663 | 0 | 1356 | 1 | 0 | 111.6% |
| historical-price-driven/fully-funded | 11019 | 11019 | 11019 | 0 | 0 | 1 | 0 | 87.8% |
| historical-price-driven/base+keeper | 11826 | 11571 | 11571 | 0 | 255 | 0 | 1502 | 87.8% |
| historical-price-driven/stress-restoration | 11030 | 9724 | 9724 | 0 | 1306 | 178 | 0 | 87.8% |
| historical-price-driven/legacy-fee-model | 11006 | 9024 | 9024 | 0 | 1982 | 0 | 0 | 453.3% |
| synthetic-gbm/base | 2121 | 1702 | 1702 | 0 | 419 | 0 | 0 | 83.9% |
| synthetic-gbm/base+noise | 2121 | 1667 | 1667 | 0 | 454 | 0 | 0 | 98.5% |
| synthetic-gbm/fully-funded | 2121 | 2121 | 2121 | 0 | 0 | 0 | 0 | 83.9% |
| synthetic-gbm/base+keeper | 2477 | 2418 | 2418 | 0 | 59 | 0 | 570 | 83.9% |
| synthetic-gbm/stress-restoration | 2137 | 1712 | 1712 | 0 | 425 | 46 | 0 | 83.9% |
| synthetic-gbm/legacy-fee-model | 2117 | 1510 | 1510 | 0 | 607 | 0 | 0 | 389.8% |
| all | 66890 | 61319 | 61319 | 0 | 5571 | 227 | 2072 | 90.9% |

Per path (all borrows on the path eligible):

| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |
|---|---|---|---|---|
| historical-price-driven/base | 86 | 0 | 0 | 43 |
| historical-price-driven/base+noise | 86 | 0 | 0 | 44 |
| historical-price-driven/fully-funded | 86 | 86 | 86 | 0 |
| historical-price-driven/base+keeper | 86 | 5 | 5 | 0 |
| historical-price-driven/stress-restoration | 86 | 0 | 0 | 49 |
| historical-price-driven/legacy-fee-model | 86 | 0 | 0 | 86 |
| synthetic-gbm/base | 60 | 0 | 0 | 44 |
| synthetic-gbm/base+noise | 60 | 0 | 0 | 49 |
| synthetic-gbm/fully-funded | 60 | 60 | 60 | 0 |
| synthetic-gbm/base+keeper | 60 | 25 | 25 | 0 |
| synthetic-gbm/stress-restoration | 60 | 0 | 0 | 42 |
| synthetic-gbm/legacy-fee-model | 60 | 0 | 0 | 60 |
| all | 730 | 176 | 176 | 271 |
