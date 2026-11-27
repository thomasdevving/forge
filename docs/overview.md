# What FORGE is

Most Solana tokens trade on Orca but have no options market. FORGE lets you trade options on them anyway:
you choose how much you can lose and how much you can gain, and FORGE builds that payoff from the
token's own Orca liquidity. Or you provide that liquidity and earn a premium on top of your fees.

## The idea in one paragraph

An Orca concentrated-liquidity range below the current price holds only the quote token (USDC). If
FORGE borrows that range, it locks the USDC it releases and owes the same liquidity back later. If
the price falls through the range, giving the liquidity back costs less than what was locked, and
the difference is paid to you: that is a put. Above the price, with the token itself locked, the
same mechanism is a call. Combining such ranges, borrowed or provided by you, reproduces almost any
payoff you can draw.

## The parts

| Part | What it does |
|---|---|
| Studio | You draw the payoff at close and set your limits. |
| Compiler | Picks which ranges to borrow or provide so the result matches your line as closely as possible within your limits (a minimax MILP solved with HiGHS). |
| Verifier | Independently computes the exact worst-case gap between your line and what was built, and issues a certificate. |
| Program | An Anchor program on Solana that borrows and deposits liquidity through Orca CPIs, escrows real tokens, accrues premium and settles from real balances. |
| Buckets | Standardized ranges (4 × tick spacing wide) where LPs deposit. Traders borrow from them. |

## The flow

1. **Draw** the payoff, or start from a preset (protective put, collar, spreads, strangle).
2. **Compile**: FORGE shows the ranges, what is locked, the premium limits and the certified max error.
3. **Open**: every transaction is simulated first; the certificate hash is stored in your position.
4. **Close**: borrowed liquidity is restored to the pool and you are paid out from real token balances.

## Any token

FORGE does not depend on SOL or any particular token. A market is an Orca Whirlpool, a second
Whirlpool of the same pair for the swaps that restore liquidity, and Pyth price feeds. See
[Adding a token](markets).

## Status

Hackathon software, not audited. It runs on a Surfpool fork of Solana mainnet with test funds only.
