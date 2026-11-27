# FORGE backend for Railway: Surfpool mainnet fork + compiler API + indexer + transaction builder +
# RPC proxy + demo control, behind one gateway on $PORT. Fork-only funds; keys are generated inside the
# container; the program is installed on the fork by cheatcode, so no program keypair is needed.
# Build context: the repository root.
FROM node:22.23.1-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.11 /uv /usr/local/bin/uv

ARG SURFPOOL_VERSION=1.8.0
RUN curl -fsSL "https://github.com/txtx/surfpool/releases/download/v${SURFPOOL_VERSION}/surfpool-linux-x64.tar.gz" \
  | tar xz -C /usr/local/bin surfpool \
 && surfpool --version

RUN corepack enable
WORKDIR /forge
COPY . .

# Node services (no web app) and the Python compiler API
RUN pnpm install --frozen-lockfile --filter @forge/fork... --filter @forge/indexer... --filter @forge/txbuilder... --filter @forge/agent...
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv sync --frozen --no-dev --extra api

ENV FORGE_KEY_DIR=/data/keys \
    FORGE_CERT_STORE=/data/certificates \
    FORGE_INSTALL_MODE=cheatcode \
    FORGE_PROGRAM_SO=/forge/deploy/railway/forge.so \
    PORT=8080
EXPOSE 8080
CMD ["bash", "deploy/railway/start.sh"]
