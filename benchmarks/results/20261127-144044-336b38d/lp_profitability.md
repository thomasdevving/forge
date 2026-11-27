# Benchmark 4: is providing liquidity through FORGE profitable? (SOL/USDC)

Historical-price-driven simulation: Binance SOLUSDC 1-minute bars (2026-01-01 to 2026-10-31) drive a simulated Orca pool (fee 0.30%, buckets of 256 ticks, 8-bucket ladder centred on each window's start price, the LP is 25% of active liquidity). This is not a replay of real Orca swaps or of real FORGE borrowing: fees come from simulated arbitrage (and optional noise volume) along the historical price path, and borrow demand and budgets are assumptions, swept below. Each window deploys $10,000; bps are of starting capital. A = plain Orca LP, B = FORGE LP, HODL = hold the starting tokens; all valued at the window-end price (fees in kind, premium in USDC).

Windows: rolling 7-day and 30-day windows starting every 1 day(s), both intrabar orderings; the 3 worst drawdowns, biggest rallies and highest-volatility windows per horizon (hourly starts, non-overlapping); synthetic GBM at 90% and 140% annual vol (10 seeds each). 1222 windows x 3 fee models x 31 demand/budget configs; runtime 1251 s.

Program parameters (asserted equal to the programs/forge defaults): floor 5%/yr on borrowed notional, m(u) = 1 + u to 60%, 1.6 + 6(u - 0.6) to the 80% cap, LP cap = budget - 1% keeper bounty, keeper trigger at 80% of the cap, restoration buffer 2%, swap slippage cap 0.5%. The event engine reproduces forge_math.lpsim.simulate_path exactly on identical borrows (max relative error 4.1e-14).

Fee models: **arb-band** = arbitrage only, pool follows the price only outside the 0.30% no-arbitrage band (conservative lower bound); **band+noise** = arb-band plus round-trip noise volume of 1x the LP's ladder value per day (an assumption; the in-range pool turns over ~2x a day); **arb** = Benchmark 3 / lpsim's model, fee on every 15 s path point, which gives fee APRs of hundreds of percent and is shown only for comparison.

Demand: `uXX-short|long` = borrowers take XX% of every borrowable (strictly out-of-range) bucket, re-borrow after ~1 h, hold 8 h (short) or 7 days (long) on average. Budgets: **funded** = every borrower funds 100% of notional (cap never binds); **realistic** = Benchmark 3 base: 90% fund max(3x expected floor, 1% of notional), 10% fund 0.5x expected floor; no keeper, every borrow runs its full hold; **realistic+keeper** = as realistic, but a keeper closes the position 5 min after accrued premium reaches 80% of the cap (the on-chain trigger); **min** = adversarial: every borrower funds the on-chain minimum (1 USDC atom); no keeper ever closes; **min+keeper** = adversarial minimum budget, with a keeper closing 5 min after the 80% trigger.

## hist-7d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 66.6% | 66.6% | 62.0% | 62.0% | 0.0% |
| u20-short | 596 | 63.4% | 0.8 | -7.7 | -20.9 | 99.8% | 3.3 | -1.4 | 66.6% | 66.9% | 62.0% | 63.0% | 16.5% |
| u20-long | 596 | 6.0% | -10.1 | -37.7 | -63.5 | 99.7% | 3.8 | -1.3 | 66.6% | 65.6% | 62.0% | 57.2% | 19.5% |
| u50-short | 596 | 80.0% | 6.4 | -10.4 | -58.3 | 100.0% | 15.3 | 3.5 | 66.6% | 68.0% | 62.0% | 67.2% | 41.3% |
| u50-long | 596 | 9.6% | -23.6 | -96.0 | -143.0 | 100.0% | 18.3 | 3.0 | 66.6% | 63.1% | 62.0% | 50.5% | 48.7% |
| u80-short | 596 | 93.6% | 29.0 | -3.7 | -92.7 | 100.0% | 58.0 | 10.7 | 66.6% | 70.5% | 62.0% | 79.5% | 66.1% |
| u80-long | 596 | 12.9% | -33.3 | -147.0 | -246.1 | 100.0% | 69.4 | 18.3 | 66.6% | 61.1% | 62.0% | 44.8% | 77.9% |

## hist-7d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 71.8% | 71.8% | 84.3% | 84.3% | 0.0% |
| u20-short | 596 | 58.4% | 0.8 | -9.4 | -22.9 | 99.8% | 4.4 | -1.2 | 71.8% | 71.8% | 84.3% | 84.9% | 16.5% |
| u20-long | 596 | 2.0% | -15.4 | -42.9 | -69.1 | 99.5% | 5.3 | -1.2 | 71.8% | 70.6% | 84.3% | 76.7% | 19.5% |
| u50-short | 596 | 76.3% | 6.5 | -16.7 | -63.0 | 100.0% | 19.3 | 3.3 | 71.8% | 72.0% | 84.3% | 89.0% | 41.3% |
| u50-long | 596 | 2.3% | -38.3 | -107.6 | -158.2 | 100.0% | 23.3 | 4.7 | 71.8% | 68.6% | 84.3% | 65.3% | 48.7% |
| u80-short | 596 | 89.8% | 30.5 | -11.5 | -102.4 | 100.0% | 69.5 | 16.6 | 71.8% | 74.7% | 84.3% | 101.2% | 66.1% |
| u80-long | 596 | 3.9% | -60.1 | -174.5 | -276.2 | 100.0% | 80.8 | 20.6 | 71.8% | 64.3% | 84.3% | 53.5% | 77.9% |

## hist-30d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 52.5% | 52.5% | 38.0% | 38.0% | 0.0% |
| u20-short | 550 | 76.7% | 5.1 | -18.5 | -51.7 | 100.0% | 11.2 | 4.9 | 52.5% | 52.5% | 38.0% | 38.6% | 16.9% |
| u20-long | 550 | 7.5% | -28.2 | -139.8 | -167.5 | 100.0% | 12.4 | 4.5 | 52.5% | 50.4% | 38.0% | 34.7% | 19.7% |
| u50-short | 550 | 87.6% | 23.4 | -21.7 | -89.2 | 100.0% | 47.2 | 10.5 | 52.5% | 53.6% | 38.0% | 41.4% | 42.3% |
| u50-long | 550 | 8.5% | -72.1 | -334.3 | -420.4 | 100.0% | 55.6 | 18.5 | 52.5% | 47.3% | 38.0% | 29.5% | 49.3% |
| u80-short | 550 | 98.0% | 94.7 | 29.7 | -81.0 | 100.0% | 165.1 | 38.1 | 52.5% | 56.9% | 38.0% | 50.9% | 67.6% |
| u80-long | 550 | 10.5% | -105.8 | -529.3 | -656.5 | 100.0% | 204.1 | 42.3 | 52.5% | 44.5% | 38.0% | 25.1% | 78.9% |

## hist-30d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 57.6% | 57.6% | 56.5% | 56.5% | 0.0% |
| u20-short | 550 | 72.2% | 5.2 | -23.6 | -59.1 | 100.0% | 15.1 | 5.2 | 57.6% | 57.6% | 56.5% | 57.5% | 16.9% |
| u20-long | 550 | 3.8% | -47.8 | -165.7 | -196.6 | 100.0% | 17.7 | 5.3 | 57.6% | 56.9% | 56.5% | 50.9% | 19.7% |
| u50-short | 550 | 83.3% | 24.7 | -33.7 | -104.6 | 100.0% | 61.6 | 10.9 | 57.6% | 57.8% | 56.5% | 61.0% | 42.3% |
| u50-long | 550 | 3.8% | -127.7 | -405.2 | -498.7 | 100.0% | 73.4 | 19.3 | 57.6% | 51.8% | 56.5% | 41.7% | 49.3% |
| u80-short | 550 | 97.1% | 92.4 | 18.6 | -103.4 | 100.0% | 214.3 | 41.8 | 57.6% | 60.4% | 56.5% | 72.2% | 67.6% |
| u80-long | 550 | 4.9% | -206.2 | -644.7 | -799.1 | 100.0% | 248.4 | 46.9 | 57.6% | 48.7% | 56.5% | 31.8% | 78.9% |

## Budget sensitivity: all historical windows, fee model arb-band

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 100.0% | 7.4 | 2.2 | 1.6 | 1.60 | 0 | 60.7% | 51.7% |
| u20-short | realistic | 69.8% | 1.8 | -13.4 | -51.7 | -51.73 | 1146 | 60.0% | 50.7% |
| u20-short | realistic+keeper | 99.9% | 6.1 | 2.0 | -1.4 | -1.45 | 1100 | 60.6% | 51.4% |
| u20-short | min | 0.0% | -19.0 | -85.0 | -151.0 | -151.05 | 1146 | 57.8% | 44.9% |
| u20-short | min+keeper | 8.1% | -0.2 | -1.5 | -4.6 | -4.56 | 1146 | 59.9% | 49.7% |
| u50-short | funded | 100.0% | 33.1 | 8.9 | 4.4 | 4.43 | 0 | 63.0% | 58.5% |
| u50-short | realistic | 83.7% | 10.3 | -15.2 | -89.2 | -89.21 | 1146 | 61.1% | 54.2% |
| u50-short | realistic+keeper | 100.0% | 24.6 | 8.2 | 3.5 | 3.48 | 1108 | 62.4% | 56.9% |
| u50-short | min | 0.0% | -47.8 | -212.8 | -374.6 | -374.56 | 1146 | 54.4% | 37.3% |
| u50-short | min+keeper | 6.9% | -0.5 | -3.8 | -16.9 | -16.89 | 1146 | 59.8% | 49.6% |
| u80-short | funded | 100.0% | 153.6 | 35.5 | 11.8 | 11.80 | 0 | 70.9% | 89.4% |
| u80-short | realistic | 95.7% | 45.7 | 2.3 | -92.7 | -92.70 | 1146 | 64.0% | 65.2% |
| u80-short | realistic+keeper | 100.0% | 90.2 | 27.1 | 10.7 | 10.70 | 1123 | 67.4% | 75.0% |
| u80-short | min | 0.0% | -74.9 | -342.9 | -602.7 | -602.72 | 1146 | 50.2% | 29.6% |
| u80-short | min+keeper | 7.2% | -0.7 | -5.8 | -18.3 | -18.26 | 1146 | 59.8% | 49.5% |
| u50-long | funded | 100.0% | 46.3 | 14.8 | 7.2 | 7.16 | 0 | 63.7% | 63.2% |
| u50-long | realistic | 9.1% | -37.8 | -219.5 | -420.4 | -420.42 | 1146 | 55.5% | 40.2% |
| u50-long | realistic+keeper | 100.0% | 28.5 | 10.6 | 3.0 | 2.98 | 943 | 62.7% | 58.3% |
| u50-long | min | 0.0% | -79.6 | -329.3 | -538.2 | -538.17 | 1146 | 49.7% | 27.2% |
| u50-long | min+keeper | 7.1% | -0.5 | -3.8 | -10.0 | -9.96 | 1146 | 59.8% | 49.8% |
| u80-long | funded | 100.0% | 235.5 | 68.1 | 31.1 | 31.07 | 0 | 74.7% | 119.6% |
| u80-long | realistic | 11.8% | -53.6 | -354.1 | -656.5 | -656.55 | 1146 | 53.1% | 34.9% |
| u80-long | realistic+keeper | 100.0% | 105.9 | 38.0 | 18.3 | 18.33 | 1070 | 67.7% | 80.9% |
| u80-long | min | 0.0% | -126.7 | -525.6 | -858.1 | -858.13 | 1146 | 38.0% | 13.2% |
| u80-long | min+keeper | 7.2% | -0.7 | -5.6 | -19.4 | -19.40 | 1146 | 59.7% | 49.7% |

## Budget sensitivity: all historical windows, fee model band+noise

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 100.0% | 9.1 | 3.3 | 2.0 | 2.02 | 0 | 65.4% | 73.1% |
| u20-short | realistic | 65.0% | 1.8 | -16.2 | -59.1 | -59.15 | 1146 | 65.0% | 71.2% |
| u20-short | realistic+keeper | 99.9% | 7.5 | 2.8 | -1.2 | -1.16 | 1103 | 65.4% | 72.6% |
| u20-short | min | 0.0% | -23.0 | -97.4 | -170.3 | -170.31 | 1146 | 63.9% | 64.5% |
| u20-short | min+keeper | 7.9% | -0.2 | -1.5 | -4.6 | -4.57 | 1146 | 65.0% | 70.6% |
| u50-short | funded | 100.0% | 42.8 | 14.2 | 6.5 | 6.51 | 0 | 67.7% | 82.2% |
| u50-short | realistic | 79.7% | 10.5 | -25.9 | -104.6 | -104.61 | 1146 | 65.2% | 74.6% |
| u50-short | realistic+keeper | 100.0% | 30.2 | 11.5 | 3.3 | 3.26 | 1110 | 66.6% | 79.0% |
| u50-short | min | 0.0% | -58.0 | -245.9 | -424.0 | -424.02 | 1146 | 61.1% | 55.1% |
| u50-short | min+keeper | 6.5% | -0.5 | -3.9 | -16.9 | -16.92 | 1146 | 65.0% | 70.4% |
| u80-short | funded | 100.0% | 198.3 | 60.1 | 19.8 | 19.76 | 0 | 75.2% | 126.2% |
| u80-short | realistic | 93.3% | 44.5 | -6.5 | -103.4 | -103.44 | 1146 | 67.8% | 86.0% |
| u80-short | realistic+keeper | 100.0% | 103.2 | 37.9 | 16.6 | 16.62 | 1124 | 71.2% | 100.9% |
| u80-short | min | 0.0% | -92.1 | -400.9 | -688.3 | -688.32 | 1146 | 57.3% | 44.1% |
| u80-short | min+keeper | 7.2% | -0.8 | -5.9 | -18.5 | -18.46 | 1146 | 65.0% | 70.4% |
| u50-long | funded | 100.0% | 65.3 | 28.8 | 9.4 | 9.36 | 0 | 69.8% | 91.5% |
| u50-long | realistic | 3.1% | -59.5 | -290.2 | -498.7 | -498.74 | 1146 | 60.6% | 53.6% |
| u50-long | realistic+keeper | 100.0% | 34.6 | 15.0 | 4.7 | 4.73 | 939 | 67.2% | 80.9% |
| u50-long | min | 0.0% | -99.5 | -394.3 | -618.3 | -618.32 | 1146 | 55.5% | 40.1% |
| u50-long | min+keeper | 6.6% | -0.5 | -3.9 | -10.1 | -10.13 | 1146 | 65.0% | 70.5% |
| u80-long | funded | 100.0% | 328.8 | 132.9 | 42.3 | 42.33 | 0 | 80.1% | 177.9% |
| u80-long | realistic | 4.4% | -91.1 | -475.6 | -799.1 | -799.15 | 1146 | 56.8% | 42.1% |
| u80-long | realistic+keeper | 100.0% | 117.9 | 45.8 | 20.6 | 20.56 | 1066 | 71.8% | 106.0% |
| u80-long | min | 0.0% | -160.4 | -644.2 | -1,001.3 | -1,001.32 | 1146 | 43.9% | 20.0% |
| u80-long | min+keeper | 7.0% | -0.8 | -5.8 | -19.6 | -19.56 | 1146 | 65.0% | 70.5% |

## Regimes: fee model arb-band, demand u50-short

| regime | n | median return | B >= A (realistic) | extra median bps | extra min bps | B >= A (+keeper) | A > HODL | B > HODL | A-HODL median bps | B-HODL median bps | APR A median | APR B median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gbm-30d-vol0.9 | 10 | -3.0% | 90.0% | 18.3 | -20.8 | 100.0% | 40.0% | 40.0% | -454.2 | -431.7 | 55.6% | 58.4% |
| gbm-30d-vol1.4 | 10 | 9.8% | 40.0% | -59.2 | -244.8 | 90.0% | 40.0% | 40.0% | -1,811.3 | -1,777.4 | 105.2% | 96.6% |
| gbm-7d-vol0.9 | 10 | 0.3% | 40.0% | -0.4 | -15.4 | 100.0% | 40.0% | 40.0% | -154.1 | -152.6 | 95.1% | 95.9% |
| gbm-7d-vol1.4 | 10 | -2.1% | 20.0% | -33.6 | -86.4 | 100.0% | 40.0% | 40.0% | -103.4 | -123.4 | 235.2% | 199.6% |
| hist-30d-all | 550 | -0.6% | 87.6% | 23.4 | -89.2 | 100.0% | 52.5% | 53.6% | 29.6 | 55.9 | 38.0% | 41.4% |
| hist-30d-best-decile-return | 56 | 35.8% | 92.9% | 19.6 | -35.8 | 100.0% | 0.0% | 0.0% | -1,238.7 | -1,220.4 | 12.5% | 14.7% |
| hist-30d-top-decile-vol | 56 | -34.8% | 87.5% | 20.1 | -67.8 | 100.0% | 7.1% | 7.1% | -1,649.5 | -1,611.9 | 17.1% | 19.8% |
| hist-30d-worst-decile-return | 56 | -35.9% | 100.0% | 27.5 | 3.4 | 100.0% | 0.0% | 0.0% | -1,689.7 | -1,661.3 | 17.9% | 21.2% |
| hist-7d-all | 596 | -0.9% | 80.0% | 6.4 | -58.3 | 100.0% | 66.6% | 68.0% | 52.5 | 58.8 | 62.0% | 67.2% |
| hist-7d-best-decile-return | 60 | 15.0% | 75.0% | 4.5 | -58.3 | 100.0% | 3.3% | 3.3% | -335.2 | -331.2 | 63.7% | 64.2% |
| hist-7d-top-decile-vol | 60 | -13.1% | 43.3% | -3.7 | -58.3 | 100.0% | 23.3% | 23.3% | -454.2 | -460.4 | 88.8% | 84.3% |
| hist-7d-worst-decile-return | 60 | -14.5% | 70.0% | 5.0 | -45.8 | 100.0% | 0.0% | 0.0% | -364.7 | -354.3 | 49.3% | 53.7% |
| hist-all | 1146 | -0.7% | 83.7% | 10.3 | -89.2 | 100.0% | 59.9% | 61.1% | 50.2 | 58.2 | 49.8% | 54.2% |
| stress-30d-drawdown | 6 | -35.8% | 100.0% | 25.5 | 6.6 | 100.0% | 0.0% | 0.0% | -1,873.1 | -1,853.6 | 10.7% | 13.8% |
| stress-30d-rally | 6 | 33.8% | 100.0% | 16.5 | 4.3 | 100.0% | 0.0% | 0.0% | -969.7 | -955.7 | 41.3% | 42.9% |
| stress-30d-vol | 6 | 3.3% | 100.0% | 14.7 | 4.2 | 100.0% | 33.3% | 33.3% | -1,168.6 | -1,152.5 | 11.9% | 13.8% |
| stress-7d-drawdown | 6 | -26.0% | 100.0% | 6.4 | 3.6 | 100.0% | 0.0% | 0.0% | -1,061.9 | -1,055.5 | 48.1% | 52.6% |
| stress-7d-rally | 6 | 26.9% | 83.3% | 4.9 | -12.3 | 100.0% | 0.0% | 0.0% | -887.9 | -892.4 | 28.2% | 31.4% |
| stress-7d-vol | 6 | -16.5% | 0.0% | -34.7 | -39.5 | 100.0% | 0.0% | 0.0% | -558.9 | -566.3 | 124.1% | 105.5% |

## Benchmark 3 fee model (arb) for comparison: all historical windows

| demand | budget | APR A median | APR B median | B >= A | extra median bps | extra min bps |
|---|---|---|---|---|---|---|
| none | - | 937.8% | 937.8% | 100.0% | 0.0 | 0.0 |
| u20-short | funded | 937.8% | 955.3% | 99.8% | 60.2 | -5.7 |
| u20-short | realistic | 937.8% | 867.7% | 0.0% | -233.6 | -1,809.0 |
| u20-short | realistic+keeper | 937.8% | 941.7% | 99.8% | 9.3 | -3.0 |
| u20-long | funded | 937.8% | 965.4% | 92.6% | 80.6 | -354.1 |
| u20-long | realistic | 937.8% | 775.9% | 0.0% | -468.8 | -2,781.5 |
| u20-long | realistic+keeper | 937.8% | 941.1% | 99.2% | 9.3 | -4.8 |
| u50-short | funded | 937.8% | 1050.2% | 100.0% | 355.2 | 24.8 |
| u50-short | realistic | 937.8% | 758.9% | 0.0% | -572.4 | -4,050.1 |
| u50-short | realistic+keeper | 937.8% | 958.2% | 100.0% | 51.9 | 3.9 |
| u50-long | funded | 937.8% | 1096.6% | 99.5% | 510.4 | -838.4 |
| u50-long | realistic | 937.8% | 527.5% | 0.0% | -1,165.6 | -6,957.5 |
| u50-long | realistic+keeper | 937.8% | 958.7% | 100.0% | 54.5 | 3.2 |
| u80-short | funded | 937.8% | 1549.2% | 100.0% | 2,061.1 | 138.3 |
| u80-short | realistic | 937.8% | 652.8% | 0.0% | -904.5 | -6,464.1 |
| u80-short | realistic+keeper | 937.8% | 1007.0% | 100.0% | 186.5 | 16.1 |
| u80-long | funded | 937.8% | 1626.5% | 99.8% | 2,333.8 | -252.3 |
| u80-long | realistic | 937.8% | 276.7% | 0.0% | -1,825.2 | -11,134.4 |
| u80-long | realistic+keeper | 937.8% | 1008.1% | 100.0% | 197.0 | 19.5 |

## Failure modes: FORGE LP < plain Orca LP

Cases = windows x the 6 demand levels, over every regime (historical, stress, GBM). Causes: **shortfall** = the gap closes if the premium above the borrower's capped budget had been paid; **in-kind** = the premium covered the forgone fees at the prices when they accrued, but plain Orca's fees are kept in kind and the base-token part was worth more at the window-end price; **other** = neither alone explains it. Accrual-time guarantee violations (fully funded borrow whose premium is below its forgone fees at accrual prices) are counted separately and must be 0.

| fee model | budget | cases | B < A | shortfall | in-kind | other | accrual-time violations | worst bps | worst USD | worst case |
|---|---|---|---|---|---|---|---|---|---|---|
| arb-band | funded | 7332 | 4 | 0 | 4 | 0 | 0 | -74.5 | -74.48 | u50-long gbm-30d-vol1.4-s20265527 |
| arb-band | realistic | 7332 | 3976 | 3972 | 0 | 4 | 0 | -1,207.5 | -1,207.50 | u80-long gbm-30d-vol1.4-s20265535 |
| arb-band | realistic+keeper | 7332 | 7 | 3 | 4 | 0 | 0 | -37.5 | -37.49 | u20-short gbm-30d-vol1.4-s20265527 |
| arb-band | min | 7332 | 7332 | 7328 | 0 | 4 | 0 | -1,447.6 | -1,447.61 | u80-long gbm-30d-vol1.4-s20265535 |
| arb-band | min+keeper | 7332 | 6813 | 6812 | 0 | 1 | 0 | -19.4 | -19.40 | u80-long hist-30d-2026-08-22T00:00-LH |
| band+noise | funded | 7332 | 4 | 0 | 4 | 0 | 0 | -71.0 | -70.98 | u20-long gbm-30d-vol1.4-s20265527 |
| band+noise | realistic | 7332 | 4333 | 4329 | 0 | 4 | 0 | -1,314.9 | -1,314.94 | u80-long gbm-30d-vol1.4-s20265535 |
| band+noise | realistic+keeper | 7332 | 8 | 4 | 4 | 0 | 0 | -34.2 | -34.15 | u20-short gbm-30d-vol1.4-s20265527 |
| band+noise | min | 7332 | 7332 | 7328 | 0 | 4 | 0 | -1,555.0 | -1,555.05 | u80-long gbm-30d-vol1.4-s20265535 |
| band+noise | min+keeper | 7332 | 6833 | 6832 | 0 | 1 | 0 | -19.6 | -19.56 | u80-long hist-30d-2026-08-22T00:00-LH |
| arb | funded | 7332 | 108 | 94 | 14 | 0 | 0 | -838.4 | -838.36 | u50-long hist-30d-2026-02-19T00:00-HL |
| arb | realistic | 7332 | 7331 | 7317 | 0 | 14 | 0 | -11,134.4 | -11,134.42 | u80-long hist-30d-2026-02-14T00:00-LH |
| arb | realistic+keeper | 7332 | 15 | 11 | 4 | 0 | 0 | -73.9 | -73.91 | u20-long gbm-30d-vol1.4-s20265527 |
| arb | min | 7332 | 7332 | 7318 | 0 | 14 | 0 | -11,353.8 | -11,353.80 | u80-long hist-30d-2026-02-14T00:00-LH |
| arb | min+keeper | 7332 | 7309 | 7305 | 0 | 4 | 0 | -99.2 | -99.22 | u80-short hist-30d-2026-02-10T00:00-LH |

Restoration refusals (swap cost above the 0.5% slippage cap; retried after 1 h): 437 over all runs. They delay restoration; they never reduce the LP's liquidity.

Every number (all regimes x fee models x demand x budgets, per-config failure lists, per-window values for realistic budgets) is in lp_profitability.json.

Model notes:

- Simulator: forge_math.lpsim's event engine (fee_growth, settle_borrows, simulate_demand), which follows the program: floor on the notional stored at open (calls at the open reference price), LP cap = budget less the 1% bounty, keeper close 5 min after accrued premium reaches 80% of the cap (budgets *+keeper), restoration refused above the 0.5% slippage cap or the escrow margin and retried after 1 h.
- Demand sweep (this benchmark's choice): utilization fixed per demand level (0.2 / 0.5 / 0.8) and borrowers return ~1 h after a bucket frees up, instead of Benchmark 3's random uniform(0.2, 0.8) borrowers.
- Fee models: 'arb-band' and 'band+noise' run on the no-arbitrage-band pool path computed over the whole history (Benchmark 3 starts the band at each window's first price; the pool start differs by < 0.3%); 'arb' is lpsim's legacy-every-price model, kept for comparison.
- Noise volume is a multiple of the LP ladder's starting value (lpsim fixed the extra sqrt(P0) factor that earlier Benchmark 3 runs carried).
