#!/usr/bin/env bash
# Start a local Surfpool mainnet fork for development.
# Never use mainnet funds: the fork only reads mainnet state and keeps all writes local.
set -euo pipefail

SURFPOOL_VERSION="1.8.0"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$HERE/.state"
mkdir -p "$STATE"

have="$(surfpool --version 2>/dev/null | awk '{print $2}')"
if [[ "$have" != "$SURFPOOL_VERSION" ]]; then
  echo "surfpool $SURFPOOL_VERSION required (found: ${have:-none})." >&2
  echo "Install: https://github.com/txtx/surfpool/releases/tag/v$SURFPOOL_VERSION" >&2
  exit 1
fi

# FORK_RPC_URL lets you use a private mainnet RPC as the read-only datasource.
datasource=(--network mainnet)
if [[ -n "${FORK_RPC_URL:-}" ]]; then datasource=(--rpc-url "$FORK_RPC_URL"); fi

exec env NO_DNA=1 surfpool start "${datasource[@]}" \
  --no-tui --no-studio --no-deploy \
  --host "${FORK_HOST:-127.0.0.1}" \
  --port "${FORK_RPC_PORT:-8899}" --ws-port "${FORK_WS_PORT:-8900}" \
  --log-path "$STATE/logs" "$@"
