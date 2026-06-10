# VariantGPT engine container — runs the Python pipeline behind a tiny HTTP
# service the Cloudflare Worker invokes per case.
#
# This image now ships the bioinformatics toolchain needed for the aligned-reads
# path (BAM/CRAM → GATK best-practices calling) and the SV/CNV path
# (GATK gCNV → AnnotSV → ClinGen-2019 classification), in addition to the
# pure-Python SNV pipeline.
#
# NOTE (unverified build): version pins + download URLs below were not built in
# the dev environment. Confirm GATK/AnnotSV versions on the first `fly deploy`
# and adjust the ARGs if a download 404s.
FROM python:3.12-slim-bookworm

ARG GATK_VERSION=4.5.0.0
ARG ANNOTSV_VERSION=v3.4.2
# AnnotSV's human annotation DB is ~3 GB. Baking it in makes a large but
# self-contained image. Set to "false" to skip it and instead mount the DB at
# $ANNOTSV/share via a Fly volume.
ARG INSTALL_ANNOTSV_DB=false
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ANNOTSV=/opt/AnnotSV

WORKDIR /app

# --- System toolchain ---
#   openjdk-17        GATK runtime (GATK 4.5 needs Java 17)
#   samtools/bcftools BAM/CRAM + VCF handling
#   bedtools, tabix   AnnotSV dependencies + bgzip/tabix
#   tcl               AnnotSV is Tcl-based
RUN apt-get update && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        samtools bcftools bedtools tabix \
        tcl \
        curl unzip git ca-certificates procps make \
    && rm -rf /var/lib/apt/lists/*

# --- GATK ---
RUN curl -fsSL -o /tmp/gatk.zip \
        "https://github.com/broadinstitute/gatk/releases/download/${GATK_VERSION}/gatk-${GATK_VERSION}.zip" \
    && unzip -q /tmp/gatk.zip -d /opt \
    && rm /tmp/gatk.zip \
    && ln -s "/opt/gatk-${GATK_VERSION}/gatk" /usr/local/bin/gatk \
    && gatk --version

# --- AnnotSV ---
# Installs the AnnotSV binary into $ANNOTSV. The annotation databases are
# downloaded only when INSTALL_ANNOTSV_DB=true (slow). The `AnnotSV` symlink is
# what sv_calling.annotate_with_annotsv invokes.
# Install AnnotSV and optionally download its human annotation datasets
RUN git clone --depth 1 --branch "${ANNOTSV_VERSION}" \
        https://github.com/lgmgeo/AnnotSV.git /tmp/AnnotSV \
    && cd /tmp/AnnotSV \
    && make PREFIX="${ANNOTSV}" install \
    && if [ "${INSTALL_ANNOTSV_DB}" = "true" ]; then \
           make PREFIX="${ANNOTSV}" install-human-annotation ; \
       else \
           echo "Skipping AnnotSV DB — mount it at ${ANNOTSV}/share via a volume." ; \
       fi \
    && rm -rf /tmp/AnnotSV

# --- Engine source ---
COPY engine/pyproject.toml /app/engine/pyproject.toml
COPY engine/README.md /app/engine/README.md
COPY engine/src /app/engine/src
COPY tracks /app/tracks

# Lean Python dependency set (matches the pure-Python pipeline slice; GATK/AnnotSV
# do the heavy lifting via subprocess, so no cyvcf2/pysam needed here).
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

