# Providing liquidity

## Buckets

Each market has a ladder of buckets: Orca ranges of equal width (4 × the pool's tick spacing, about
2.6% on a tick-spacing-64 pool). You deposit liquidity into a bucket. Below the price a bucket holds
the quote token, above it the base token, and the bucket at the price holds both.

## What you earn

- **Unborrowed** liquidity stays in the Orca pool and earns normal swap fees.
- **Borrowed** liquidity is out of the pool, so it earns no swap fees. The borrower pays a premium
  instead:

```
premium = max(time floor, m(u) × forgone fees)
time floor = 5% a year on the borrowed notional
m(u) = 1 + u               up to 60% utilization
m(u) = 1.6 + 6 (u − 0.6)   from 60% to the 80% cap
```

Forgone fees are measured from Orca's own fee growth for the range while it is borrowed, so the
premium tracks what your liquidity would actually have earned, times a multiplier of at least one.

## The guarantee, and its limits

If a borrowed range is restored and the borrower's budget covers the premium, you get the same
liquidity back plus at least the fees you would have earned in Orca. That is conditional:

- Premium budgets are capped. If a position's premium would exceed its budget, the gap is recorded
  as a shortfall and new borrowing in the market pauses until it is reviewed.
- Restorations can be refused by the price guards (see [Trading](trading)); the escrow stays locked
  until they complete.
- Utilization per bucket is capped at 80%.

## Withdrawals

Unborrowed liquidity withdraws immediately. Borrowed liquidity needs a 24-hour notice; after it,
keepers may close the positions using it.

## Evidence

The LP guarantee is tested on ten months of historical prices per market (Benchmark 3), and the
profitability of providing liquidity against plain Orca and against holding is tested separately
(Benchmark 4). Both are summarized on the home page and reproduced with `benchmarks/run_all.py`.
