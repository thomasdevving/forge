# FORGE demo video: script

Length 2:56. Your intro on camera, then four parts: traders, LPs, agents, and why it works. All
footage is real, recorded on the hosted app. Every number on screen comes from the app or the
benchmark files.

The voice-over runs at about 125 words a minute, a relaxed pace; Part 4 is a little brisker (about
140) because it carries the explanation. The times are when each line should start; being a second early or late is fine.

---

## Intro, on camera (0:00 to 0:18)

Record it as `demo/footage/intro.mp4`. The video takes its length from the file, so aim for about
18 seconds; anything longer pushes the total past three minutes.

> Say you hold JUP and want protection from a crash. On ETH you'd buy a put. Most Solana tokens
> have no options market at all. But they do trade on Orca, and that's enough.
> This is FORGE, built for the Dev3pack hackathon.

(40 words)

---

## Part 1: traders (0:19 to 1:21) · `vo-1.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 0:19 | Title, then the landing page; the cursor clicks **Launch App** | "First, traders. From the landing page, I open the app." |
| 0:26 | The market dropdown opens, **JUP/USDC**; **Connect**, demo wallet | "I pick JUP and connect a demo wallet. It runs on a mainnet fork: real pools, test money." |
| 0:34 | The Strategy dropdown opens, **Collar**; floor −12%, cap +15% | "Then the hedge: a collar. Twelve percent down is my floor, fifteen up is my cap." |
| 0:41 | Dragging the cap point on the chart | "Dragging the chart does the same thing." |
| 0:44 | Duration **7d** | "I want it for one week." |
| 0:47 | **Compile**, the suggested budget, compile again | "Compile, and take the suggested budget." |
| 0:53 | Ranges, cost, certificate | "The ranges, the cost, and a certified error bound." |
| 0:57 | **Open position** (sped up) | "Open it on-chain." |
| 1:00 | The position: ends in 7 days, premium, exposure | "My position ends in a week. I can see what I've paid and my exposure." |
| 1:07 | **Close**, settled | "Closing returns the LPs' liquidity and pays me out." |
| 1:12 | The Architect: a sentence in, options out, **Choose** | "Or just tell the Architect what you want. It comes back with real options, and I still sign." |

(about 120 words)

---

## Part 2: liquidity providers (1:21 to 1:38) · `vo-2.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 1:21 | Title, the Earn page, picking a bucket | "The other side: liquidity providers. You deposit into a price range, and it earns normal Orca fees." |
| 1:29 | Deposit $500 | "When a trader borrows it, you get paid at least the fees you missed." |
| 1:34 | Earnings panel | "Your earnings are broken down below." |

(36 words)

---

## Part 3: agents (1:38 to 2:02) · `vo-3.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 1:38 | Title, the landing page's **For agents** view | "Agents can do all of this too, paying per request in USDC over x402." |
| 1:45 | A real treasury agent run in the terminal: 402, pays $0.01, options, checks, asks its human, "y", opened | "This treasury agent asks for a hedge on JUP, pays one cent, gets certified options, checks them against its rules, and asks its human. One yes, and it's open." |

(44 words)

---

## Part 4: why it works (2:02 to 2:56) · `vo-4.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 2:02 | Title, then **the math**: a range below the price, USDC locked in escrow; the price falls through it; V(P) and put = escrow − V(P) | "A range below the price holds only USDC. FORGE borrows it and locks that USDC. If the price falls, putting the liquidity back costs less, and the trader keeps the difference. That's a put." |
| 2:16 | **The compiler** stacks ranges onto the payoff; the ±$3.20 certificate | "The compiler stacks ranges into your payoff and proves the worst-case error." |
| 2:24 | **The LP's side**: premium = the larger of a 5% yearly minimum and a multiplier × the fees the LP missed; the 1.1× curve; where a premium goes | "LPs get the exact same liquidity back when the position closes. While it's out, the trader pays at least the fees it would have earned, more as demand rises." |
| 2:36 | **x402**: 402 with a price, a signed USDC transfer, settled on Solana | "Agents pay over x402: a 402 reply with a price, settled in USDC on Solana." |
| 2:42 | **How we tested it**: 19 of 23 hedges buildable, 0 off by more than promised, 0 of 61,319 loans paid LPs less than their missed fees, 92% of the time LPs beat or matched plain Orca | "Tested on a mainnet fork and ten months of real JUP prices: across sixty-one thousand funded borrows, LPs never got less than the fees they missed." |
| 2:52 | Logo, site, repo | "That's FORGE. Try it at the link below." |

(about 125 words)

What the numbers mean, if you want to say more: the LP guarantee holds when the trader's premium
budget covers it (that's what "funded" means; the keeper closes positions before budgets run out).
Against plain Orca, FORGE LPs ended level or ahead in 92% of ten-month windows at 50% of a bucket
lent, and in every window at 80% lent. The pools in that test are simulated from real prices, not
a replay of Orca swaps. All of it is on the /proof page.

---

## Recording tips

- One voice-over file per part, `vo-1.wav` to `vo-4.wav` in `demo/footage/`. Each starts at its
  part's title card. Keep each under its part's length: 62 s, 17 s, 24 s and 54 s.
- Use a plain, darkish background for the intro so it matches the video.
- Re-render with `cd demo && npm run render`. The output is `demo/out/forge-demo.mp4`.
