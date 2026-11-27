# Benchmark 4: is providing liquidity through FORGE profitable? (SOL/USDC)

Historical-price-driven simulation: Binance SOLUSDC 1-minute bars (2026-01-01 to 2026-10-31) drive a simulated Orca pool (fee 0.30%, buckets of 256 ticks, 8-bucket ladder centred on each window's start price, the LP is 25% of active liquidity). This is not a replay of real Orca swaps or of real FORGE borrowing: fees come from simulated arbitrage (and optional noise volume) along the historical price path, and borrow demand and budgets are assumptions, swept below. Each window deploys $10,000; bps are of starting capital. A = plain Orca LP, B = FORGE LP, HODL = hold the starting tokens; all valued at the window-end price (fees in kind, premium in USDC).

Windows: rolling 7-day and 30-day windows starting every 1 day(s), both intrabar orderings; the 3 worst drawdowns, biggest rallies and highest-volatility windows per horizon (hourly starts, non-overlapping); synthetic GBM at 90% and 140% annual vol (10 seeds each). 1222 windows x 3 fee models x 31 demand/budget configs; runtime 1544 s.

Program parameters (asserted equal to the programs/forge defaults): floor 5%/yr on borrowed notional, m(u) = 1 + u to 60%, 1.6 + 6(u - 0.6) to the 80% cap, LP cap = budget - 1% keeper bounty, keeper trigger at 80% of the cap, restoration buffer 2%, swap slippage cap 0.5%. The event engine reproduces forge_math.lpsim.simulate_path exactly on identical borrows (max relative error 4.1e-14).

Fee models: **arb-band** = arbitrage only, pool follows the price only outside the 0.30% no-arbitrage band (conservative lower bound); **band+noise** = arb-band plus round-trip noise volume of 1x the LP's ladder value per day (an assumption; the in-range pool turns over ~2x a day); **arb** = Benchmark 3 / lpsim's model, fee on every 15 s path point, which gives fee APRs of hundreds of percent and is shown only for comparison.

Demand: `uXX-short|long` = borrowers take XX% of every borrowable (strictly out-of-range) bucket, re-borrow after ~1 h, hold 8 h (short) or 7 days (long) on average. Budgets: **funded** = every borrower funds 100% of notional (cap never binds); **realistic** = Benchmark 3 base: 90% fund max(3x expected floor, 1% of notional), 10% fund 0.5x expected floor; no keeper, every borrow runs its full hold; **realistic+keeper** = as realistic, but a keeper closes the position 5 min after accrued premium reaches 80% of the cap (the on-chain trigger); **min** = adversarial: every borrower funds the on-chain minimum (1 USDC atom); no keeper ever closes; **min+keeper** = adversarial minimum budget, with a keeper closing 5 min after the 80% trigger.

## hist-7d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 66.6% | 66.6% | 62.0% | 62.0% | 0.0% |
| u20-short | 596 | 50.5% | 0.0 | -9.1 | -22.5 | 99.0% | 2.0 | -3.0 | 66.6% | 66.4% | 62.0% | 62.5% | 16.5% |
| u20-long | 596 | 4.7% | -10.5 | -38.0 | -63.6 | 99.2% | 2.2 | -2.3 | 66.6% | 65.3% | 62.0% | 57.1% | 19.5% |
| u50-short | 596 | 53.2% | 0.5 | -23.0 | -67.2 | 99.3% | 5.2 | -10.6 | 66.6% | 66.4% | 62.0% | 62.9% | 41.3% |
| u50-long | 596 | 6.2% | -25.6 | -96.2 | -143.1 | 99.0% | 5.5 | -8.4 | 66.6% | 62.6% | 62.0% | 49.3% | 48.7% |
| u80-short | 596 | 90.1% | 21.0 | -11.7 | -96.6 | 100.0% | 42.6 | 8.3 | 66.6% | 69.8% | 62.0% | 75.1% | 66.1% |
| u80-long | 596 | 11.7% | -34.9 | -148.1 | -246.6 | 100.0% | 50.9 | 14.5 | 66.6% | 60.6% | 62.0% | 44.2% | 77.9% |

## hist-7d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 596 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 71.8% | 71.8% | 84.3% | 84.3% | 0.0% |
| u20-short | 596 | 48.5% | -0.1 | -10.7 | -24.1 | 99.5% | 3.0 | -2.8 | 71.8% | 71.8% | 84.3% | 84.3% | 16.5% |
| u20-long | 596 | 2.0% | -15.7 | -43.2 | -69.2 | 99.3% | 3.5 | -2.2 | 71.8% | 70.6% | 84.3% | 76.6% | 19.5% |
| u50-short | 596 | 47.3% | -0.7 | -26.1 | -73.4 | 99.5% | 7.7 | -10.5 | 71.8% | 71.8% | 84.3% | 85.1% | 41.3% |
| u50-long | 596 | 1.2% | -39.6 | -108.1 | -158.3 | 99.2% | 9.2 | -5.3 | 71.8% | 68.5% | 84.3% | 64.5% | 48.7% |
| u80-short | 596 | 86.7% | 22.4 | -20.1 | -105.7 | 100.0% | 51.8 | 13.6 | 71.8% | 74.0% | 84.3% | 97.2% | 66.1% |
| u80-long | 596 | 3.5% | -61.5 | -174.7 | -276.4 | 100.0% | 62.1 | 16.0 | 71.8% | 64.1% | 84.3% | 53.0% | 77.9% |

## hist-30d-all, fee model arb-band

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 52.5% | 52.5% | 38.0% | 38.0% | 0.0% |
| u20-short | 550 | 67.6% | 2.6 | -23.4 | -56.5 | 100.0% | 7.7 | 1.3 | 52.5% | 52.4% | 38.0% | 38.3% | 16.9% |
| u20-long | 550 | 6.7% | -29.2 | -140.4 | -167.8 | 99.5% | 7.8 | -1.0 | 52.5% | 50.4% | 38.0% | 34.6% | 19.7% |
| u50-short | 550 | 66.5% | 7.1 | -53.5 | -132.9 | 100.0% | 19.3 | 2.0 | 52.5% | 52.2% | 38.0% | 38.9% | 42.3% |
| u50-long | 550 | 6.9% | -76.7 | -341.2 | -424.7 | 99.5% | 19.7 | -3.5 | 52.5% | 46.5% | 38.0% | 28.8% | 49.3% |
| u80-short | 550 | 96.9% | 68.1 | 11.1 | -88.8 | 100.0% | 123.8 | 28.6 | 52.5% | 56.0% | 38.0% | 47.6% | 67.6% |
| u80-long | 550 | 9.5% | -110.8 | -533.3 | -659.4 | 100.0% | 151.7 | 35.0 | 52.5% | 44.5% | 38.0% | 24.6% | 78.9% |

## hist-30d-all, fee model band+noise

Claim 1 (B vs A) under realistic budgets without and with a keeper; claim 2 (vs HODL) and APR under realistic budgets.

| demand | n | B >= A | extra median bps | extra p5 bps | extra min bps | B >= A (+keeper) | extra median (+keeper) | extra min (+keeper) | A > HODL | B > HODL | APR A median | APR B median | avg util |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 550 | 100.0% | 0.0 | 0.0 | 0.0 | 100.0% | 0.0 | 0.0 | 57.6% | 57.6% | 56.5% | 56.5% | 0.0% |
| u20-short | 550 | 63.3% | 2.4 | -28.0 | -63.6 | 100.0% | 10.6 | 2.9 | 57.6% | 57.6% | 56.5% | 57.2% | 16.9% |
| u20-long | 550 | 3.6% | -48.6 | -166.3 | -197.0 | 100.0% | 12.3 | 0.9 | 57.6% | 56.9% | 56.5% | 50.8% | 19.7% |
| u50-short | 550 | 61.5% | 7.2 | -68.4 | -144.3 | 100.0% | 27.1 | 2.6 | 57.6% | 57.6% | 56.5% | 58.2% | 42.3% |
| u50-long | 550 | 3.3% | -132.4 | -412.5 | -502.7 | 100.0% | 31.4 | 7.1 | 57.6% | 51.8% | 56.5% | 41.2% | 49.3% |
| u80-short | 550 | 93.5% | 67.8 | -8.3 | -121.2 | 100.0% | 159.5 | 33.8 | 57.6% | 59.5% | 56.5% | 68.5% | 67.6% |
| u80-long | 550 | 4.7% | -209.1 | -648.5 | -802.9 | 100.0% | 195.7 | 41.1 | 57.6% | 48.7% | 56.5% | 31.3% | 78.9% |

## Budget sensitivity: all historical windows, fee model arb-band

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 100.0% | 4.3 | 1.6 | 1.3 | 1.26 | 0 | 60.5% | 51.0% |
| u20-short | realistic | 58.7% | 0.8 | -16.9 | -56.5 | -56.47 | 1146 | 59.7% | 50.2% |
| u20-short | realistic+keeper | 99.5% | 3.4 | 1.4 | -3.0 | -3.01 | 1099 | 60.3% | 50.8% |
| u20-short | min | 0.0% | -19.0 | -85.0 | -151.0 | -151.05 | 1146 | 57.8% | 44.9% |
| u20-short | min+keeper | 8.1% | -0.2 | -1.5 | -4.6 | -4.56 | 1146 | 59.9% | 49.7% |
| u50-short | funded | 100.0% | 10.8 | 3.9 | 3.1 | 3.10 | 0 | 61.1% | 52.9% |
| u50-short | realistic | 59.6% | 1.9 | -41.5 | -132.9 | -132.94 | 1146 | 59.6% | 51.0% |
| u50-short | realistic+keeper | 99.7% | 8.5 | 3.7 | -10.6 | -10.64 | 1100 | 61.0% | 52.6% |
| u50-short | min | 0.0% | -47.8 | -212.8 | -374.6 | -374.56 | 1146 | 54.4% | 37.3% |
| u50-short | min+keeper | 6.9% | -0.5 | -3.8 | -16.9 | -16.89 | 1146 | 59.8% | 49.6% |
| u80-short | funded | 100.0% | 103.2 | 24.4 | 9.1 | 9.05 | 0 | 68.1% | 77.0% |
| u80-short | realistic | 93.4% | 33.4 | -5.1 | -96.6 | -96.56 | 1146 | 63.2% | 61.8% |
| u80-short | realistic+keeper | 100.0% | 66.4 | 20.2 | 8.3 | 8.28 | 1114 | 65.3% | 69.0% |
| u80-short | min | 0.0% | -74.9 | -342.9 | -602.7 | -602.72 | 1146 | 50.2% | 29.6% |
| u80-short | min+keeper | 7.2% | -0.7 | -5.8 | -18.3 | -18.26 | 1146 | 59.8% | 49.5% |
| u50-long | funded | 99.9% | 10.4 | 4.3 | -0.2 | -0.15 | 0 | 61.4% | 53.6% |
| u50-long | realistic | 6.5% | -40.0 | -223.9 | -424.7 | -424.69 | 1142 | 54.9% | 39.2% |
| u50-long | realistic+keeper | 99.2% | 8.0 | 3.7 | -8.4 | -8.42 | 780 | 61.0% | 52.7% |
| u50-long | min | 0.0% | -79.6 | -329.3 | -538.2 | -538.17 | 1146 | 49.7% | 27.2% |
| u50-long | min+keeper | 7.1% | -0.5 | -3.8 | -10.0 | -9.96 | 1146 | 59.8% | 49.8% |
| u80-long | funded | 100.0% | 154.8 | 45.6 | 21.4 | 21.42 | 0 | 71.5% | 96.4% |
| u80-long | realistic | 10.6% | -56.3 | -357.7 | -659.4 | -659.42 | 1146 | 52.9% | 34.2% |
| u80-long | realistic+keeper | 100.0% | 78.0 | 27.9 | 14.5 | 14.49 | 1015 | 66.8% | 72.5% |
| u80-long | min | 0.0% | -126.7 | -525.6 | -858.1 | -858.13 | 1146 | 38.0% | 13.2% |
| u80-long | min+keeper | 7.2% | -0.7 | -5.6 | -19.4 | -19.40 | 1146 | 59.7% | 49.7% |

## Budget sensitivity: all historical windows, fee model band+noise

| demand | budget | B >= A | extra median bps | extra p5 bps | extra min bps | worst USD | windows with shortfall | B > HODL | APR B median |
|---|---|---|---|---|---|---|---|---|---|
| u20-short | funded | 100.0% | 6.3 | 2.4 | 1.5 | 1.52 | 0 | 65.4% | 72.2% |
| u20-short | realistic | 55.6% | 0.5 | -20.4 | -63.6 | -63.58 | 1146 | 65.0% | 70.8% |
| u20-short | realistic+keeper | 99.7% | 4.7 | 2.1 | -2.8 | -2.79 | 1100 | 65.3% | 72.0% |
| u20-short | min | 0.0% | -23.0 | -97.4 | -170.3 | -170.31 | 1146 | 63.9% | 64.5% |
| u20-short | min+keeper | 7.9% | -0.2 | -1.5 | -4.6 | -4.57 | 1146 | 65.0% | 70.6% |
| u50-short | funded | 100.0% | 16.0 | 6.1 | 3.9 | 3.92 | 0 | 65.5% | 75.0% |
| u50-short | realistic | 54.1% | 1.1 | -50.6 | -144.3 | -144.33 | 1146 | 65.0% | 71.0% |
| u50-short | realistic+keeper | 99.7% | 11.8 | 5.4 | -10.5 | -10.46 | 1097 | 65.4% | 74.4% |
| u50-short | min | 0.0% | -58.0 | -245.9 | -424.0 | -424.02 | 1146 | 61.1% | 55.1% |
| u50-short | min+keeper | 6.5% | -0.5 | -3.9 | -16.9 | -16.92 | 1146 | 65.0% | 70.4% |
| u80-short | funded | 100.0% | 135.4 | 41.5 | 14.6 | 14.56 | 0 | 72.7% | 107.8% |
| u80-short | realistic | 90.0% | 33.0 | -16.9 | -121.2 | -121.22 | 1146 | 67.0% | 81.7% |
| u80-short | realistic+keeper | 100.0% | 78.3 | 28.1 | 13.6 | 13.57 | 1116 | 70.4% | 93.3% |
| u80-short | min | 0.0% | -92.1 | -400.9 | -688.3 | -688.32 | 1146 | 57.3% | 44.1% |
| u80-short | min+keeper | 7.2% | -0.8 | -5.9 | -18.5 | -18.46 | 1146 | 65.0% | 70.4% |
| u50-long | funded | 100.0% | 19.2 | 9.9 | 3.8 | 3.76 | 0 | 65.8% | 77.9% |
| u50-long | realistic | 2.2% | -60.9 | -297.4 | -502.7 | -502.70 | 1146 | 60.5% | 52.6% |
| u50-long | realistic+keeper | 99.6% | 12.5 | 6.4 | -5.3 | -5.29 | 794 | 65.5% | 74.9% |
| u50-long | min | 0.0% | -99.5 | -394.3 | -618.3 | -618.32 | 1146 | 55.5% | 40.1% |
| u50-long | min+keeper | 6.6% | -0.5 | -3.9 | -10.1 | -10.13 | 1146 | 65.0% | 70.5% |
| u80-long | funded | 100.0% | 221.3 | 90.9 | 28.7 | 28.69 | 0 | 75.8% | 142.4% |
| u80-long | realistic | 4.1% | -93.5 | -479.1 | -802.9 | -802.89 | 1146 | 56.7% | 41.5% |
| u80-long | realistic+keeper | 100.0% | 91.7 | 37.0 | 16.0 | 16.04 | 1035 | 70.7% | 97.8% |
| u80-long | min | 0.0% | -160.4 | -644.2 | -1,001.3 | -1,001.32 | 1146 | 43.9% | 20.0% |
| u80-long | min+keeper | 7.0% | -0.8 | -5.8 | -19.6 | -19.56 | 1146 | 65.0% | 70.5% |

## Regimes: fee model arb-band, demand u50-short

| regime | n | median return | B >= A (realistic) | extra median bps | extra min bps | B >= A (+keeper) | A > HODL | B > HODL | A-HODL median bps | B-HODL median bps | APR A median | APR B median |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gbm-30d-vol0.9 | 10 | -3.0% | 20.0% | -14.7 | -74.9 | 100.0% | 40.0% | 40.0% | -454.2 | -459.5 | 55.6% | 55.0% |
| gbm-30d-vol1.4 | 10 | 9.8% | 30.0% | -85.5 | -264.7 | 80.0% | 40.0% | 30.0% | -1,811.3 | -1,815.3 | 105.2% | 93.0% |
| gbm-7d-vol0.9 | 10 | 0.3% | 20.0% | -10.1 | -22.0 | 100.0% | 40.0% | 40.0% | -154.1 | -163.3 | 95.1% | 90.3% |
| gbm-7d-vol1.4 | 10 | -2.1% | 0.0% | -48.0 | -97.5 | 90.0% | 40.0% | 40.0% | -103.4 | -141.1 | 235.2% | 193.1% |
| hist-30d-all | 550 | -0.6% | 66.5% | 7.1 | -132.9 | 100.0% | 52.5% | 52.2% | 29.6 | 34.8 | 38.0% | 38.9% |
| hist-30d-best-decile-return | 56 | 35.8% | 89.3% | 11.2 | -54.6 | 100.0% | 0.0% | 0.0% | -1,238.7 | -1,224.3 | 12.5% | 13.8% |
| hist-30d-top-decile-vol | 56 | -34.8% | 82.1% | 13.5 | -103.6 | 100.0% | 7.1% | 7.1% | -1,649.5 | -1,627.6 | 17.1% | 18.8% |
| hist-30d-worst-decile-return | 56 | -35.9% | 98.2% | 15.9 | -2.7 | 100.0% | 0.0% | 0.0% | -1,689.7 | -1,674.1 | 17.9% | 20.0% |
| hist-7d-all | 596 | -0.9% | 53.2% | 0.5 | -67.2 | 99.3% | 66.6% | 66.4% | 52.5 | 52.3 | 62.0% | 62.9% |
| hist-7d-best-decile-return | 60 | 15.0% | 48.3% | -0.6 | -67.2 | 93.3% | 3.3% | 3.3% | -335.2 | -335.2 | 63.7% | 59.7% |
| hist-7d-top-decile-vol | 60 | -13.1% | 25.0% | -10.8 | -67.2 | 93.3% | 23.3% | 20.0% | -454.2 | -468.0 | 88.8% | 80.6% |
| hist-7d-worst-decile-return | 60 | -14.5% | 51.7% | 0.8 | -56.0 | 100.0% | 0.0% | 0.0% | -364.7 | -360.7 | 49.3% | 51.0% |
| hist-all | 1146 | -0.7% | 59.6% | 1.9 | -132.9 | 99.7% | 59.9% | 59.6% | 50.2 | 50.2 | 49.8% | 51.0% |
| stress-30d-drawdown | 6 | -35.8% | 100.0% | 15.0 | 0.8 | 100.0% | 0.0% | 0.0% | -1,873.1 | -1,862.9 | 10.7% | 12.7% |
| stress-30d-rally | 6 | 33.8% | 50.0% | -0.3 | -14.5 | 100.0% | 0.0% | 0.0% | -969.7 | -974.4 | 41.3% | 40.5% |
| stress-30d-vol | 6 | 3.3% | 66.7% | 10.2 | -25.2 | 100.0% | 33.3% | 33.3% | -1,168.6 | -1,157.8 | 11.9% | 13.2% |
| stress-7d-drawdown | 6 | -26.0% | 100.0% | 2.6 | 1.0 | 100.0% | 0.0% | 0.0% | -1,061.9 | -1,059.3 | 48.1% | 50.8% |
| stress-7d-rally | 6 | 26.9% | 66.7% | 2.9 | -15.4 | 100.0% | 0.0% | 0.0% | -887.9 | -895.7 | 28.2% | 29.8% |
| stress-7d-vol | 6 | -16.5% | 0.0% | -39.5 | -50.9 | 66.7% | 0.0% | 0.0% | -558.9 | -568.0 | 124.1% | 103.4% |

## Benchmark 3 fee model (arb) for comparison: all historical windows

| demand | budget | APR A median | APR B median | B >= A | extra median bps | extra min bps |
|---|---|---|---|---|---|---|
| none | - | 937.8% | 937.8% | 100.0% | 0.0 | 0.0 |
| u20-short | funded | 937.8% | 944.6% | 95.8% | 25.8 | -47.2 |
| u20-short | realistic | 937.8% | 867.3% | 0.0% | -234.2 | -1,810.7 |
| u20-short | realistic+keeper | 937.8% | 939.4% | 90.4% | 4.0 | -24.2 |
| u20-long | funded | 937.8% | 948.6% | 82.2% | 34.4 | -427.6 |
| u20-long | realistic | 937.8% | 775.9% | 0.0% | -468.8 | -2,781.7 |
| u20-long | realistic+keeper | 937.8% | 939.4% | 85.8% | 3.8 | -28.4 |
| u50-short | funded | 937.8% | 959.5% | 95.6% | 64.2 | -100.2 |
| u50-short | realistic | 937.8% | 756.4% | 0.0% | -576.7 | -4,072.0 |
| u50-short | realistic+keeper | 937.8% | 941.9% | 90.6% | 10.2 | -57.9 |
| u50-long | funded | 937.8% | 958.3% | 81.9% | 87.4 | -1,462.1 |
| u50-long | realistic | 937.8% | 527.3% | 0.0% | -1,167.4 | -6,957.8 |
| u50-long | realistic+keeper | 937.8% | 941.0% | 86.2% | 9.8 | -67.9 |
| u80-short | funded | 937.8% | 1341.4% | 100.0% | 1,338.7 | 88.6 |
| u80-short | realistic | 937.8% | 651.0% | 0.0% | -911.6 | -6,480.6 |
| u80-short | realistic+keeper | 937.8% | 992.3% | 100.0% | 151.6 | 9.7 |
| u80-long | funded | 937.8% | 1459.0% | 99.8% | 1,725.6 | -899.8 |
| u80-long | realistic | 937.8% | 276.1% | 0.0% | -1,825.9 | -11,134.6 |
| u80-long | realistic+keeper | 937.8% | 995.8% | 100.0% | 159.1 | 14.3 |

## Failure modes: FORGE LP < plain Orca LP

Cases = windows x the 6 demand levels, over every regime (historical, stress, GBM). Causes: **shortfall** = the gap closes if the premium above the borrower's capped budget had been paid; **in-kind** = the premium covered the forgone fees at the prices when they accrued, but plain Orca's fees are kept in kind and the base-token part was worth more at the window-end price; **other** = neither alone explains it. Accrual-time guarantee violations (fully funded borrow whose premium is below its forgone fees at accrual prices) are counted separately and must be 0.

| fee model | budget | cases | B < A | shortfall | in-kind | other | accrual-time violations | worst bps | worst USD | worst case |
|---|---|---|---|---|---|---|---|---|---|---|
| arb-band | funded | 7332 | 19 | 0 | 19 | 0 | 0 | -211.8 | -211.78 | u50-long gbm-30d-vol1.4-s20265527 |
| arb-band | realistic | 7332 | 4494 | 4480 | 0 | 14 | 0 | -1,207.8 | -1,207.85 | u80-long gbm-30d-vol1.4-s20265535 |
| arb-band | realistic+keeper | 7332 | 47 | 33 | 14 | 0 | 0 | -128.2 | -128.22 | u50-long gbm-30d-vol1.4-s20265527 |
| arb-band | min | 7332 | 7332 | 7318 | 0 | 14 | 0 | -1,447.6 | -1,447.61 | u80-long gbm-30d-vol1.4-s20265535 |
| arb-band | min+keeper | 7332 | 6813 | 6812 | 0 | 1 | 0 | -19.4 | -19.40 | u80-long hist-30d-2026-08-22T00:00-LH |
| band+noise | funded | 7332 | 14 | 0 | 14 | 0 | 0 | -218.6 | -218.61 | u50-long gbm-30d-vol1.4-s20265527 |
| band+noise | realistic | 7332 | 4809 | 4796 | 0 | 13 | 0 | -1,315.3 | -1,315.29 | u80-long gbm-30d-vol1.4-s20265535 |
| band+noise | realistic+keeper | 7332 | 33 | 21 | 12 | 0 | 0 | -128.7 | -128.67 | u50-long gbm-30d-vol1.4-s20265527 |
| band+noise | min | 7332 | 7332 | 7320 | 0 | 12 | 0 | -1,555.0 | -1,555.05 | u80-long gbm-30d-vol1.4-s20265535 |
| band+noise | min+keeper | 7332 | 6833 | 6832 | 0 | 1 | 0 | -19.6 | -19.56 | u80-long hist-30d-2026-08-22T00:00-LH |
| arb | funded | 7332 | 578 | 287 | 284 | 7 | 0 | -1,462.1 | -1,462.09 | u50-long hist-30d-2026-02-19T00:00-HL |
| arb | realistic | 7332 | 7331 | 7090 | 0 | 241 | 0 | -11,134.6 | -11,134.63 | u80-long hist-30d-2026-02-14T00:00-LH |
| arb | realistic+keeper | 7332 | 599 | 492 | 107 | 0 | 0 | -240.6 | -240.55 | u50-long gbm-30d-vol1.4-s20265527 |
| arb | min | 7332 | 7332 | 7091 | 0 | 241 | 0 | -11,353.8 | -11,353.80 | u80-long hist-30d-2026-02-14T00:00-LH |
| arb | min+keeper | 7332 | 7309 | 7301 | 0 | 8 | 0 | -99.2 | -99.22 | u80-short hist-30d-2026-02-10T00:00-LH |

Restoration refusals (swap cost above the 0.5% slippage cap; retried after 1 h): 454 over all runs. They delay restoration; they never reduce the LP's liquidity.

Every number (all regimes x fee models x demand x budgets, per-config failure lists, per-window values for realistic budgets) is in lp_profitability.json.

Model notes:

- Simulator: forge_math.lpsim's event engine (fee_growth, settle_borrows, simulate_demand), which follows the program: floor on the notional stored at open (calls at the open reference price), LP cap = budget less the 1% bounty, keeper close 5 min after accrued premium reaches 80% of the cap (budgets *+keeper), restoration refused above the 0.5% slippage cap or the escrow margin and retried after 1 h.
- Demand sweep (this benchmark's choice): utilization fixed per demand level (0.2 / 0.5 / 0.8) and borrowers return ~1 h after a bucket frees up, instead of Benchmark 3's random uniform(0.2, 0.8) borrowers.
- Fee models: 'arb-band' and 'band+noise' run on the no-arbitrage-band pool path computed over the whole history (Benchmark 3 starts the band at each window's first price; the pool start differs by < 0.3%); 'arb' is lpsim's legacy-every-price model, kept for comparison.
- Noise volume is a multiple of the LP ladder's starting value (lpsim fixed the extra sqrt(P0) factor that earlier Benchmark 3 runs carried).
