# Benchmark 2: theoretical vs realized, JUP/USDC (Surfpool mainnet fork, real Orca CPIs)

| payoff | close | target | certified construction | bound | realized gross | realized net | premium | fee credits | restoration swap cost | gap to construction |
|---|---|---|---|---|---|---|---|---|---|---|
| protective_put | 0.9x | refused by SwapSlippage (position left recoverable) | | | | | | | | |
| protective_put | 1x (0.25) | 736.74 | 734.70 | 2.10 | 734.70 | 734.70 | 0.0000 | 0.0000 | 0.0000 | -0.0000 |
| protective_put | 1.1x (0.27) | 810.41 | 808.78 | 2.10 | 808.77 | 808.75 | 0.0257 | 0.0000 | 0.0071 | -0.0071 |
| collar | 0.9x | refused by PoolDeviation (position left recoverable) | | | | | | | | |
| collar | 1x (0.25) | 736.74 | 737.52 | 2.74 | 737.52 | 737.52 | 0.0000 | 0.0000 | 0.0000 | -0.0000 |
| collar | 1.1x (0.27) | 795.68 | 798.29 | 2.74 | 798.29 | 800.17 | 0.0000 | 1.8849 | 0.0000 | -0.0000 |
| call_spread | 0.9x (0.22) | 331.53 | 330.79 | 1.41 | 330.79 | 330.79 | 0.0000 | 0.0000 | 0.0000 | -0.0000 |
| call_spread | 1x (0.25) | 368.37 | 367.54 | 1.41 | 367.54 | 367.54 | 0.0000 | 0.0000 | 0.0000 | -0.0000 |
| call_spread | 1.1x (0.27) | 427.31 | 425.90 | 1.41 | 424.86 | 424.38 | 1.0065 | 0.5282 | 1.0465 | -1.0465 |
| strangle | 0.9x | refused by PoolDeviation (position left recoverable) | | | | | | | | |
| strangle | 1x (0.25) | 0.00 | 0.00 | 3.37 | -0.00 | -0.00 | 0.0000 | 0.0000 | 0.0000 | -0.0000 |
| strangle | 1.1x (0.27) | 22.10 | 18.77 | 3.37 | 15.93 | 13.84 | 2.0882 | 0.0000 | 2.8359 | -2.8359 |
