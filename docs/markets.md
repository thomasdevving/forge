# Adding a token

FORGE's program and math are the same for every Orca Whirlpool, so any token can get a market.

## Requirements

1. At least **two Orca Whirlpools** for the pair against USDC, with classic SPL tokens and the
   standard swap (no adaptive fee), each holding over $500. One becomes the market; the deepest other
   one is used for the swaps that restore liquidity at close.
2. A **Pyth price feed** for the token in USD with a price account on Solana.

## In the app

In Studio or Earn, press **+ Add** next to the market switcher and paste the token's mint address.
FORGE finds the pools (Orca's public pool API) and the feed (Pyth's catalogue), checks them on chain,
creates the market and its bucket ladder on the fork, and switches to it. If something is missing
you get the reason, for example *"needs two classic-SPL Orca Whirlpools with over $500 TVL"*.

## From the command line

```
pnpm --filter @forge/fork bootstrap -- --mint <token mint>
pnpm --filter @forge/fork bootstrap -- --whirlpool <pool> --swap-pool <other pool> --feed <pyth feed id>
```

## How pools are chosen

- Target: the tick-spacing-64 pool if there is one, otherwise the deepest pool.
- Restoration: the deepest pool other than the target.
- Pools under $1M TVL get a wider restoration slippage cap (1.5% instead of 0.5%).

## Markets on the demo fork

SOL/USDC, JUP/USDC and BONK/USDC, plus any token added from the app.
