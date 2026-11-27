# Trading in the Studio

## 1. Pick a market and draw

Choose a market in the bar at the top (or add one, see [Adding a token](markets)). The chart shows
the value of your position **at close**, against the token price. Drag the points, double-click to
add one, select one and press Delete to remove it. Presets give a starting shape.

The dashed line is what simply holding the token would be worth. The shaded band (if shown) is how
far the token moved over 1, 7 or 30 days in ten months of Binance history, centred on today's
price: a quick way to see how likely your floor or cap is to come into play.

## 2. Set your limits

| Limit | Meaning |
|---|---|
| Token held | How much of the token the payoff covers. |
| USDC held | Cash available as collateral for provided ranges. |
| Max premium | The most you will pay LPs, in USDC. 1% of it is reserved as a keeper bounty. |

The feasibility line updates as you draw: it shows the sampled error against the tolerance and why
a shape cannot be built, with the closest shape that can.

## 3. Compile

The **Ranges** table lists every leg: borrowed ranges (puts below the price, calls above) are funded
by LP escrow; provided ranges use your own tokens. **Cost** shows the capital that will be locked,
the restoration buffers (2% by default, returned unless used), the LP escrow, your premium cap and the
minimum premium per day (the time floor, 5% a year on borrowed notional).

The **Certificate** gives the exact maximum error between your line and the construction over the
price domain. It covers the payoff only: premium, pool fees and restoration swap costs are separate.

## 4. Open

FORGE simulates the open, records the simulation in the certificate, stores the certificate hash in
your position account and sends the transactions for you to sign (a position with many legs takes a
few). Until every leg is executed the position is *Opening*; it can be cancelled and unwound.

## 5. While open

**Positions** shows each leg, the premium paid against your cap, delta, gamma and P&L at the pool
price. Premium accrues as `max(time floor, m(u) × fees the LPs forgo)`. When accrued premium reaches
80% of your cap, anyone may close the position (and earns the keeper bounty).

## 6. Close

Closing restores every borrowed range to the pool, swaps through the separate restoration pool where
needed, and pays you from real token balances. Restorations are guarded: if the pool price deviates
from the reference by more than 1%, or a swap would slip more than the market's cap (0.5% by default,
wider on thin pools), the program refuses and the position stays recoverable instead of settling at a
bad price. The result page shows designed vs realized payoff.
