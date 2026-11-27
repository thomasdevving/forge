# FORGE compiler API (FastAPI + NumPy/SciPy/HiGHS). Build from the repository root:
#   docker build -f services/compiler-api/Dockerfile -t forge-compiler-api .
FROM python:3.12.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:0.9.11 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY math ./math
COPY compiler ./compiler
COPY verifier ./verifier
COPY services/compiler-api ./services/compiler-api
RUN uv sync --frozen --no-dev --extra api
RUN useradd --system --uid 10001 forge && mkdir -p /data && chown forge /data
USER forge
ENV FORGE_CERT_STORE=/data/certificates PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=10s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["uvicorn", "forge_api.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
