#!/usr/bin/env bash
# Container entrypoint: start the fork, bootstrap the markets, then the services and the gateway.
# Each container start is a fresh fork of mainnet (state is not kept across deploys).
set -euo pipefail
cd /forge

log() { echo "[forge] $*"; }
pids=()
start() { log "starting $1"; shift; "$@" & pids+=($!); }
trap 'kill ${pids[@]} 2>/dev/null || true' EXIT INT TERM

export FORGE_ALLOWED_ORIGINS="${FORGE_ALLOWED_ORIGINS:-https://forge-agr18.vercel.app}"
export DEMO_CONTROL_TOKEN="${DEMO_CONTROL_TOKEN:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
mkdir -p "$FORGE_KEY_DIR" "$FORGE_CERT_STORE"

# 1. fork-only keys, created here and never shipped
pnpm --dir fork exec tsx scripts/keys.ts

# 2. the fork (FORK_RPC_URL: optional private mainnet RPC as the read-only datasource)
start surfpool env FORK_HOST=127.0.0.1 bash fork/start.sh
for i in $(seq 1 120); do
  if curl -fs -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' http://127.0.0.1:8899 >/dev/null; then break; fi
  sleep 1
done
log "fork is up"

# 3. program (cheatcode install) and the built-in markets (extra mints are added once the services run)
pnpm --filter @forge/fork bootstrap

# 4. services, as in fork/dev-stack.sh, plus the public gateway
ALT="$(node -e 'const d=require("./fork/.state/deployment.json");console.log(Object.values(d.markets).map(m=>m.lookupTable).join(","))')"
start compiler-api uv run --no-sync uvicorn forge_api.app:app --host 127.0.0.1 --port 8000 --workers 2 --log-level warning
start indexer env PORT=8787 pnpm --dir services/indexer start
start txbuilder env PORT=8788 FORGE_LOOKUP_TABLES="$ALT" FORGE_DEPLOYMENT_FILE="$PWD/fork/.state/deployment.json" pnpm --dir services/txbuilder start
start rpc-proxy env PORT=8890 pnpm --dir fork proxy
start control env PORT=8791 pnpm --dir fork control
start keeper pnpm --dir fork keeper
# the Architect (turns are refused, and the Studio works as before, when ANTHROPIC_API_KEY is unset)
start agent env PORT=8792 pnpm --dir services/agent start
start gateway env PORT="${PORT:-8080}" pnpm --dir fork exec tsx src/gateway.ts

# 5. extra markets, in the background so the health check passes meanwhile; the services pick them up
#    from the chain and from deployment.json as each one lands
(
  # BONK, KMNO and JLP by default (KMNO and JLP make up the treasury-agent demo portfolio with JUP)
  for mint in ${FORGE_EXTRA_MINTS:-DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS 27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4}; do
    FORGE_SKIP_DEPLOY=1 pnpm --filter @forge/fork bootstrap -- --mint "$mint" || log "could not add $mint (skipped)"
  done
  log "extra markets done"
) &

# any service exiting stops the container, so Railway restarts it cleanly (onboarding is not watched)
wait -n "${pids[@]}"
log "a process exited; stopping"
exit 1
