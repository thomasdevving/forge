# FORGE demo video: script

Length 2:57. Your intro on camera, then four parts: traders, LPs, agents, and why it works. All
footage is real, recorded on the hosted app. Every number on screen comes from the app or the
benchmark files.

The voice-over runs at about 125 words a minute, a relaxed speaking pace. Each part has room to
breathe. The times are when each line should start; being a second early or late is fine.

---

## Intro, on camera (0:00 to 0:18)

Record it as `demo/footage/intro.mp4`. The video takes its length from the file, so aim for about
18 seconds; anything longer pushes the total past three minutes.

> Say you hold JUP and want protection from a crash. On ETH you'd buy a put. Most Solana tokens
> have no options market at all. But they do trade on Orca, and that's enough.
> This is FORGE, built for the Dev3pack hackathon.

(40 words)

---

## Part 1: traders (0:19 to 1:30) · `vo-1.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 0:19 | Title, then the landing page; the cursor clicks **Launch App** | "First, traders. From the landing page, I open the app." |
| 0:26 | The market dropdown opens, **JUP/USDC**; **Connect**, demo wallet | "I pick JUP and connect a demo wallet. It runs on a mainnet fork: real pools, test money." |
| 0:34 | The Strategy dropdown opens, **Collar**; floor −12%, cap +15% | "Then the hedge: a collar. Twelve percent down is my floor, fifteen up is my cap." |
| 0:42 | Dragging the cap point on the chart | "Dragging the chart does the same thing." |
| 0:45 | Duration **7d** | "And I want it for one week." |
| 0:48 | **Compile**, the suggested budget, compile again | "Compile, and take the suggested budget." |
| 0:54 | Ranges, cost, certificate | "These are the Orca ranges, the cost, and a certified worst-case error." |
| 0:59 | **Open position** (sped up) | "Open it on-chain." |
| 1:02 | The position: ends in 7 days, premium, exposure | "My position ends in seven days. I can see what I've paid and my exposure right now." |
| 1:11 | **Close**, settled | "Closing gives the LPs their liquidity back and pays me out." |
| 1:18 | The Architect: a sentence in, options out, **Choose** | "Don't want to fill in a form? Tell the Architect what you want. It comes back with real options, and I still sign." |

(about 140 words)

---

## Part 2: liquidity providers (1:30 to 1:47) · `vo-2.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 1:30 | Title, the Earn page, picking a bucket | "The other side: liquidity providers. You deposit into a price range, and it earns normal Orca fees." |
| 1:38 | Deposit $500 | "When a trader borrows it, you get paid at least the fees you missed." |
| 1:42 | Earnings panel | "Your earnings are broken down below." |

(36 words)

---

## Part 3: agents (1:47 to 2:17) · `vo-3.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 1:47 | Title, the landing page's **For agents** view | "Agents can do all of this too. They pay per request in USDC over x402, with no account or API key." |
| 1:56 | A real treasury agent run in the terminal: 402, pays $0.01, options, checks, asks its human, "y", opened | "Here's a treasury agent. It finds its biggest risk, JUP, and asks for a hedge. FORGE replies with a price; the agent pays one cent. It gets certified options back, checks them against its rules, and asks its human. One yes, and the position is open." |

(65 words)

---

## Part 4: why it works (2:17 to 2:57) · `vo-4.wav`

| Time | On screen | Voice-over |
|---|---|---|
| 2:17 | Title, then a range below the price; the price falls through it | "An Orca range below the price holds only USDC. FORGE borrows it and locks the USDC. If the price falls, giving the range back costs less, and the trader keeps the difference. That's a put." |
| 2:31 | The compiler stacks ranges onto the payoff; ±bound; certificate | "The compiler stacks ranges until they match your payoff, and proves the worst-case gap." |
| 2:40 | The x402 exchange, with the transaction from that run | "Agents pay over x402: HTTP's 402 status, turned into a USDC payment on Solana." |
| 2:47 | Proof numbers count up | "And it holds up: nineteen of twenty-three payoffs built on thin liquidity, with zero certificate violations." |
| 2:53 | Logo, site, repo | "That's FORGE. Try it at the link below." |

(about 85 words)

---

## Recording tips

- One voice-over file per part, `vo-1.wav` to `vo-4.wav` in `demo/footage/`. Each starts at its
  part's title card. If a take runs long, it just overlaps the next part's title a little; keep
  each under the part's length to be safe (71 s, 17 s, 30 s, 40 s).
- Use a plain, darkish background for the intro so it matches the video.
- Re-render with `cd demo && npm run render`. The output is `demo/out/forge-demo.mp4`.
