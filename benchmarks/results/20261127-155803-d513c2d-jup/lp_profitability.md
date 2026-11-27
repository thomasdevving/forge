# Benchmark 4: is providing liquidity through FORGE profitable? (JUP/USDC)

Historical-price-driven simulation: Binance JUPUSDC 1-minute bars (2026-01-01 to 2026-10-31) drive a simulated Orca pool (fee 0.30%, buckets of 256 ticks, 8-bucket ladder centred on each window's start price, the LP is 25% of active liquidity). This is not a replay of real Orca swaps or of real FORGE borrowing: fees come from simulated arbitrage (and optional noise volume) along the historical price path, and borrow demand and budgets are assumptions, swept below. Each window deploys $10,000; bps are of starting capital. A = plain Orca LP, B = FORGE LP, HODL = hold the starting tokens; all valued at the window-end price (fees in kind, premium in USDC).

Windows: rolling 7-day and 30-day windows starting every 1 day(s), both intrabar orderings; the 3 worst drawdowns, biggest rallies and highest-volatility windows per horizon (hourly starts, non-overlapping); synthetic GBM at 90% and 140% annual vol (10 seeds each). 1222 windows x 3 fee models x 31 demand/budget configs; runtime 1381 s.

Program parameters (asserted equal to the programs/forge defaults): floor 5%/yr on borrowed notional, m(u) = 1 + u to 60%, 1.6 + 6(u - 0.6) to the 80% cap, LP cap = budget - 1% keeper bounty, keeper trigger at 80% of the cap, restoration buffer 2%, swap slippage cap 0.5%. The event engine reproduces forge_math.lpsim.simulate_path exactly on identical borrows (max relative error 6.3e-14).

Fee models: **arb-band** = arbitrage only, pool follows the price only outside the 0.30% no-arbitrage band (conservative lower bound); **band+noise** = arb-band plus round-trip noise volume of 1x the LP's ladder value per day (an assumption; the in-range pool turns over ~2x a day); **arb** = Benchmark 3 / lpsim's model, fee on every 15 s path point, which gives fee APRs of hundreds of percent and is shown only for comparison.

Demand: `uXX-short|long` = borrowers take XX% of every borrowable (strictly out-of-range) bucket, re-borrow after ~1 h, hold 8 h (short) or 7 days (long) on average. Budgets: **funded** = every borrower funds 100% of notional (cap never binds); **realistic** = Benchmark 3 base: 90% fund max(3x expected floor, 1% of notional), 10% fund 0.5x expected floor; no keeper, every borrow runs its full hold; **realistic+keeper** = as realistic, but a keeper closes the position 5 min after accrued premium reaches 80% of the cap (the on-chain trigger); **min** = adversarial: every borrower funds the on-chain minimum (1 USDC atom); no keeper ever closes; **min+keeper** = adversarial minimum budget, with a keeper closing 5 min after the 80% trigger.

## hist-7d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 56.4% | 56.4% | 102.3% | 102.3% | 0.0% |
| u20-short | 596 | 25.0% | -3.6 | -26.4 | -55.8 | 97.3% | 2.5 | -3.2 | 56.4% | 56.0% | 102.3% | 100.5% | 16.9% |
| u20-long | 596 | 0.8% | -22.4 | -73.6 | -120.2 | 95.8% | 2.5 | -2.5 | 56.4% | 55.9% | 102.3% | 90.6% | 19.6% |
| u50-short | 596 | 23.7% | -8.0 | -67.1 | -161.8 | 97.1% | 6.2 | -5.2 | 56.4% | 56.0% | 102.3% | 97.4% | 42.3% |
| u50-long | 596 | 1.2% | -55.1 | -183.6 | -315.3 | 96.0% | 6.3 | -10.0 | 56.4% | 51.8% | 102.3% | 73.0% | 49.0% |
| u80-short | 596 | 70.1% | 16.1 | -63.0 | -212.7 | 100.0% | 71.1 | 13.2 | 56.4% | 58.6% | 102.3% | 112.8% | 67.7% |
| u80-long | 596 | 2.9% | -88.4 | -301.5 | -481.6 | 100.0% | 82.8 | 13.4 | 56.4% | 46.5% | 102.3% | 59.3% | 78.5% |

## hist-7d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 59.9% | 59.9% | 121.5% | 121.5% | 0.0% |
| u20-short | 596 | 23.2% | -4.5 | -29.1 | -59.8 | 98.7% | 3.5 | -2.1 | 59.9% | 59.9% | 121.5% | 118.6% | 16.9% |
| u20-long | 596 | 0.0% | -27.3 | -80.1 | -125.8 | 97.1% | 3.9 | -1.0 | 59.9% | 58.2% | 121.5% | 107.2% | 19.6% |
| u50-short | 596 | 21.8% | -10.7 | -72.6 | -175.0 | 98.8% | 9.0 | -4.7 | 59.9% | 59.6% | 121.5% | 115.1% | 42.3% |
| u50-long | 596 | 0.3% | -68.7 | -200.7 | -330.7 | 98.0% | 10.0 | -6.2 | 59.9% | 56.0% | 121.5% | 86.3% | 49.0% |
| u80-short | 596 | 62.8% | 11.5 | -79.4 | -227.3 | 100.0% | 79.7 | 13.8 | 59.9% | 61.7% | 121.5% | 130.2% | 67.7% |
| u80-long | 596 | 0.8% | -112.5 | -327.5 | -508.5 | 100.0% | 91.8 | 13.6 | 59.9% | 48.2% | 121.5% | 66.5% | 78.5% |

## hist-30d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 50.9% | 50.9% | 70.7% | 70.7% | 0.0% |
| u20-short | 550 | 20.9% | -11.0 | -60.4 | -96.3 | 91.1% | 8.2 | -14.2 | 50.9% | 50.9% | 70.7% | 69.8% | 17.3% |
| u20-long | 550 | 3.3% | -75.4 | -187.9 | -237.0 | 87.6% | 7.7 | -22.6 | 50.9% | 48.4% | 70.7% | 62.7% | 19.8% |
| u50-short | 550 | 20.5% | -25.4 | -142.9 | -239.2 | 91.6% | 20.6 | -44.6 | 50.9% | 50.2% | 70.7% | 67.8% | 43.2% |
| u50-long | 550 | 3.5% | -195.2 | -474.7 | -591.2 | 87.8% | 18.6 | -52.7 | 50.9% | 43.5% | 70.7% | 48.7% | 49.5% |
| u80-short | 550 | 67.6% | 35.0 | -132.9 | -310.6 | 100.0% | 206.4 | 32.7 | 50.9% | 52.5% | 70.7% | 76.9% | 69.0% |
| u80-long | 550 | 4.5% | -302.1 | -743.5 | -910.4 | 100.0% | 238.9 | 41.1 | 50.9% | 36.2% | 70.7% | 34.4% | 79.2% |

## hist-30d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 56.0% | 56.0% | 86.9% | 86.9% | 0.0% |
| u20-short | 550 | 18.5% | -13.4 | -67.1 | -107.3 | 93.1% | 10.5 | -13.4 | 56.0% | 54.9% | 86.9% | 84.7% | 17.3% |
| u20-long | 550 | 2.4% | -94.6 | -207.2 | -255.0 | 90.7% | 10.8 | -17.9 | 56.0% | 51.6% | 86.9% | 74.1% | 19.8% |
| u50-short | 550 | 18.2% | -31.5 | -160.2 | -255.0 | 93.6% | 26.9 | -37.1 | 56.0% | 54.2% | 86.9% | 81.4% | 43.2% |
| u50-long | 550 | 2.4% | -246.9 | -531.1 | -638.2 | 90.9% | 27.4 | -53.9 | 56.0% | 44.5% | 86.9% | 56.9% | 49.5% |
| u80-short | 550 | 62.0% | 24.6 | -168.7 | -337.7 | 100.0% | 232.5 | 32.8 | 56.0% | 55.6% | 86.9% | 91.0% | 69.0% |
| u80-long | 550 | 2.5% | -383.1 | -840.0 | -997.2 | 100.0% | 261.0 | 42.9 | 56.0% | 38.2% | 86.9% | 38.7% | 79.2% |

## Budget sensitivity: all historical windows, fee model arb-band

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 94.9% | 4.8 | -0.1 | -17.5 | -17.49 | 0 | 54.2% | 87.3% |
| u20-short | realistic | 23.0% | -5.6 | -46.2 | -96.3 | -96.33 | 1146 | 53.6% | 84.2% |
| u20-short | realistic+keeper | 94.3% | 3.7 | -0.5 | -14.2 | -14.22 | 1122 | 54.2% | 86.9% |
| u20-short | min | 0.0% | -39.3 | -159.4 | -213.4 | -213.37 | 1146 | 52.2% | 74.8% |
| u20-short | min+keeper | 2.1% | -0.5 | -3.2 | -7.7 | -7.71 | 1146 | 53.8% | 85.4% |
| u50-short | funded | 95.2% | 12.2 | 0.3 | -48.0 | -47.95 | 0 | 54.6% | 89.8% |
| u50-short | realistic | 22.2% | -12.8 | -119.4 | -239.2 | -239.18 | 1146 | 53.2% | 82.9% |
| u50-short | realistic+keeper | 94.5% | 9.4 | -1.2 | -44.6 | -44.64 | 1117 | 54.2% | 89.1% |
| u50-short | min | 0.0% | -96.9 | -398.4 | -561.8 | -561.84 | 1146 | 47.1% | 59.0% |
| u50-short | min+keeper | 2.6% | -1.4 | -8.0 | -14.9 | -14.91 | 1146 | 53.8% | 85.3% |
| u80-short | funded | 100.0% | 187.3 | 45.9 | 17.2 | 17.20 | 0 | 64.7% | 139.4% |
| u80-short | realistic | 68.9% | 20.7 | -100.1 | -310.6 | -310.64 | 1146 | 55.7% | 96.6% |
| u80-short | realistic+keeper | 100.0% | 108.3 | 32.2 | 13.2 | 13.22 | 1135 | 61.1% | 118.7% |
| u80-short | min | 0.0% | -156.0 | -642.2 | -924.1 | -924.06 | 1146 | 40.1% | 43.3% |
| u80-short | min+keeper | 2.3% | -2.0 | -12.0 | -23.1 | -23.06 | 1146 | 53.8% | 85.2% |
| u50-long | funded | 91.9% | 13.2 | -6.8 | -82.4 | -82.40 | 0 | 54.9% | 90.5% |
| u50-long | realistic | 2.3% | -92.1 | -426.6 | -591.2 | -591.20 | 1146 | 47.8% | 60.4% |
| u50-long | realistic+keeper | 92.1% | 8.9 | -3.9 | -52.7 | -52.74 | 992 | 54.2% | 89.1% |
| u50-long | min | 0.0% | -143.9 | -551.1 | -709.1 | -709.08 | 1146 | 41.1% | 45.5% |
| u50-long | min+keeper | 2.9% | -1.3 | -8.0 | -19.8 | -19.75 | 1146 | 53.8% | 85.3% |
| u80-long | funded | 100.0% | 261.7 | 73.6 | 19.9 | 19.94 | 0 | 67.8% | 162.4% |
| u80-long | realistic | 3.7% | -140.2 | -660.7 | -910.4 | -910.37 | 1146 | 41.5% | 46.5% |
| u80-long | realistic+keeper | 100.0% | 121.4 | 40.7 | 13.4 | 13.37 | 1108 | 61.5% | 124.2% |
| u80-long | min | 0.0% | -229.2 | -882.2 | -1,139.6 | -1,139.60 | 1146 | 27.1% | 20.8% |
| u80-long | min+keeper | 2.3% | -2.1 | -12.8 | -31.2 | -31.17 | 1146 | 53.7% | 84.9% |

## Budget sensitivity: all historical windows, fee model band+noise

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 96.2% | 6.5 | 1.0 | -16.5 | -16.48 | 0 | 58.7% | 106.4% |
| u20-short | realistic | 20.9% | -7.1 | -51.5 | -107.3 | -107.25 | 1146 | 57.5% | 103.3% |
| u20-short | realistic+keeper | 96.0% | 4.9 | 0.5 | -13.4 | -13.40 | 1122 | 58.6% | 105.9% |
| u20-short | min | 0.0% | -43.9 | -171.0 | -228.1 | -228.11 | 1146 | 55.5% | 92.7% |
| u20-short | min+keeper | 2.1% | -0.5 | -3.2 | -7.8 | -7.75 | 1146 | 57.9% | 104.3% |
| u50-short | funded | 96.3% | 16.5 | 2.6 | -45.2 | -45.16 | 0 | 59.1% | 109.8% |
| u50-short | realistic | 20.1% | -16.5 | -136.5 | -255.0 | -254.96 | 1146 | 57.0% | 101.2% |
| u50-short | realistic+keeper | 96.3% | 12.6 | 1.6 | -37.1 | -37.12 | 1115 | 58.8% | 108.7% |
| u50-short | min | 0.0% | -110.2 | -432.3 | -597.7 | -597.73 | 1146 | 50.7% | 74.2% |
| u50-short | min+keeper | 2.6% | -1.4 | -8.1 | -15.1 | -15.08 | 1146 | 57.8% | 104.2% |
| u80-short | funded | 100.0% | 222.0 | 62.7 | 22.4 | 22.35 | 0 | 68.5% | 168.6% |
| u80-short | realistic | 62.4% | 15.6 | -128.9 | -337.7 | -337.65 | 1146 | 58.8% | 111.6% |
| u80-short | realistic+keeper | 100.0% | 118.5 | 39.8 | 13.8 | 13.77 | 1139 | 64.2% | 140.4% |
| u80-short | min | 0.0% | -178.1 | -703.2 | -986.9 | -986.86 | 1146 | 44.9% | 53.7% |
| u80-short | min+keeper | 2.3% | -2.1 | -12.2 | -23.3 | -23.30 | 1146 | 57.8% | 103.9% |
| u50-long | funded | 94.0% | 20.6 | -1.2 | -77.9 | -77.89 | 0 | 59.2% | 111.6% |
| u50-long | realistic | 1.3% | -112.0 | -479.9 | -638.2 | -638.20 | 1146 | 50.5% | 72.2% |
| u50-long | realistic+keeper | 94.6% | 13.3 | -0.7 | -53.9 | -53.93 | 987 | 58.8% | 108.4% |
| u50-long | min | 0.0% | -162.6 | -605.5 | -757.0 | -757.04 | 1146 | 45.6% | 56.5% |
| u50-long | min+keeper | 2.9% | -1.4 | -8.1 | -19.8 | -19.83 | 1146 | 57.7% | 104.0% |
| u80-long | funded | 100.0% | 323.5 | 101.2 | 26.7 | 26.73 | 0 | 72.4% | 204.4% |
| u80-long | realistic | 1.7% | -173.3 | -752.2 | -997.2 | -997.23 | 1146 | 43.4% | 52.5% |
| u80-long | realistic+keeper | 100.0% | 131.8 | 46.6 | 13.6 | 13.65 | 1099 | 65.2% | 146.3% |
| u80-long | min | 0.0% | -263.0 | -983.2 | -1,224.0 | -1,224.00 | 1146 | 30.4% | 26.2% |
| u80-long | min+keeper | 2.3% | -2.2 | -12.9 | -31.4 | -31.45 | 1146 | 57.7% | 103.9% |

## Regimes: fee model arb-band, demand u50-short

| regime | n | median return | B >= A (realistic) | extra median bps | extra min bps | B >= A (+keeper) | A > HODL | B > HODL | A-HODL median bps | B-HODL median bps | APR A median | APR B median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gbm-30d-vol0.9 | 10 | -3.0% | 30.0% | -21.1 | -62.0 | 100.0% | 40.0% | 40.0% | -460.4 | -487.8 | 70.3% | 66.8% |
| gbm-30d-vol1.4 | 10 | 9.8% | 10.0% | -79.9 | -290.1 | 80.0% | 40.0% | 20.0% | -1,537.0 | -1,549.4 | 103.9% | 94.2% |
| gbm-7d-vol0.9 | 10 | 0.3% | 40.0% | -3.0 | -24.3 | 100.0% | 40.0% | 40.0% | -176.2 | -174.3 | 98.4% | 99.4% |
| gbm-7d-vol1.4 | 10 | -2.1% | 10.0% | -51.7 | -83.9 | 90.0% | 40.0% | 40.0% | -68.2 | -98.7 | 253.5% | 229.8% |
| hist-30d-all | 550 | 5.2% | 20.5% | -25.4 | -239.2 | 91.6% | 50.9% | 50.2% | 53.3 | 3.1 | 70.7% | 67.8% |
| hist-30d-best-decile-return | 56 | 52.2% | 19.6% | -42.2 | -219.3 | 48.2% | 0.0% | 0.0% | -1,604.4 | -1,657.9 | 52.2% | 48.6% |
| hist-30d-top-decile-vol | 56 | -19.8% | 1.8% | -108.5 | -239.2 | 94.6% | 50.0% | 42.9% | 5.0 | -100.7 | 121.7% | 107.1% |
| hist-30d-worst-decile-return | 56 | -26.4% | 19.6% | -26.9 | -146.6 | 100.0% | 0.0% | 0.0% | -647.6 | -682.8 | 64.4% | 61.0% |
| hist-7d-all | 596 | -0.1% | 23.7% | -8.0 | -161.8 | 97.1% | 56.4% | 56.0% | 64.5 | 60.8 | 102.3% | 97.4% |
| hist-7d-best-decile-return | 60 | 24.9% | 20.0% | -6.1 | -89.9 | 80.0% | 0.0% | 0.0% | -764.3 | -771.0 | 77.7% | 74.6% |
| hist-7d-top-decile-vol | 60 | -6.0% | 6.7% | -43.7 | -161.8 | 95.0% | 40.0% | 40.0% | -122.6 | -160.1 | 205.2% | 182.6% |
| hist-7d-worst-decile-return | 60 | -18.0% | 33.3% | -7.9 | -109.1 | 100.0% | 0.0% | 0.0% | -539.2 | -544.3 | 94.6% | 91.5% |
| hist-all | 1146 | 2.2% | 22.2% | -12.8 | -239.2 | 94.5% | 53.8% | 53.2% | 61.0 | 45.5 | 85.7% | 82.9% |
| stress-30d-drawdown | 6 | -39.4% | 33.3% | -13.6 | -69.0 | 100.0% | 0.0% | 0.0% | -1,691.1 | -1,704.7 | 60.6% | 58.9% |
| stress-30d-rally | 6 | 67.1% | 0.0% | -46.0 | -122.8 | 33.3% | 0.0% | 0.0% | -1,815.3 | -1,843.4 | 52.1% | 48.6% |
| stress-30d-vol | 6 | 20.7% | 0.0% | -84.4 | -147.3 | 100.0% | 33.3% | 33.3% | -185.8 | -266.0 | 101.6% | 91.9% |
| stress-7d-drawdown | 6 | -29.9% | 50.0% | -0.1 | -3.0 | 100.0% | 0.0% | 0.0% | -1,342.6 | -1,338.5 | 46.0% | 44.6% |
| stress-7d-rally | 6 | 43.1% | 16.7% | -5.7 | -23.6 | 83.3% | 0.0% | 0.0% | -1,459.1 | -1,464.1 | 59.4% | 53.1% |
| stress-7d-vol | 6 | -17.6% | 0.0% | -50.0 | -142.3 | 100.0% | 0.0% | 0.0% | -284.4 | -388.1 | 222.1% | 196.1% |

## Benchmark 3 fee model (arb) for comparison: all historical windows

| demand | budget | APR A median | APR B median | B >= A | extra median bps | extra min bps |
|---|---|---|---|---|---|---|
| none | - | 449.3% | 449.3% | 100.0% | 0.0 | 0.0 |
| u20-short | funded | 449.3% | 457.7% | 89.1% | 16.1 | -144.1 |
| u20-short | realistic | 449.3% | 416.1% | 0.0% | -152.3 | -941.6 |
| u20-short | realistic+keeper | 449.3% | 451.7% | 80.6% | 3.9 | -67.9 |
| u20-long | funded | 449.3% | 460.5% | 87.3% | 22.3 | -231.9 |
| u20-long | realistic | 449.3% | 372.7% | 0.0% | -282.8 | -1,542.8 |
| u20-long | realistic+keeper | 449.3% | 451.6% | 76.6% | 3.6 | -68.7 |
| u50-short | funded | 449.3% | 468.3% | 88.9% | 39.2 | -382.7 |
| u50-short | realistic | 449.3% | 361.5% | 0.0% | -371.7 | -2,347.9 |
| u50-short | realistic+keeper | 449.3% | 455.0% | 80.5% | 10.2 | -152.0 |
| u50-long | funded | 449.3% | 472.7% | 87.3% | 55.7 | -556.8 |
| u50-long | realistic | 449.3% | 257.0% | 0.0% | -702.8 | -3,843.6 |
| u50-long | realistic+keeper | 449.3% | 455.1% | 75.0% | 8.8 | -176.7 |
| u80-short | funded | 449.3% | 723.3% | 100.0% | 959.0 | 53.3 |
| u80-short | realistic | 449.3% | 310.6% | 0.1% | -581.3 | -3,798.2 |
| u80-short | realistic+keeper | 449.3% | 508.6% | 100.0% | 176.7 | 13.1 |
| u80-long | funded | 449.3% | 841.4% | 100.0% | 1,318.3 | 126.0 |
| u80-long | realistic | 449.3% | 141.1% | 0.0% | -1,125.6 | -6,249.2 |
| u80-long | realistic+keeper | 449.3% | 514.3% | 100.0% | 185.7 | 20.3 |

## Failure modes: FORGE LP < plain Orca LP

Cases = windows x the 6 demand levels, over every regime (historical, stress, GBM). Causes: **shortfall** = the gap closes if the premium above the borrower's capped budget had been paid; **in-kind** = the premium covered the forgone fees at the prices when they accrued, but plain Orca's fees are kept in kind and the base-token part was worth more at the window-end price; **other** = neither alone explains it. Accrual-time guarantee violations (fully funded borrow whose premium is below its forgone fees at accrual prices) are counted separately and must be 0.

| fee model | budget | cases | B < A | shortfall | in-kind | other | accrual-time violations | worst bps | worst USD | worst case |
|---|---|---|---|---|---|---|---|---|---|---|
| arb-band | funded | 7332 | 359 | 0 | 359 | 0 | 0 | -220.3 | -220.34 | u50-long gbm-30d-vol1.4-s20265527 |
| arb-band | realistic | 7332 | 5841 | 5520 | 6 | 315 | 0 | -1,173.1 | -1,173.15 | u80-long gbm-30d-vol1.4-s20265535 |
| arb-band | realistic+keeper | 7332 | 361 | 109 | 252 | 0 | 0 | -122.7 | -122.73 | u50-long gbm-30d-vol1.4-s20265527 |
| arb-band | min | 7332 | 7332 | 7031 | 0 | 301 | 0 | -1,418.3 | -1,418.33 | u80-long gbm-30d-vol1.4-s20265533 |
| arb-band | min+keeper | 7332 | 7144 | 7134 | 0 | 10 | 0 | -31.2 | -31.17 | u80-long hist-30d-2026-02-01T00:00-HL |
| band+noise | funded | 7332 | 273 | 0 | 273 | 0 | 0 | -227.5 | -227.45 | u50-long gbm-30d-vol1.4-s20265527 |
| band+noise | realistic | 7332 | 6018 | 5785 | 0 | 233 | 0 | -1,275.6 | -1,275.61 | u80-long gbm-30d-vol1.4-s20265535 |
| band+noise | realistic+keeper | 7332 | 252 | 80 | 172 | 0 | 0 | -111.1 | -111.10 | u50-long gbm-30d-vol1.4-s20265527 |
| band+noise | min | 7332 | 7332 | 7123 | 0 | 209 | 0 | -1,520.3 | -1,520.31 | u80-long gbm-30d-vol1.4-s20265533 |
| band+noise | min+keeper | 7332 | 7144 | 7135 | 0 | 9 | 0 | -31.4 | -31.45 | u80-long hist-30d-2026-02-01T00:00-HL |
| arb | funded | 7332 | 640 | 5 | 633 | 2 | 0 | -778.5 | -778.50 | u50-long gbm-30d-vol1.4-s20265527 |
| arb | realistic | 7332 | 7331 | 6755 | 0 | 576 | 0 | -6,249.2 | -6,249.16 | u80-long hist-30d-2026-09-26T00:00-HL |
| arb | realistic+keeper | 7332 | 1091 | 631 | 454 | 6 | 0 | -235.5 | -235.53 | u50-short gbm-30d-vol1.4-s20265527 |
| arb | min | 7332 | 7332 | 6766 | 0 | 566 | 0 | -6,442.1 | -6,442.11 | u80-long hist-30d-2026-09-26T00:00-HL |
| arb | min+keeper | 7332 | 7314 | 7185 | 0 | 129 | 0 | -84.4 | -84.38 | u80-long hist-30d-2026-01-13T00:00-LH |

Restoration refusals (swap cost above the 0.5% slippage cap; retried after 1 h): 597 over all runs. They delay restoration; they never reduce the LP's liquidity.

Every number (all regimes x fee models x demand x budgets, per-config failure lists, per-window values for realistic budgets) is in lp_profitability.json.

Model notes:

- Simulator: forge_math.lpsim's event engine (fee_growth, settle_borrows, simulate_demand), which follows the program: floor on the notional stored at open (calls at the open reference price), LP cap = budget less the 1% bounty, keeper close 5 min after accrued premium reaches 80% of the cap (budgets *+keeper), restoration refused above the 0.5% slippage cap or the escrow margin and retried after 1 h.
- Demand sweep (this benchmark's choice): utilization fixed per demand level (0.2 / 0.5 / 0.8) and borrowers return ~1 h after a bucket frees up, instead of Benchmark 3's random uniform(0.2, 0.8) borrowers.
- Fee models: 'arb-band' and 'band+noise' run on the no-arbitrage-band pool path computed over the whole history (Benchmark 3 starts the band at each window's first price; the pool start differs by < 0.3%); 'arb' is lpsim's legacy-every-price model, kept for comparison.
- Noise volume is a multiple of the LP ladder's starting value (lpsim fixed the extra sqrt(P0) factor that earlier Benchmark 3 runs carried).
