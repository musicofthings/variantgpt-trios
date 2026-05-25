# VariantGPT engine container — runs the Python pipeline behind a tiny HTTP
# service that the Cloudflare Worker invokes per case.
#
# Kept slim: pure-Python stack only (no cyvcf2/pysam in this image — those need
# htslib and blow the size up). Real WGS work via tabix will land in a v2
# image; the demo trio + uploaded uncompressed VCFs run fine on pure Python.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# --- Engine source ---
# Copy only what the runtime actually needs. The engine package's heavy
# dependencies (cyvcf2, pysam, polars, CrossMap) are pinned in pyproject.toml
# but the pure-Python slice uses just pydantic + httpx + requests + pyyaml,
# so we install those directly to keep the image small.
COPY engine/pyproject.toml /app/engine/pyproject.toml
COPY engine/README.md /app/engine/README.md
COPY engine/src /app/engine/src

# --- Track / runner scripts the container server reuses ---
COPY tracks /app/tracks

# Lean dependency set for the container image.
RUN pip install \
    "pydantic>=2.6" \
    "pyyaml>=6.0" \
    "httpx>=0.27" \
    "requests>=2.32" \
    "networkx>=3.2" \
    "starlette>=0.37" \
    "uvicorn>=0.30" \
 && pip install --no-deps -e /app/engine

EXPOSE 8080

# tracks/container_server.py exposes POST /run and GET /healthz on :8080.
CMD ["python", "-m", "uvicorn", "tracks.container_server:app", "--host", "0.0.0.0", "--port", "8080"]
