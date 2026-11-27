# The Architect

The Studio has two ways in. **Draw what you want:** drag the payoff and compile it. **Describe what you
want:** open the Architect and say it in words, for example *"I hold 20,000 JUP. Protect me against a
crash, I can give up some upside, and I don't want to spend more than $100 on premium."*

The Architect is an AI agent (Claude) that does the financial engineering around the compiler. It does not
do the math, and it cannot touch funds.

| Step | Done by |
|---|---|
| Understand the objective, separate hard limits from preferences | Claude |
| Choose structures to try (protective put, collar, put spread, custom) | Claude |
| Read holdings, prices, past price moves and funded liquidity | FORGE services |
| Build the payoff from the chosen levels | FORGE (deterministic) |
| Feasibility, legs, capital, certified worst-case error | FORGE compiler and verifier |
| Premium floor, budget and keeper facts | FORGE program rules |
| Sign and open | You, with your wallet |

## What you get

Usually three alternatives, such as maximum protection, balanced and budget-optimized. Each is a card whose
numbers come from the compiler: floor and cap, size, the certified worst-case error, premium from (per day),
the most you can pay, capital locked and the number of ranges, plus the certificate hash. The Architect
writes only the title, a one-line summary and the trade-offs.

**Review in Studio** loads the construction onto the chart with its limits; from there you compile and open
it exactly as if you had drawn it. **Choose** asks the Architect to prepare it, which checks it again and
loads it into the Studio for your signature.

## The rules the backend enforces

These live in the agent service, not in the prompt:

- An option can only be shown if this conversation compiled it and its certificate verified.
- A construction can only be prepared if it compiled within tolerance, verified, has funded liquidity for
  every borrowed range, is less than 10 minutes old, and the pool has not moved more than the open tolerance
  since. Preparing never signs or sends anything.
- If no construction meets every hard limit you gave, the Architect says which limit blocks it and labels
  the closest alternative as a compromise for you to approve. It does not quietly relax a limit.

## Privacy

The model sees the balances of supported tokens in your wallet (or the holdings you type), market data and
the compiler's results. It does not see your wallet address. Requests go to Anthropic's API, which keeps
inputs and outputs for a limited time under its commercial terms.

## Models

`ANTHROPIC_MODEL` (default `claude-sonnet-5-5`) runs conversations; `ANTHROPIC_ADVANCED_MODEL`
(`claude-opus-5-5`) is available per conversation. The model is fixed for a whole conversation, because
reasoning carried between turns is tied to the model. Which one is the default is decided by the eval in
`services/agent/eval` (objectives graded in code for constraint compliance, correctness, grounding of every
dollar figure, outcome, safety and cost), not assumed.
