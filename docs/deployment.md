# Deployment

FORGE runs as two pieces: the website on Vercel and the fork backend on Railway. Both deploy on every
push to `main`.

## Website (Vercel)

- Project root: `app/` (the build reads `../docs` and `../benchmarks/results`, so the whole repository
  is uploaded; `.vercelignore` keeps build artifacts and price data out).
- Build: `node scripts/sync-benchmarks.mjs && next build`.
- Environment:

| Variable | Value |
|---|---|
| `FORGE_API_URL` | The Railway backend URL. `/api/indexer`, `/api/compiler`, `/api/tx` and `/api/control` are rewritten to it. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `<backend>/rpc` (the fork's public RPC proxy). |
| `NEXT_PUBLIC_SOLANA_WS_URL` | `wss://<backend host>/rpc` |

## Backend (Railway)

One container (`deploy/railway/Dockerfile`, configured in `.railway/railway.ts`) runs:

| Process | Port | Public route |
|---|---|---|
| Surfpool mainnet fork | 8899 | via the RPC proxy |
| RPC proxy (method allowlist, no cheatcodes) | 8890 | `/rpc` |
| Indexer | 8787 | `/indexer` |
| Transaction builder | 8788 | `/tx` |
| Compiler API | 8000 | `/compiler` |
| Demo control (faucet, mirror, markets) | 8791 | `/control` |
| Gateway | `$PORT` | everything above, plus `/health` |

On start (`deploy/railway/start.sh`) the container creates fork-only keys, starts the fork, writes the
program onto it by cheatcode (no program keypair is needed), registers SOL/USDC and JUP/USDC, adds the
mints in `FORGE_EXTRA_MINTS` (BONK by default) and starts the services. Every deploy is a fresh fork of
current mainnet; nothing on the fork persists.

| Variable | Purpose |
|---|---|
| `FORGE_ALLOWED_ORIGINS` | Comma-separated site origins allowed by CORS. |
| `DEMO_CONTROL_TOKEN` | Bearer token for the scenario and time-travel routes. Secret. |
| `FORK_RPC_URL` | Optional private mainnet RPC used read-only as the fork's datasource. |
| `MAINNET_RPC_URL` | Optional RPC for reading balances when mirroring a wallet. |
| `FORGE_EXTRA_MINTS` | Space-separated token mints to add as markets at start. |

The program binary is committed at `deploy/railway/forge.so` with its SHA-256. After changing the
program, rebuild (`anchor build`) and copy `target/deploy/forge.so` there.

## Local

```
./fork/start.sh                       # the fork
pnpm --filter @forge/fork bootstrap   # program and markets
./fork/dev-stack.sh                   # services
pnpm --filter @forge/app dev          # the site on :3000
```
