# FORGE math

Every formula used by FORGE, its derivation, and the tests that check it. Prices are
quote per base (USDC per SOL) unless stated otherwise. On-chain code uses only the
integer forms; real-valued forms are for the compiler, verifier and simulations.

## 1. Range position value (section 3.1)

Uniswap-v3-style liquidity `L` over `[p_a, p_b]` satisfies, inside the range,
`x = L (1/√P − 1/√p_b)` and `y = L (√P − √p_a)`. Outside the range the position is
single-sided and the amounts freeze at the nearer boundary, so with `s = clamp(√P, √p_a, √p_b)`:

```
x(P) = L (1/s − 1/√p_b)        y(P) = L (s − √p_a)
V(P) = x P + y
```

Inside the range: `V(P) = L (2√P − P/√p_b − √p_a)`.

Properties used throughout:

| Property | Statement | Test |
|---|---|---|
| Path independence | `x, y` depend only on the current `P` | follows from the closed form |
| Delta | `dV/dP = x(P)` (envelope: `dx P + dy = 0` inside the range) | `test_derivative_matches_finite_difference` |
| Gamma | `d²V/dP² = −1/(2 P^{3/2})` per unit `L` inside the range, `0` outside | `test_value_is_nondecreasing_and_concave` |
| Additivity | `L` on `[a,c]` = `L` on `[a,b]` + `L` on `[b,c]` at every price | `test_additivity_of_split_ranges` |
| Bounds | `0 ≤ V(P) ≤ L (√p_b − √p_a)` | `test_value_is_continuous_and_bounded` |

Code: `math/forge_math/clmm.py`. Tests: `math/tests/test_clmm.py`.

## 2. Borrowed ranges are self-collateralized (section 3.2)

Borrowing `L` on a range that is strictly out of range at open removes single-sided tokens
into escrow. The long payoff at close is `escrow value − restoration cost`.

**Long put** (range below spot). Escrow is all quote, `E_y = L (√p_b − √p_a) = max_P V(P)`.
Restoration costs `V(P) ≤ E_y`, so the payoff `E_y − V(P) ≥ 0` for every `P`.

**Long call** (range above spot). Escrow is all base, `E_x = L (1/√p_a − 1/√p_b)`. The
payoff is `E_x P − V(P) = (E_x − x(P)) P − y(P)`. Below the range it is `0`. Above it,
`E_x P − L(√p_b − √p_a) ≥ 0` because `E_x p_b = L(√p_b − √p_a) √p_b/√p_a ≥ L(√p_b − √p_a)`.
Inside, `d/dP (E_x P − V) = E_x − x(P) ≥ 0` and the payoff is `0` at `p_a`, so it is non-negative.

This holds in the frictionless model only. Real restoration also pays swap fees, price
impact and rounding, which the separately funded restoration buffer covers within limits
(section 8.4). Tests: `test_borrowed_put_is_self_collateralized`,
`test_borrowed_call_is_self_collateralized`, `test_put_payoff_shape`.

## 3. Premium (sections 4.3, 4.4, 8.6)

All premium math is integer and mirrors the on-chain program. Rounding is always in the
LP's favor for amounts owed to LPs.

### 3.1 Forgone fees

Orca stores fee growth per unit of liquidity as wrapping Q64.64. For a borrowed bucket
with liquidity `L` and inside-growth snapshots `g_open`, `g_now`:

```
forgone_token = ⌈ ((g_now − g_open) mod 2^128) · L / 2^64 ⌉
```

Token A and token B are computed independently in their own atoms and mapped to base/quote
by the registered mint ordering.

### 3.2 Conversion to quote and monotonic accrual

Base-token fees accrued since the previous checkpoint are valued at the validated reference
price `r` (quote atoms per base atom, Q64.64): `⌈ base · r / 2^64 ⌉`. Each leg keeps a
cumulative quote-denominated forgone amount that only increases; earlier increments are
never revalued at later prices. Test: `test_checkpoint_never_revalues_past_accrual`,
`test_cumulative_forgone_is_monotone`.

### 3.3 Utilization multiplier

Utilization is post-reservation, `u = ⌈(borrowed + reserved) · 10^6 / total⌉` ppm. The
default curve is the hybrid one

```
m(u) = 1.1                   0   ≤ u ≤ 0.6
m(u) = 1.1 + 6 (u − 0.6)     0.6 < u ≤ 0.8
reject                       u > 0.8 (cap)
```

evaluated in ppm with each linear term rounded up. The multiplier is locked per bucket when
the bucket is borrowed. A flat 1.1 keeps borrowers near the fair value of the protection while
liquidity is plentiful; the steep part rations it when scarce. It replaced `1 + u` after the
study in `benchmarks/research/2026-11-recent`, which found `1 + u` priced borrowers above fair
value at every floor tested. Tests: `test_default_curve_is_hybrid`,
`test_curve_monotone_and_at_least_one`.

### 3.4 Leg premium

```
floor  = ⌈ notional_quote · rate_bps · elapsed_s / (10^4 · 31_536_000) ⌉
leg    = max(floor, ⌈ m · cumulative_forgone_quote ⌉)
total  = Σ legs
```

The floor and the multiplied forgone amount are alternatives (max), never added.
Test: `test_leg_premium_is_max_not_sum`, `test_time_floor_examples`.

### 3.4a Protocol fee

The protocol takes `protocol_fee_bps` (default 10%) of the premium a leg earns **above** the
forgone fees, never of the forgone fees themselves:

```
cut_due = ⌊ (premium − cumulative_forgone_quote)⁺ · protocol_fee_bps / 10^4 ⌋
LP share = premium − cut    ≥ cumulative_forgone_quote
```

It is taken as each increment is paid (only from the increment, rounding down) and, at final
settlement, only when the leg's LPs are paid in full; when a budget falls short the protocol takes
nothing more. It stays in the premium vault, is booked on the market at finalize
(`Market.protocol_fees`) and leaves only through the admin's `withdraw_protocol_fees`.
Tests: `protocol_cut_only_from_excess`, `lps_keep_their_forgone_fees` (Rust),
`test_protocol_cut_leaves_lps_their_forgone_fees` (property test), `tests/fork/protocol-fee.test.ts`.

### 3.5 Budget, bounty and shortfall

```
bounty_reserve = ⌊ budget · bounty_bps / 10^4 ⌋        (default 1%)
lp_cap         = budget − bounty_reserve
crank allowed  ⇔ accrued · 10^4 ≥ lp_cap · trigger_bps  (default 80%)
to_lp          = min(accrued, lp_cap)
shortfall      = accrued − to_lp                         (recorded, never charged)
refund         = budget − to_lp − bounty_paid
```

Test: `test_budget_split_and_trigger`, `test_settlement_never_exceeds_budget`.

### 3.6 Pro-rata distribution

Each bucket keeps a cumulative premium-per-share index in Q64.64. A distribution of `a`
atoms over `S` shares computes `(inc, rem) = divmod(a · 2^64 + rem, S)` and adds `inc` to
the index, carrying the exact scaled remainder. Then
`Σ_k inc_k · S_k + rem = deposited · 2^64` holds exactly, so the sum of all LP claims
(each `⌊shares · Δindex / 2^64⌋`) never exceeds the premium deposited. An LP that joins
later starts from the current index and cannot claim earlier premium.
Tests: `test_premium_index_never_overpays`, `test_late_joiner_cannot_claim_history`.

### 3.7 Known bias of the forgone-fee measure

While liquidity is borrowed, the remaining in-range liquidity is smaller, so the same
trades produce higher fee growth per unit of liquidity. Measured forgone fees can therefore
overestimate what the LP would have earned, but only under the assumption that volume and
routing are unchanged. This is not guaranteed when volume, routing or fee behavior change.
