# Benchmark 4: is providing liquidity through FORGE profitable? (JUP/USDC)

Historical-price-driven simulation: Binance JUPUSDC 1-minute bars (2026-01-01 to 2026-10-31) drive a simulated Orca pool (fee 0.30%, buckets of 256 ticks, 8-bucket ladder centred on each window's start price, the LP is 25% of active liquidity). This is not a replay of real Orca swaps or of real FORGE borrowing: fees come from simulated arbitrage (and optional noise volume) along the historical price path, and borrow demand and budgets are assumptions, swept below. Each window deploys $10,000; bps are of starting capital. A = plain Orca LP, B = FORGE LP, HODL = hold the starting tokens; all valued at the window-end price (fees in kind, premium in USDC).

Windows: rolling 7-day and 30-day windows starting every 1 day(s), both intrabar orderings; the 3 worst drawdowns, biggest rallies and highest-volatility windows per horizon (hourly starts, non-overlapping); synthetic GBM at 90% and 140% annual vol (10 seeds each). 1222 windows x 3 fee models x 31 demand/budget configs; runtime 1105 s.

Program parameters (asserted equal to the programs/forge defaults): floor 5%/yr on borrowed notional, m(u) = 1 + u to 60%, 1.6 + 6(u - 0.6) to the 80% cap, LP cap = budget - 1% keeper bounty, keeper trigger at 80% of the cap, restoration buffer 2%, swap slippage cap 0.5%. The event engine reproduces forge_math.lpsim.simulate_path exactly on identical borrows (max relative error 6.3e-14).

Fee models: **arb-band** = arbitrage only, pool follows the price only outside the 0.30% no-arbitrage band (conservative lower bound); **band+noise** = arb-band plus round-trip noise volume of 1x the LP's ladder value per day (an assumption; the in-range pool turns over ~2x a day); **arb** = Benchmark 3 / lpsim's model, fee on every 15 s path point, which gives fee APRs of hundreds of percent and is shown only for comparison.

Demand: `uXX-short|long` = borrowers take XX% of every borrowable (strictly out-of-range) bucket, re-borrow after ~1 h, hold 8 h (short) or 7 days (long) on average. Budgets: **funded** = every borrower funds 100% of notional (cap never binds); **realistic** = Benchmark 3 base: 90% fund max(3x expected floor, 1% of notional), 10% fund 0.5x expected floor; no keeper, every borrow runs its full hold; **realistic+keeper** = as realistic, but a keeper closes the position 5 min after accrued premium reaches 80% of the cap (the on-chain trigger); **min** = adversarial: every borrower funds the on-chain minimum (1 USDC atom); no keeper ever closes; **min+keeper** = adversarial minimum budget, with a keeper closing 5 min after the 80% trigger.

## hist-7d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 56.4% | 56.4% | 102.3% | 102.3% | 0.0% |
| u20-short | 596 | 33.1% | -2.3 | -24.7 | -54.2 | 99.7% | 4.7 | -1.7 | 56.4% | 56.2% | 102.3% | 101.1% | 16.9% |
| u20-long | 596 | 1.7% | -22.0 | -73.2 | -120.0 | 99.8% | 5.1 | -0.1 | 56.4% | 55.9% | 102.3% | 90.8% | 19.6% |
| u50-short | 596 | 54.7% | 1.6 | -52.4 | -149.4 | 99.8% | 24.4 | -0.1 | 56.4% | 56.4% | 102.3% | 102.6% | 42.3% |
| u50-long | 596 | 2.0% | -53.1 | -182.0 | -313.8 | 100.0% | 27.4 | 3.0 | 56.4% | 52.2% | 102.3% | 74.2% | 49.0% |
| u80-short | 596 | 79.4% | 24.8 | -55.2 | -199.6 | 100.0% | 96.5 | 17.5 | 56.4% | 59.4% | 102.3% | 118.3% | 67.7% |
| u80-long | 596 | 3.7% | -86.4 | -301.2 | -480.8 | 100.0% | 110.1 | 28.5 | 56.4% | 46.6% | 102.3% | 60.2% | 78.5% |

## hist-7d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 59.9% | 59.9% | 121.5% | 121.5% | 0.0% |
| u20-short | 596 | 31.0% | -3.1 | -27.1 | -58.3 | 99.8% | 5.9 | -0.4 | 59.9% | 59.9% | 121.5% | 119.4% | 16.9% |
| u20-long | 596 | 0.7% | -26.9 | -79.8 | -125.5 | 99.8% | 6.6 | -0.0 | 59.9% | 58.2% | 121.5% | 107.4% | 19.6% |
| u50-short | 596 | 49.3% | -0.2 | -59.2 | -160.5 | 100.0% | 28.5 | 5.0 | 59.9% | 60.1% | 121.5% | 120.9% | 42.3% |
| u50-long | 596 | 1.3% | -66.8 | -200.0 | -329.1 | 100.0% | 32.9 | 4.9 | 59.9% | 56.2% | 121.5% | 87.0% | 49.0% |
| u80-short | 596 | 71.5% | 20.3 | -67.8 | -213.4 | 100.0% | 107.5 | 16.6 | 59.9% | 62.4% | 121.5% | 136.3% | 67.7% |
| u80-long | 596 | 1.3% | -110.5 | -326.4 | -507.6 | 100.0% | 121.2 | 24.1 | 59.9% | 48.3% | 121.5% | 67.3% | 78.5% |

## hist-30d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 50.9% | 50.9% | 70.7% | 70.7% | 0.0% |
| u20-short | 550 | 31.5% | -7.0 | -55.6 | -91.0 | 99.1% | 14.0 | -6.5 | 50.9% | 50.9% | 70.7% | 70.2% | 17.3% |
| u20-long | 550 | 3.8% | -74.6 | -187.2 | -236.8 | 97.1% | 14.9 | -11.2 | 50.9% | 48.4% | 70.7% | 62.9% | 19.8% |
| u50-short | 550 | 50.5% | 0.6 | -101.7 | -200.3 | 100.0% | 69.3 | 19.6 | 50.9% | 51.3% | 70.7% | 71.8% | 43.2% |
| u50-long | 550 | 4.2% | -190.9 | -472.6 | -589.0 | 100.0% | 79.1 | 16.8 | 50.9% | 43.5% | 70.7% | 49.0% | 49.5% |
| u80-short | 550 | 76.7% | 55.4 | -103.5 | -271.0 | 100.0% | 284.7 | 47.8 | 50.9% | 53.8% | 70.7% | 80.9% | 69.0% |
| u80-long | 550 | 5.3% | -298.8 | -741.6 | -903.8 | 100.0% | 323.5 | 43.6 | 50.9% | 36.4% | 70.7% | 34.9% | 79.2% |

## hist-30d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 56.0% | 56.0% | 86.9% | 86.9% | 0.0% |
| u20-short | 550 | 27.3% | -9.7 | -62.3 | -101.7 | 99.6% | 17.6 | -2.8 | 56.0% | 55.3% | 86.9% | 85.1% | 17.3% |
| u20-long | 550 | 2.5% | -93.6 | -206.9 | -254.8 | 98.9% | 19.3 | -8.7 | 56.0% | 51.6% | 86.9% | 74.2% | 19.8% |
| u50-short | 550 | 45.6% | -4.3 | -118.1 | -215.8 | 100.0% | 82.1 | 19.3 | 56.0% | 54.7% | 86.9% | 85.5% | 43.2% |
| u50-long | 550 | 2.4% | -241.9 | -527.2 | -635.8 | 100.0% | 91.6 | 17.8 | 56.0% | 44.7% | 86.9% | 57.6% | 49.5% |
| u80-short | 550 | 70.7% | 46.0 | -137.8 | -301.8 | 100.0% | 316.9 | 49.0 | 56.0% | 56.7% | 86.9% | 94.8% | 69.0% |
| u80-long | 550 | 2.7% | -381.0 | -837.7 | -990.0 | 100.0% | 352.3 | 44.0 | 56.0% | 38.2% | 86.9% | 39.1% | 79.2% |

## Budget sensitivity: all historical windows, fee model arb-band

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 99.7% | 8.8 | 2.8 | -6.5 | -6.47 | 0 | 54.2% | 88.7% |
| u20-short | realistic | 32.3% | -3.4 | -42.4 | -91.0 | -90.99 | 1146 | 53.7% | 84.9% |
| u20-short | realistic+keeper | 99.4% | 7.3 | 2.4 | -6.5 | -6.46 | 1124 | 54.2% | 87.8% |
| u20-short | min | 0.0% | -39.3 | -159.4 | -213.4 | -213.37 | 1146 | 52.2% | 74.8% |
| u20-short | min+keeper | 2.1% | -0.5 | -3.2 | -7.7 | -7.71 | 1146 | 53.8% | 85.4% |
| u50-short | funded | 100.0% | 51.8 | 15.4 | 7.3 | 7.35 | 0 | 56.8% | 101.4% |
| u50-short | realistic | 52.7% | 1.4 | -86.8 | -200.3 | -200.26 | 1146 | 53.9% | 88.5% |
| u50-short | realistic+keeper | 99.9% | 36.9 | 12.0 | -0.1 | -0.08 | 1125 | 56.0% | 97.5% |
| u50-short | min | 0.0% | -96.9 | -398.4 | -561.8 | -561.84 | 1146 | 47.1% | 59.0% |
| u50-short | min+keeper | 2.6% | -1.4 | -8.0 | -14.9 | -14.91 | 1146 | 53.8% | 85.3% |
| u80-short | funded | 100.0% | 287.8 | 67.6 | 24.0 | 24.02 | 0 | 68.5% | 166.1% |
| u80-short | realistic | 78.1% | 32.9 | -81.3 | -271.0 | -271.04 | 1146 | 56.7% | 101.4% |
| u80-short | realistic+keeper | 100.0% | 147.0 | 45.5 | 17.5 | 17.47 | 1142 | 62.7% | 129.6% |
| u80-short | min | 0.0% | -156.0 | -642.2 | -924.1 | -924.06 | 1146 | 40.1% | 43.3% |
| u80-short | min+keeper | 2.3% | -2.0 | -12.0 | -23.1 | -23.06 | 1146 | 53.8% | 85.2% |
| u50-long | funded | 100.0% | 69.0 | 21.8 | 7.8 | 7.81 | 0 | 58.7% | 107.2% |
| u50-long | realistic | 3.1% | -89.6 | -422.3 | -589.0 | -589.00 | 1146 | 48.0% | 61.3% |
| u50-long | realistic+keeper | 100.0% | 39.8 | 14.3 | 3.0 | 3.05 | 1037 | 56.3% | 98.9% |
| u50-long | min | 0.0% | -143.9 | -551.1 | -709.1 | -709.08 | 1146 | 41.1% | 45.5% |
| u50-long | min+keeper | 2.9% | -1.3 | -8.0 | -19.8 | -19.75 | 1146 | 53.8% | 85.3% |
| u80-long | funded | 100.0% | 404.3 | 109.8 | 28.5 | 28.52 | 0 | 72.7% | 203.4% |
| u80-long | realistic | 4.5% | -138.2 | -659.9 | -903.8 | -903.82 | 1146 | 41.7% | 47.2% |
| u80-long | realistic+keeper | 100.0% | 159.6 | 54.2 | 28.5 | 28.47 | 1120 | 63.7% | 136.2% |
| u80-long | min | 0.0% | -229.2 | -882.2 | -1,139.6 | -1,139.60 | 1146 | 27.1% | 20.8% |
| u80-long | min+keeper | 2.3% | -2.1 | -12.8 | -31.2 | -31.17 | 1146 | 53.7% | 84.9% |

## Budget sensitivity: all historical windows, fee model band+noise

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 99.8% | 11.1 | 3.7 | -4.5 | -4.47 | 0 | 58.8% | 107.8% |
| u20-short | realistic | 29.2% | -4.8 | -47.1 | -101.7 | -101.65 | 1146 | 57.7% | 104.2% |
| u20-short | realistic+keeper | 99.7% | 8.4 | 3.0 | -2.8 | -2.82 | 1124 | 58.6% | 107.1% |
| u20-short | min | 0.0% | -43.9 | -171.0 | -228.1 | -228.11 | 1146 | 55.5% | 92.7% |
| u20-short | min+keeper | 2.1% | -0.5 | -3.2 | -7.8 | -7.75 | 1146 | 57.9% | 104.3% |
| u50-short | funded | 100.0% | 62.7 | 20.6 | 8.8 | 8.79 | 0 | 61.4% | 122.8% |
| u50-short | realistic | 47.6% | -1.3 | -101.8 | -215.8 | -215.77 | 1146 | 57.5% | 106.4% |
| u50-short | realistic+keeper | 100.0% | 41.7 | 14.8 | 5.0 | 5.01 | 1123 | 60.1% | 117.2% |
| u50-short | min | 0.0% | -110.2 | -432.3 | -597.7 | -597.73 | 1146 | 50.7% | 74.2% |
| u50-short | min+keeper | 2.6% | -1.4 | -8.1 | -15.1 | -15.08 | 1146 | 57.8% | 104.2% |
| u80-short | funded | 100.0% | 335.2 | 91.8 | 31.5 | 31.52 | 0 | 72.5% | 201.8% |
| u80-short | realistic | 71.1% | 27.5 | -103.6 | -301.8 | -301.84 | 1146 | 59.7% | 116.0% |
| u80-short | realistic+keeper | 100.0% | 161.2 | 53.7 | 16.6 | 16.55 | 1141 | 66.6% | 153.6% |
| u80-short | min | 0.0% | -178.1 | -703.2 | -986.9 | -986.86 | 1146 | 44.9% | 53.7% |
| u80-short | min+keeper | 2.3% | -2.1 | -12.2 | -23.3 | -23.30 | 1146 | 57.8% | 103.9% |
| u50-long | funded | 100.0% | 86.7 | 29.6 | 11.9 | 11.87 | 0 | 63.3% | 132.0% |
| u50-long | realistic | 1.8% | -109.3 | -476.0 | -635.8 | -635.83 | 1146 | 50.7% | 72.8% |
| u50-long | realistic+keeper | 100.0% | 46.2 | 17.8 | 4.9 | 4.91 | 1041 | 60.5% | 119.5% |
| u50-long | min | 0.0% | -162.6 | -605.5 | -757.0 | -757.04 | 1146 | 45.6% | 56.5% |
| u50-long | min+keeper | 2.9% | -1.4 | -8.1 | -19.8 | -19.83 | 1146 | 57.7% | 104.0% |
| u80-long | funded | 100.0% | 488.8 | 152.5 | 38.4 | 38.41 | 0 | 76.8% | 255.9% |
| u80-long | realistic | 2.0% | -172.2 | -750.2 | -990.0 | -989.98 | 1146 | 43.5% | 53.1% |
| u80-long | realistic+keeper | 100.0% | 176.6 | 62.6 | 24.1 | 24.07 | 1123 | 67.4% | 159.8% |
| u80-long | min | 0.0% | -263.0 | -983.2 | -1,224.0 | -1,224.00 | 1146 | 30.4% | 26.2% |
| u80-long | min+keeper | 2.3% | -2.2 | -12.9 | -31.4 | -31.45 | 1146 | 57.7% | 103.9% |

## Regimes: fee model arb-band, demand u50-short

| regime | n | median return | B >= A (realistic) | extra median bps | extra min bps | B >= A (+keeper) | A > HODL | B > HODL | A-HODL median bps | B-HODL median bps | APR A median | APR B median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gbm-30d-vol0.9 | 10 | -3.0% | 70.0% | 11.7 | -10.9 | 100.0% | 40.0% | 40.0% | -460.4 | -462.5 | 70.3% | 71.1% |
| gbm-30d-vol1.4 | 10 | 9.8% | 40.0% | -52.6 | -225.8 | 90.0% | 40.0% | 30.0% | -1,537.0 | -1,522.2 | 103.9% | 98.2% |
| gbm-7d-vol0.9 | 10 | 0.3% | 90.0% | 4.2 | -8.6 | 100.0% | 40.0% | 40.0% | -176.2 | -162.2 | 98.4% | 105.7% |
| gbm-7d-vol1.4 | 10 | -2.1% | 20.0% | -28.6 | -65.8 | 100.0% | 40.0% | 40.0% | -68.2 | -75.1 | 253.5% | 239.5% |
| hist-30d-all | 550 | 5.2% | 50.5% | 0.6 | -200.3 | 100.0% | 50.9% | 51.3% | 53.3 | 26.3 | 70.7% | 71.8% |
| hist-30d-best-decile-return | 56 | 52.2% | 35.7% | -27.7 | -191.0 | 100.0% | 0.0% | 0.0% | -1,604.4 | -1,638.2 | 52.2% | 51.2% |
| hist-30d-top-decile-vol | 56 | -19.8% | 7.1% | -81.4 | -200.3 | 100.0% | 50.0% | 46.4% | 5.0 | -65.1 | 121.7% | 111.1% |
| hist-30d-worst-decile-return | 56 | -26.4% | 39.3% | -5.4 | -108.7 | 100.0% | 0.0% | 0.0% | -647.6 | -662.0 | 64.4% | 63.5% |
| hist-7d-all | 596 | -0.1% | 54.7% | 1.6 | -149.4 | 99.8% | 56.4% | 56.4% | 64.5 | 70.0 | 102.3% | 102.6% |
| hist-7d-best-decile-return | 60 | 24.9% | 46.7% | -0.9 | -79.5 | 98.3% | 0.0% | 0.0% | -764.3 | -760.5 | 77.7% | 80.0% |
| hist-7d-top-decile-vol | 60 | -6.0% | 13.3% | -26.1 | -149.4 | 100.0% | 40.0% | 40.0% | -122.6 | -149.1 | 205.2% | 189.2% |
| hist-7d-worst-decile-return | 60 | -18.0% | 51.7% | 0.4 | -100.0 | 100.0% | 0.0% | 0.0% | -539.2 | -537.2 | 94.6% | 96.4% |
| hist-all | 1146 | 2.2% | 52.7% | 1.4 | -200.3 | 99.9% | 53.8% | 53.9% | 61.0 | 64.8 | 85.7% | 88.5% |
| stress-30d-drawdown | 6 | -39.4% | 83.3% | 4.5 | -31.7 | 100.0% | 0.0% | 0.0% | -1,691.1 | -1,687.1 | 60.6% | 61.1% |
| stress-30d-rally | 6 | 67.1% | 16.7% | -32.6 | -87.0 | 100.0% | 0.0% | 0.0% | -1,815.3 | -1,817.5 | 52.1% | 51.8% |
| stress-30d-vol | 6 | 20.7% | 16.7% | -58.8 | -103.1 | 100.0% | 33.3% | 33.3% | -185.8 | -238.9 | 101.6% | 95.2% |
| stress-7d-drawdown | 6 | -29.9% | 100.0% | 2.6 | 0.3 | 100.0% | 0.0% | 0.0% | -1,342.6 | -1,335.6 | 46.0% | 46.2% |
| stress-7d-rally | 6 | 43.1% | 33.3% | -2.6 | -21.7 | 100.0% | 0.0% | 0.0% | -1,459.1 | -1,459.4 | 59.4% | 54.7% |
| stress-7d-vol | 6 | -17.6% | 0.0% | -32.7 | -130.6 | 100.0% | 0.0% | 0.0% | -284.4 | -380.0 | 222.1% | 205.1% |

## Benchmark 3 fee model (arb) for comparison: all historical windows

| demand | budget | APR A median | APR B median | B >= A | extra median bps | extra min bps |
|---|---|---|---|---|---|---|
| none | - | 449.3% | 449.3% | 100.0% | 0.0 | 0.0 |
| u20-short | funded | 449.3% | 463.4% | 96.9% | 37.6 | -72.6 |
| u20-short | realistic | 449.3% | 416.8% | 0.0% | -151.2 | -938.5 |
| u20-short | realistic+keeper | 449.3% | 453.4% | 94.0% | 9.5 | -43.0 |
| u20-long | funded | 449.3% | 470.0% | 95.5% | 53.0 | -158.7 |
| u20-long | realistic | 449.3% | 372.8% | 0.0% | -282.4 | -1,542.3 |
| u20-long | realistic+keeper | 449.3% | 453.8% | 92.4% | 9.3 | -48.6 |
| u50-short | funded | 449.3% | 526.0% | 100.0% | 249.2 | 19.2 |
| u50-short | realistic | 449.3% | 364.4% | 0.0% | -360.2 | -2,330.0 |
| u50-short | realistic+keeper | 449.3% | 471.5% | 100.0% | 58.1 | 5.1 |
| u50-long | funded | 449.3% | 558.6% | 100.0% | 352.9 | 41.3 |
| u50-long | realistic | 449.3% | 257.2% | 0.0% | -701.7 | -3,843.1 |
| u50-long | realistic+keeper | 449.3% | 473.2% | 100.0% | 60.1 | 4.8 |
| u80-short | funded | 449.3% | 869.6% | 100.0% | 1,489.4 | 81.9 |
| u80-short | realistic | 449.3% | 313.5% | 0.2% | -573.3 | -3,774.6 |
| u80-short | realistic+keeper | 449.3% | 523.9% | 100.0% | 222.9 | 16.7 |
| u80-long | funded | 449.3% | 1029.3% | 100.0% | 2,004.9 | 189.2 |
| u80-long | realistic | 449.3% | 141.7% | 0.0% | -1,125.5 | -6,248.6 |
| u80-long | realistic+keeper | 449.3% | 530.7% | 100.0% | 235.8 | 25.3 |

## Failure modes: FORGE LP < plain Orca LP

Cases = windows x the 6 demand levels, over every regime (historical, stress, GBM). Causes: **shortfall** = the gap closes if the premium above the borrower's capped budget had been paid; **in-kind** = the premium covered the forgone fees at the prices when they accrued, but plain Orca's fees are kept in kind and the base-token part was worth more at the window-end price; **other** = neither alone explains it. Accrual-time guarantee violations (fully funded borrow whose premium is below its forgone fees at accrual prices) are counted separately and must be 0.

| fee model | budget | cases | B < A | shortfall | in-kind | other | accrual-time violations | worst bps | worst USD | worst case |
|---|---|---|---|---|---|---|---|---|---|---|
| arb-band | funded | 7332 | 24 | 0 | 24 | 0 | 0 | -77.2 | -77.19 | u50-long gbm-30d-vol1.4-s20265527 |
| arb-band | realistic | 7332 | 5216 | 5192 | 0 | 24 | 0 | -1,170.4 | -1,170.36 | u80-long gbm-30d-vol1.4-s20265535 |
| arb-band | realistic+keeper | 7332 | 33 | 17 | 16 | 0 | 0 | -40.6 | -40.65 | u20-long gbm-30d-vol1.4-s20265527 |
| arb-band | min | 7332 | 7332 | 7308 | 0 | 24 | 0 | -1,418.3 | -1,418.33 | u80-long gbm-30d-vol1.4-s20265533 |
| arb-band | min+keeper | 7332 | 7144 | 7143 | 0 | 1 | 0 | -31.2 | -31.17 | u80-long hist-30d-2026-02-01T00:00-HL |
| band+noise | funded | 7332 | 16 | 0 | 16 | 0 | 0 | -71.9 | -71.90 | u50-long gbm-30d-vol1.4-s20265527 |
| band+noise | realistic | 7332 | 5466 | 5450 | 0 | 16 | 0 | -1,273.3 | -1,273.33 | u80-long gbm-30d-vol1.4-s20265535 |
| band+noise | realistic+keeper | 7332 | 18 | 5 | 13 | 0 | 0 | -38.4 | -38.38 | u20-long gbm-30d-vol1.4-s20265527 |
| band+noise | min | 7332 | 7332 | 7316 | 0 | 16 | 0 | -1,520.3 | -1,520.31 | u80-long gbm-30d-vol1.4-s20265533 |
| band+noise | min+keeper | 7332 | 7144 | 7143 | 0 | 1 | 0 | -31.4 | -31.45 | u80-long hist-30d-2026-02-01T00:00-HL |
| arb | funded | 7332 | 106 | 7 | 99 | 0 | 0 | -297.9 | -297.87 | u50-long gbm-30d-vol1.4-s20265527 |
| arb | realistic | 7332 | 7330 | 7231 | 0 | 99 | 0 | -6,248.6 | -6,248.59 | u80-long hist-30d-2026-09-26T00:00-HL |
| arb | realistic+keeper | 7332 | 183 | 140 | 43 | 0 | 0 | -77.5 | -77.53 | u20-long gbm-30d-vol1.4-s20265527 |
| arb | min | 7332 | 7332 | 7233 | 0 | 99 | 0 | -6,442.1 | -6,442.11 | u80-long hist-30d-2026-09-26T00:00-HL |
| arb | min+keeper | 7332 | 7314 | 7301 | 0 | 13 | 0 | -84.4 | -84.38 | u80-long hist-30d-2026-01-13T00:00-LH |

Restoration refusals (swap cost above the 0.5% slippage cap; retried after 1 h): 608 over all runs. They delay restoration; they never reduce the LP's liquidity.

Every number (all regimes x fee models x demand x budgets, per-config failure lists, per-window values for realistic budgets) is in lp_profitability.json.

Model notes:

- Simulator: forge_math.lpsim's event engine (fee_growth, settle_borrows, simulate_demand), which follows the program: floor on the notional stored at open (calls at the open reference price), LP cap = budget less the 1% bounty, keeper close 5 min after accrued premium reaches 80% of the cap (budgets *+keeper), restoration refused above the 0.5% slippage cap or the escrow margin and retried after 1 h.
- Demand sweep (this benchmark's choice): utilization fixed per demand level (0.2 / 0.5 / 0.8) and borrowers return ~1 h after a bucket frees up, instead of Benchmark 3's random uniform(0.2, 0.8) borrowers.
- Fee models: 'arb-band' and 'band+noise' run on the no-arbitrage-band pool path computed over the whole history (Benchmark 3 starts the band at each window's first price; the pool start differs by < 0.3%); 'arb' is lpsim's legacy-every-price model, kept for comparison.
- Noise volume is a multiple of the LP ladder's starting value (lpsim fixed the extra sqrt(P0) factor that earlier Benchmark 3 runs carried).
