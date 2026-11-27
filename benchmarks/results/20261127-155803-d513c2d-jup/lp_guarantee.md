# Benchmark 3: conditional LP guarantee (JUP/USDC)

Historical paths: Binance JUPUSDC 1m bars. Synthetic GBM start 0.2582. Pool fee 0.30%. Program defaults read from programs/forge (parity checked). The pool follows the price outside the fee's no-arbitrage band; noise volume (base+noise) is 1x the LP ladder's value per day; base+keeper closes positions 5 min after accrued premium reaches 80% of the LP cap. legacy-fee-model (fee on every path point, the model of earlier runs) is shown for comparison and excluded from 'all'.

Per borrow (the guarantee is per borrowed range): eligible = fully funded. Refused restorations are retried after 1 h with premium still accruing; they are counted, not dropped.

| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration refusals | keeper closes | median fee APR (world A) |
|---|---|---|---|---|---|---|---|---|
| historical-price-driven/base | 11019 | 9625 | 9625 | 0 | 1394 | 1 | 0 | 87.8% |
| historical-price-driven/base+noise | 11019 | 9551 | 9551 | 0 | 1468 | 1 | 0 | 111.6% |
| historical-price-driven/fully-funded | 11019 | 11019 | 11019 | 0 | 0 | 1 | 0 | 87.8% |
| historical-price-driven/base+keeper | 11895 | 11601 | 11601 | 0 | 294 | 0 | 1661 | 87.8% |
| historical-price-driven/stress-restoration | 11030 | 9631 | 9631 | 0 | 1399 | 178 | 0 | 87.8% |
| historical-price-driven/legacy-fee-model | 11006 | 8956 | 8956 | 0 | 2050 | 0 | 0 | 453.3% |
| synthetic-gbm/base | 2121 | 1660 | 1660 | 0 | 461 | 0 | 0 | 83.9% |
| synthetic-gbm/base+noise | 2121 | 1635 | 1635 | 0 | 486 | 0 | 0 | 98.5% |
| synthetic-gbm/fully-funded | 2121 | 2121 | 2121 | 0 | 0 | 0 | 0 | 83.9% |
| synthetic-gbm/base+keeper | 2514 | 2467 | 2467 | 0 | 47 | 0 | 647 | 83.9% |
| synthetic-gbm/stress-restoration | 2137 | 1671 | 1671 | 0 | 466 | 46 | 0 | 83.9% |
| synthetic-gbm/legacy-fee-model | 2117 | 1487 | 1487 | 0 | 630 | 0 | 0 | 389.8% |
| all | 66996 | 60981 | 60981 | 0 | 6015 | 227 | 2308 | 90.9% |

Per path (all borrows on the path eligible):

| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |
|---|---|---|---|---|
| historical-price-driven/base | 86 | 0 | 0 | 27 |
| historical-price-driven/base+noise | 86 | 0 | 0 | 30 |
| historical-price-driven/fully-funded | 86 | 86 | 86 | 0 |
| historical-price-driven/base+keeper | 86 | 4 | 4 | 0 |
| historical-price-driven/stress-restoration | 86 | 0 | 0 | 33 |
| historical-price-driven/legacy-fee-model | 86 | 0 | 0 | 86 |
| synthetic-gbm/base | 60 | 0 | 0 | 41 |
| synthetic-gbm/base+noise | 60 | 0 | 0 | 46 |
| synthetic-gbm/fully-funded | 60 | 60 | 60 | 0 |
| synthetic-gbm/base+keeper | 60 | 32 | 32 | 0 |
| synthetic-gbm/stress-restoration | 60 | 0 | 0 | 40 |
| synthetic-gbm/legacy-fee-model | 60 | 0 | 0 | 60 |
| all | 730 | 182 | 182 | 217 |
