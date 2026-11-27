# The Solana stack

FORGE is Solana end to end: an Anchor program that composes Orca Whirlpools and Pyth on-chain, and
TypeScript services built on `@solana/kit` and the official program clients. This page maps each
library to where it is used and why.

## On-chain (Rust)

| Library | Used for | Where |
|---|---|---|
| `anchor-lang` 1.2.2 | Accounts, PDAs (market, vault, buckets, strategies, escrows), constraints, events, errors, the IDL | `programs/forge/src` |
| `anchor-spl` (token, token_2022, associated_token) | Vault and escrow token accounts, signed transfers out of PDA vaults, closing escrows | `token_util.rs`, `instructions/*` |
| Orca Whirlpools (CPI, hand-built) | `open_position`, `increase_liquidity`, `decrease_liquidity`, `update_fees_and_rewards`, `collect_fees`, `swap`; reading Whirlpool, Position and both tick-array layouts to measure fee growth inside a range | `orca.rs`, `docs/orca-integration.md` |
| Pyth (`PriceUpdateV2`, read on-chain) | The reference price for open tolerance, restoration guards and premium conversion: feed id, verification level, staleness and confidence checked in the program | `reference.rs` |
| Solana fixed-point math | Premium, utilization multiplier, protocol fee, Q64.64 prices and sqrt-price limits, all in integers | `math/premium.rs`, `math/orca.rs` |

The Orca CPI is built by hand because no Anchor 1.x-compatible Whirlpools CPI crate exists; the
discriminators and layouts are pinned and tested against Orca's own TypeScript SDK
(`pnpm --dir fork vectors`). Pyth accounts are parsed directly for the same reason (the receiver
SDK pins an older Anchor).

## Off-chain (TypeScript)

| Library | Used for | Where |
|---|---|---|
| `@solana/kit` 5.5.1 | Typed RPC and RPC subscriptions, v0 transaction messages, signers (keypair, no-op for unsigned builds, partial signing), codecs, address derivation, simulation | every package (35 import sites) |
| `@solana/kit` `sendAndConfirmTransactionFactory` | Confirmation over a WebSocket signature subscription raced against blockhash expiry, instead of polling | `fork/src/surfnet.ts`, `fork/src/keeper.ts`, `agents/treasury` |
| `@solana/kit` `createRpc` + `createJsonRpcApi` | A typed client for Surfpool's fork-only cheatcodes (`surfnet_setAccount`, `surfnet_setTokenAccount`, `surfnet_timeTravel`) on kit's own RPC machinery | `fork/src/surfnet.ts` |
| `@solana/kit` codecs | Decoding the Clock sysvar and FORGE's accounts from the IDL | `fork/src/surfnet.ts`, `services/txbuilder/src/idl.ts` |
| Address lookup tables (`@solana-program/address-lookup-table`) | One table per market so multi-leg opens and closes fit in v0 transactions | `fork/src/alt.ts`, `services/txbuilder/src/tx.ts` |
| `@solana-program/compute-budget` | Compute-unit limits sized from simulation; a capped compute-unit price on x402 payments | `services/txbuilder/src/tx.ts`, `fork/src/x402-client.ts` |
| `@solana-program/token`, `@solana-program/system` | Associated token accounts, wSOL wrap/sync, `TransferChecked` (x402 payments), SOL transfers | fork tooling, txbuilder, x402, keeper |
| `@orca-so/whirlpools-core` | Tick and price math, liquidity to token amounts, the same math the program runs | txbuilder, indexer, tests |
| `@orca-so/whirlpools-client` / `@orca-so/whirlpools` | Decoding Whirlpool, Position and tick-array accounts; pool discovery and seeding on the fork | txbuilder, fork bootstrap, tests |
| Metaplex Token Metadata (PDA read) | Symbols for any SPL token a user adds | `services/indexer/src/server.ts` |
| Wallet Standard (`@wallet-standard/app`, `standard:connect`) | Connecting a real wallet read-only, to mirror its balances onto the fork | `app/src/lib/wallet.tsx` |
| x402 (exact scheme on SVM) | Agents pay per request with a partially signed USDC `TransferChecked` + memo; FORGE verifies, co-signs as fee payer and settles | `fork/src/x402.ts`, `fork/src/x402-client.ts` |
| Surfpool | A mainnet fork with Orca's and Pyth's real programs and accounts; cheatcodes for funding, price scenarios and time travel | `fork/`, `deploy/railway` |

## How a position touches it all

1. **Compile.** The compiler fits a payoff to Orca ranges using the program's integer math.
2. **Build.** `services/txbuilder` turns legs into FORGE instructions and adds a compute-unit
   limit, sized by simulating against the live fork state. Lookup tables keep each
   transaction under the size limit, and each comes back with its blockhash's last valid block
   height.
3. **Sign and send.** The user's wallet, a burner, or an agent's key signs, and the transaction is
   confirmed with kit.
4. **Open.** The program checks the Pyth reference, then CPIs into Orca to remove each borrowed
   range's liquidity into escrow.
5. **While open.** The keeper (kit) checkpoints legs, reading fee growth inside each range from
   Orca's tick arrays, and closes positions at their on-chain triggers.
6. **Close.** The program restores each range through Orca CPIs, swaps through a second pool under
   a slippage guard, and pays premium to the LPs' index and the protocol's share to the market.
