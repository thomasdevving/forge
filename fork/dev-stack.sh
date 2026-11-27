#!/usr/bin/env bash
# Local FORGE service stack against a running, bootstrapped fork (fork/start.sh + bootstrap):
# compiler API :8000, indexer :8787, txbuilder :8788, public RPC proxy :8890, demo control :8791.
# Ctrl-C stops everything. The app: pnpm --filter @forge/app dev (http://localhost:3000).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# every bootstrapped market's lookup table, comma-separated
ALT="$(python3 -c 'import json;print(",".join(m["lookupTable"] for m in json.load(open("fork/.state/deployment.json"))["markets"].values()))')"
export FORGE_ALLOWED_ORIGINS="${FORGE_ALLOWED_ORIGINS:-http://localhost:3000}"
export DEMO_CONTROL_TOKEN="${DEMO_CONTROL_TOKEN:-local-dev-control-token-$(whoami)}"
pids=()
start() { echo "starting $1"; shift; "$@" & pids+=($!); }
trap 'kill ${pids[@]} 2>/dev/null' EXIT INT TERM
start compiler-api uv run --extra api uvicorn forge_api.app:app --port 8000 --log-level warning
start indexer env PORT=8787 pnpm --dir services/indexer start
start txbuilder env PORT=8788 FORGE_LOOKUP_TABLES="$ALT" FORGE_DEPLOYMENT_FILE="$PWD/fork/.state/deployment.json" pnpm --dir services/txbuilder start
start rpc-proxy env PORT=8890 pnpm --dir fork proxy
start control env PORT=8791 pnpm --dir fork control
wait
