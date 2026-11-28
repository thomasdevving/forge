# FORGE demo video: script and shot list

Target length about 4:30. Four parts after your intro: the trader app, the LP side, agents, then why
it works. Each line of voice-over (VO) sits next to the footage it plays over. All footage is real
and recorded on the hosted app (`demo/record/record.mjs`). All numbers come from the app or the
committed benchmark files.

Read the VO at a calm pace (about 150 words a minute). The timings below fit that pace. If you speak
faster or slower, adjust the scene lengths in `demo/src/timeline.ts`.

---

## 0. Cold open: you on camera (0:00 to 0:32)

**Shot:** you, talking to the camera. Record it as `demo/footage/intro.mp4` (1920×1080, any frame
rate, about 32 seconds). The edit drops it in automatically; until then it shows a placeholder.

> You hold a token. Maybe it's JUP, maybe something smaller. The price could drop thirty percent
> next week, and you'd like protection: a floor under what you hold.
>
> On Bitcoin or ETH you'd buy a put option. But most Solana tokens have no options market at all.
> No floor to buy, at any price.
>
> They do trade on Orca, though. And that liquidity turns out to be all you need.
> This is FORGE.
>
> Everything you're about to see, the on-chain program, the app, the agent API, was built
> for the Dev3pack hackathon. I started from an empty repository; nothing was built beforehand.

**Transition:** your frame shrinks into a card and the FORGE logo draws itself.

---

## 1. For traders: the app (0:25 to 2:05)

**Title card:** "01 · Protect any token"

| Time | Footage | VO |
|---|---|---|
| 0:28 | Landing hero | "FORGE lets you trade options on tokens that don't have any. You choose how much you can lose and how much you can gain." |
| 0:36 | Click **Launch App**, the Studio opens, pick **JUP/USDC** | "Let's protect 3,000 JUP. This is the Studio, running on a fork of Solana mainnet: real pools and real prices, but test money." |
| 0:45 | **Connect** → demo wallet with test funds | "One click gives us a demo wallet with fork funds." |
| 0:50 | **Your hedge** form: Strategy → Collar, floor −12%, cap +15%. The price tags and the "Now" pill update on the chart | "I describe what I want in a few numbers. A collar: my 3,000 JUP is never worth less than this floor, 12% below today's price. In exchange I give up gains above the cap. The exact prices are right there, on the form and on the chart." |
| 1:00 | Drag the cap point on the chart; the form follows. Duration **7d** | "The chart and the form are the same thing: drag a point and the numbers follow. I want this cover for a week, so it closes automatically after seven days." |
| 1:08 | Scrub the scenario line | "Move along the chart to see what I'd get at any closing price." |
| 1:12 | **Compile** → click the suggested budget → compile again; ranges, cost, certificate | "Compile. FORGE finds the Orca ranges that reproduce my line: liquidity borrowed from LPs below the price, my own JUP placed above it. It suggests a premium budget for one week, and certifies the worst-case error to the cent." |
| 1:24 | **Open position**: simulate, certify, build, sign and send (sped up) | "Opening simulates every transaction first, then signs and sends. The certificate's hash is stored on-chain with the position." |
| 1:34 | **Positions**: "ends in 6d 23h", premium against the cap, legs, delta and gamma | "My position: when it ends, the premium paid so far against my budget, each leg, and my exposure right now. A keeper closes it when the week is up, or earlier if the budget runs low." |
| 1:44 | **Architect**: type a sentence, options appear, **Choose** | "Don't want to draw? Tell the Architect what you hold and what you want. It compiles real alternatives with real prices. Pick one, review it in the Studio, and you still sign." |
| 1:58 | **Tour** button, two steps | "And if you're new, the tour walks you through every screen." |

---

## 2. For liquidity providers (2:05 to 2:40)

**Title card:** "02 · The other side: LPs"

| Time | Footage | VO |
|---|---|---|
| 2:08 | **Earn** page, the three-step explainer | "Every protection position borrows liquidity from someone. That's the LP." |
| 2:13 | The bucket table, pick a range below the price | "LPs deposit into price ranges, called buckets. While nobody borrows a bucket, it sits in Orca and earns normal trading fees." |
| 2:20 | Deposit $500 | "When a trader borrows it, the trader pays the LP at least the fees it would have earned, plus extra as the bucket fills up. And a minimum rate pays even in quiet markets." |
| 2:30 | Earnings panel: Orca fees, premium, extra over plain Orca. Hover **Claim** | "When the position closes, the same liquidity goes back to the pool. Earnings show what came from Orca, what came from borrowers, and how much better it did than plain Orca." |

---

## 3. For agents (2:40 to 3:20)

**Title card:** "03 · Built for agents"

| Time | Footage | VO |
|---|---|---|
| 2:43 | Landing → **For agents** toggle, the hero changes | "Everything a person does in the Studio, a program can do too." |
| 2:48 | The agent section: what an agent can do | "A DAO treasury bot, a trading bot, a wallet: any of them can ask FORGE for a hedge and pay per request in USDC, over x402. No account, no API key." |
| 2:58 | Terminal: the treasury agent's real run against the hosted API. It discovers the markets, gets a 402, pays $0.01, FORGE compiles four floors (two can't be built on today's liquidity), the agent re-verifies the certificates against its policy, asks its human, gets "y", and the position opens | "Here's a DAO treasury agent. It sees its biggest exposure is JUP and asks FORGE for a hedge. FORGE answers 402 with a price; the agent pays one cent from its own wallet. Back come certified options. Two floors weren't buildable on today's liquidity, and FORGE says so instead of guessing. The agent re-checks every certificate against its own policy, then stops and asks its human. One yes, and the position is open on-chain." |

---

## 4. Why it works (3:20 to 4:25)

Motion graphics, then the proof page.

**Title card:** "04 · Why it works"

| Time | Graphic | VO |
|---|---|---|
| 3:23 | **A range is an option.** A price axis, an Orca range below today's price holding only USDC. The price falls through it; the USDC converts to tokens. The curve V(P) bends; "put = escrow − V(P)" appears. | "The key idea: concentrated liquidity already behaves like an option. A range below the price holds only USDC. FORGE borrows it and locks that USDC. If the price falls through the range, giving the liquidity back costs less than what was locked, and the trader keeps the difference. That's a put. The same above the price, with the token, is a call." |
| 3:43 | **The compiler.** The target collar, then ranges stacking up to trace it, an error band of ±bound, and a certificate stamp. | "The compiler stacks ranges until they trace the payoff you drew, then proves the worst-case gap with exact arithmetic. That bound goes into a certificate anyone can recheck." |
| 3:53 | **Fair pricing.** premium = max(floor, m(u) × forgone fees). The hybrid curve: flat 1.1× up to 60% utilization, then rising to the 80% cap. A bar splits into "LP: forgone fees" and "excess"; 10% of the excess goes to the protocol. | "LPs are paid the fees they gave up, measured on-chain, times a multiplier: 1.1 until a bucket is 60% lent, then rising steeply. The protocol only takes a share of the extra above those fees, never of what the LP is owed." |
| 4:05 | **x402.** A sequence diagram with the values from that run: agent → POST /x402/hedge → 402 PAYMENT-REQUIRED ($0.01 USDC) → the same request with a signed USDC transfer in PAYMENT-SIGNATURE → FORGE settles it on Solana → 200 with the certified options and PAYMENT-RESPONSE. | "For agents, x402 turns HTTP's 402 Payment Required into a payment rail. The price is in the reply, the payment is a signed USDC transfer settled on Solana, and the request is served once it lands." |
| 4:13 | **Proof.** Numbers count up: 19 of 23 payoffs compiled on thin liquidity, against 1 of 23 for direct replication. 0 certificate bounds violated. 61,319 borrows, 0 LP-guarantee violations. FORGE LPs at least level with plain Orca in 92% of windows over ten months of JUP. Then the /proof page scrolls. | "And we measured it. On JUP's thin pools, nineteen of twenty-three payoffs compiled, against one for the naive approach, with zero certificate violations. Over sixty-one thousand simulated borrows, the LP guarantee held every time. Every number is reproducible from the repo with one command." |

---

## 5. Outro (4:25 to 4:33)

**Graphic:** the FORGE logo, "Options for tokens that don't have options", the site URL and the repo.

> FORGE. Options for any token on Orca. Try it at the link below.

---

### Recording your parts

- **Intro:** `demo/footage/intro.mp4`, 1920×1080, about 25 seconds. Use a plain, darkish background
  so it matches the graphite palette.
- **Voice-over:** one take per part, saved as `demo/footage/vo-1.wav` … `vo-4.wav`. The edit
  places each one at the start of its part. Without them, the video renders silent with on-screen
  captions.
- Re-render with `cd demo && npm run render`. The output is `demo/out/forge-demo.mp4`.
