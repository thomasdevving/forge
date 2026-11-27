# Benchmark 3: conditional LP guarantee (JUP/USDC)

Historical paths: Binance JUPUSDC 1m bars. Synthetic GBM start 0.2582. Pool fee 0.30%.

Per borrow (the guarantee is per borrowed range): eligible = restored and fully funded.

| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration failures |
|---|---|---|---|---|---|---|
| historical-price-driven/base | 11001 | 8964 | 8964 | 0 | 2037 | 0 |
| historical-price-driven/base+noise | 11001 | 8952 | 8952 | 0 | 2049 | 0 |
| historical-price-driven/fully-funded | 11001 | 11001 | 11001 | 0 | 0 | 0 |
| historical-price-driven/stress-restoration | 11001 | 8948 | 8948 | 0 | 2037 | 58 |
| synthetic-gbm/base | 2123 | 1493 | 1493 | 0 | 630 | 0 |
| synthetic-gbm/base+noise | 2123 | 1489 | 1489 | 0 | 634 | 0 |
| synthetic-gbm/fully-funded | 2123 | 2123 | 2123 | 0 | 0 | 0 |
| synthetic-gbm/stress-restoration | 2123 | 1492 | 1492 | 0 | 630 | 14 |
| all | 52496 | 44462 | 44462 | 0 | 8017 | 72 |

Per path (all borrows on the path eligible):

| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |
|---|---|---|---|---|
| historical-price-driven/base | 86 | 0 | 0 | 84 |
| historical-price-driven/base+noise | 86 | 0 | 0 | 84 |
| historical-price-driven/fully-funded | 86 | 86 | 86 | 0 |
| historical-price-driven/stress-restoration | 86 | 0 | 0 | 84 |
| synthetic-gbm/base | 60 | 0 | 0 | 60 |
| synthetic-gbm/base+noise | 60 | 0 | 0 | 60 |
| synthetic-gbm/fully-funded | 60 | 60 | 60 | 0 |
| synthetic-gbm/stress-restoration | 60 | 0 | 0 | 60 |
| all | 584 | 146 | 146 | 432 |
