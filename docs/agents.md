# FORGE for agents (x402)

Other programs, including other AI agents, can buy FORGE's financial engineering per request, with no
account and no API key: they pay in USDC over [x402](https://solana.com/x402/what-is-x402), the HTTP 402
payment protocol. FORGE is its own facilitator: it checks each payment, pays the transaction fee, settles it
on Solana, and only then does the work.

> **Test environment.** Payments settle on FORGE's Surfpool fork of Solana mainnet in fork USDC. The network
> id is `solana:forge-surfpool`, not mainnet's, so a client configured for mainnet refuses it, and the
> service refuses to start unless its settlement RPC is a Surfpool fork. No real funds are involved.

## Endpoints

| Endpoint | What it does | Price |
|---|---|---|
| `GET /x402` | Discovery: endpoints, prices, network, asset, payee, rules | free |
| `GET /x402/markets` | Supported markets with prices and compile hints | free |
| `POST /x402/verify` | Re-verify a certificate (hash and exact error bound) | free |
| `POST /x402/compile` | Compile a payoff into a construction and certificate | $0.01 |
| `POST /x402/hedge` | Describe a hedge in words; the Architect returns verified alternatives with what is needed to open them | provisional |

The hedge price is provisional until the cost of a model run has been measured. Certificates are also
public at `GET /compiler/certificates/<hash>`, and the unsigned open transactions come from `POST /tx/build/open`.

## Paying

1. Call a paid endpoint. The answer is `402` with a `PAYMENT-REQUIRED` header: scheme `exact`, the amount,
   the asset (USDC), the payee, FORGE's fee payer, a recent blockhash and a one-time challenge.
2. Build a transaction with only a compute-budget limit and price, one USDC `TransferChecked` for exactly
   the amount to the payee's token account, and a memo carrying the challenge. Sign it as the payer; the
   fee payer is FORGE's facilitator, so the payer needs no SOL.
3. Send the same request again, byte for byte, with the `PAYMENT-SIGNATURE` header.

FORGE checks the network, asset, amount, payee, signatures, allowed instructions, compute caps and that the
fee payer appears nowhere else, then settles and waits for confirmation before it runs the work. The answer
carries a `PAYMENT-RESPONSE` header with the settlement transaction.

The challenge is bound to the request (method, path and body hash) and expires after two minutes. A
payment can be used once. If the work fails after payment, FORGE answers `502` with a receipt, and the same
request with the same payment is served again without a second charge for 15 minutes.

In TypeScript the repository's client does all of this, and checks the price against your cap before
anything is signed:

```ts
import { fetchWithPayment } from "@forge/fork/x402-client";
const { response, settlement } = await fetchWithPayment(url, { method: "POST", headers, body }, signer, {
  maxAtomicPerRequest: 50_000n, // $0.05: refuse anything pricier
});
```

## The treasury agent

`agents/treasury` is an example customer: an AI treasury agent for a simulated DAO treasury holding JUP,
KMNO and JLP. It is not part of the FORGE app and uses only the public endpoints above.

It reads its treasury and policy, works out which exposure to protect, requests a hedge over x402, re-verifies
every option it gets back and checks it against its policy in code (market, size, premium budget, protection
at the policy's maximum decline, funded liquidity). Then it stops and asks its human signer. Only on approval
does it build, sign and send the open on the fork. Its API budget and per-call cap are enforced in code
before any payment is signed.

```
pnpm --filter @forge/treasury-agent run fund     # give it its simulated portfolio on a local fork
pnpm --filter @forge/treasury-agent run smoke    # the paid path without a model: pay, compile, verify
FORGE_API=<gateway> ANTHROPIC_API_KEY=... pnpm --filter @forge/treasury-agent start
```
