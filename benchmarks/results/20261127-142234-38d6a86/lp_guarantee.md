# Benchmark 3: conditional LP guarantee

Per borrow (the guarantee is per borrowed range): eligible = restored and fully funded.

| slice | borrows | eligible | guarantee holds | violations | premium shortfalls | restoration failures |
|---|---|---|---|---|---|---|
| historical-price-driven/base | 10775 | 8905 | 8905 | 0 | 1870 | 0 |
| historical-price-driven/base+noise | 10775 | 8837 | 8837 | 0 | 1938 | 0 |
| historical-price-driven/fully-funded | 10775 | 10774 | 10774 | 0 | 1 | 0 |
| historical-price-driven/stress-restoration | 10775 | 8901 | 8901 | 0 | 1870 | 61 |
| synthetic-gbm/base | 2140 | 1535 | 1535 | 0 | 605 | 0 |
| synthetic-gbm/base+noise | 2140 | 1524 | 1524 | 0 | 616 | 0 |
| synthetic-gbm/fully-funded | 2140 | 2140 | 2140 | 0 | 0 | 0 |
| synthetic-gbm/stress-restoration | 2140 | 1534 | 1534 | 0 | 605 | 8 |
| all | 51660 | 44150 | 44150 | 0 | 7505 | 69 |

Per path (all borrows on the path eligible):

| slice | paths | eligible paths | holds (eligible paths) | final-value counterexamples (all paths) |
|---|---|---|---|---|
| historical-price-driven/base | 86 | 0 | 0 | 86 |
| historical-price-driven/base+noise | 86 | 0 | 0 | 86 |
| historical-price-driven/fully-funded | 86 | 85 | 85 | 0 |
| historical-price-driven/stress-restoration | 86 | 0 | 0 | 86 |
| synthetic-gbm/base | 60 | 0 | 0 | 60 |
| synthetic-gbm/base+noise | 60 | 0 | 0 | 60 |
| synthetic-gbm/fully-funded | 60 | 60 | 60 | 0 |
| synthetic-gbm/stress-restoration | 60 | 0 | 0 | 60 |
| all | 584 | 145 | 145 | 438 |
