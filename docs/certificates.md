# Replication certificates

Every compiled position comes with a certificate: a JSON document that states exactly how close the
construction is to the payoff you drew. Its SHA-256 hash is stored in the position account when you
open, so anyone can check what you agreed to.

## What is certified

The **certified bound** is the maximum gross error between your target payoff and the construction
over the stated price domain, computed exactly (the error is piecewise `a + bS + c√S`, so the verifier
checks every extremum, not a sample), plus a rounding allowance for Orca's integer math.

It does **not** include premium, pool fees, restoration swap costs or price impact at settlement.
Those are reported separately.

## Fields

| Field | Content |
|---|---|
| `version` | Format version (1). |
| `market` | Whirlpool, decimals and spot used. |
| `target` | Your breakpoints and the price domain. |
| `construction` | Cash, token amount, and every leg: kind, borrowed or provided, ticks, prices, on-chain liquidity. |
| `error` | `max_gross_error`, the price where it occurs, `rounding_bound`, `certified_bound`, method. |
| `collateral` | Escrow, buffers, provided amounts and total capital locked. |
| `premium_budget` | Your premium cap. |
| `liquidity_check` | Borrowable liquidity per borrowed range at compile time. |
| `simulation` | Transactions, compute units and sizes from the fork simulation at open. |
| `disclaimer` | What the bound excludes. |
| `hash` | SHA-256 of the canonical JSON of every other field. |

## Checking one

The compiler API verifies a certificate from the document alone: it recomputes the hash and the
exact bound.

```
POST /api/compiler/verify   { ...certificate }
GET  /api/compiler/certificates/<hash>
```

Canonical JSON: keys sorted, no whitespace, integer-valued numbers written as integers.
