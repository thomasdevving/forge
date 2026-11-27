# FORGE against the last 8 weeks: profitable, for whom, at what price?

Study date 2026-11-27. Window 2026-10-02 to 2026-11-27 (56 days). Tokens SOL, JUP, BONK, KMNO (JLP is not on
Binance). Every number comes from `results.json` (`research.py`, data from `fetch_recent.py`, hashes in
`data/manifest.json`); all tables are in `tables.md`. Simulated figures and assumptions are labeled.

## In brief

1. **Regime: a broad, persistent crash.** SOL 118.38 → 70.95 (−40.1%), JUP −27.3%, BONK −42.0%, KMNO −43.1%;
   peak-to-trough drawdowns 47–52%, lows on Nov 21–25. Daily volatility was not extreme (SOL 54% annualized vs
   62% for Jan–Oct; others 86–97%). SOL fell in all 8 weeks. Deribit SOL implied vol: median 56%, peak 84% (Nov 24).
2. **LPs: the theory held.** With a keeper, FORGE LPs ended at least level with plain Orca LPs in 100% of 7-, 30-
   and 56-day windows, every token, every demand level, both fee models. Median extra at 50% utilization: +17 to
   +31 bps per 7 days, +43 to +126 bps per 30 days. Without a keeper, long borrows made FORGE trail Orca in 96–100%
   of 7-day windows. FORGE does not remove impermanent loss: over 30 days in this crash, Orca LPs lost 3.7–10.4%
   against holding and FORGE LPs 2.0–9.9% (medians).
3. **Borrowers: at default pricing, protection costs more than fair value.** Near the money the 5%/yr floor
   almost never binds; the premium is m(u) × forgone fees, and those fees track the option's own value (expected
   forgone arbitrage fees were 0.70–0.85× the Black–Scholes value of the same payoff). With m(0.5) = 1.5, a 90% put
   costs 1.07–1.31× fair value ex ante, 2.0–2.4× at 80% utilization. On the real path the median premium was
   0.9–2.7× fair value. 30-day SOL and KMNO puts paid off well net of premium; 7-day puts mostly did not; for
   JUP and BONK 30-day puts the premium ate most of the payoff. Collars are a poor deal as designed: the provided
   call leg earned about $0 while giving away upside worth about as much as the put.
4. **Protocol: no fee exists today.** `strategy_close.rs` sends premium to the LP premium vault, the bounty to
   the keeper and the rest back to the borrower. The only revenue is x402 ($0.01 per compile; hedge price
   provisional), which at assumed volumes is $100–$10k a month.
5. **At what price: a narrow band, only under the conservative fee model.** Of 168 floor × multiplier
   combinations, 18 pass all three tests (LPs ≥ Orca in 95% of windows after a protocol take, borrowers ≤ fair
   value ex ante, protocol take > 0):

   | Token | Passing |
   |---|---|
   | SOL | floor 2–5%/yr, flat multiplier 1.1, take ≤ 5% of premium |
   | JUP | floor 2–20%, flat 1.1–1.2 (and 20% with 1 + 0.25u) |
   | BONK | floor 2–20%, flat 1.1–1.2 (and 20% with 1 + 0.25u) |
   | KMNO | only floor 2%, flat 1.2 (borrower ratio 0.99, marginal) |

   The default curve (1 + u) fails the borrower test for every token at every floor. With the assumed extra
   (non-arbitrage) trading volume included, **nothing passes**: the guarantee that LPs get at least their forgone
   fees then forces borrowers above fair value even at m = 1. Inside the band margins are thin: LPs +5 to +19 bps
   per 7 days over Orca, borrowers 1–22% under fair value, protocol about 1–1.6% of LP capital a year. A protocol
   fee taken only from premium above forgone fees passed at every tested level where m ≥ 1.1.

## Recommendation

- Flat multiplier about 1.1 (at most 1.2) instead of 1 + u.
- Floor 2–5%/yr for SOL, up to 10–20% for JUP and BONK; consider a strike-dependent floor (a fair SOL 30-day
  floor is 8%/yr at an 80% strike, 32% at 90%, 52% at 95%).
- If FORGE charges a protocol fee, take it from the premium above forgone fees (about 10–20% of that).
- Keep the keeper mandatory; fund hedge budgets near fair value, not at the floor.
- Pay the collar's provided leg a premium.

## Revenue under assumptions (SOL, 50% utilization)

| Pricing | Take | $1M LP TVL | $10M | $50M |
|---|---|---|---|---|
| Default (5%, 1 + u) | 10% of premium | $23k/yr | $232k | $1.16M (borrowers pay above fair) |
| Band (5%, flat 1.1) | 5% of premium | $9.9k | $99k | $495k |
| Band (5%, flat 1.1) | 20% of premium above forgone fees | $6.3k | $63k | $315k |

JUP, BONK and KMNO premium flows are 1.5–2.0× SOL's. TVL, utilization and take rates are assumptions.

## Update: the pricing as implemented

After this study FORGE adopted its recommendation (`programs/forge`, commit "Price borrows with a
hybrid multiplier and a protocol fee on premium above forgone fees"):

- **Hybrid multiplier:** a flat 1.1× on forgone fees up to 60% utilization, then +6 per unit of
  utilization to the 80% cap.
- **Floor:** 5%/yr, unchanged.
- **Protocol fee:** 10% of the premium **above** the forgone fees, never of the forgone fees
  themselves.

The study was rerun with the hybrid curve added to its grid. Under the conservative fee model (last
8 weeks, 5% floor):

| Token | Borrower ex-ante, worst ratio to fair value | Largest LP-safe take on the excess | LP extra vs Orca, median per 7 days (u = 50%) |
|---|---|---|---|
| SOL | 0.97 | 50% | +6.5 bps |
| JUP | 0.88 | 50% | +8.1 bps |
| BONK | 0.83 | 50% | +9.5 bps |
| KMNO | 0.92 | 30% | +8.5 bps |

The implemented 10% fee on the excess is inside the LP-safe limit for all four tokens, and
borrowers pay at or below fair value ex ante. The study's yes/no "in band" flag reads false for
KMNO only because that flag allows a fee on the whole premium, which KMNO cannot afford (0%); a fee
on the excess, as implemented, fits.

With the assumed extra trading volume included (band+noise), the borrower ratio is 1.06–1.39 and no
pricing passes. That limitation stands: if real pools carry much non-arbitrage volume, the LP
guarantee prices protection above fair value.

**Benchmark 4 over ten months of JUP history**, rerun under the new pricing (keeper on, long
holds): FORGE LPs ended at least level with plain Orca in 92% of windows at 20% and 50%
utilization (median extra +3.6 and +8.9 bps; 98.5–100% and +7–40 bps under the old pricing) and in
100% at 80% (+121 bps). The lower margin is the intended trade: protection moved from 1.1–2.4×
fair value to about 0.8–0.97×. Benchmark 3's guarantee still holds with the fee: 0 violations
among 60,511 (SOL) and 61,319 (JUP) fully funded borrows.

## Caveats

- Fees are simulated (arbitrage along 1-minute Binance bars expanded to 15-second paths, 0.30% band), not measured
  Orca fee growth; every premium and LP level scales with this. The borrower conclusion depends on how much of a
  real pool's volume is non-arbitrage.
- BONK and KMNO pools assumed 0.30% fee / tick spacing 64. One 8-week crash path, overlapping windows. GBM paths
  have no jumps; ex-ante results carry about 8% Monte Carlo error, so the band's edges are within the noise.
- One bucket per hedge, budgets that never bind; restoration costs and Deribit fees/spreads excluded. Deribit
  implied vol exists only for SOL. Utilization, demand, budgets, TVL, take rates and x402 volumes are assumptions.
