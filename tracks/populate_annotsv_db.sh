#!/usr/bin/env bash
# Populate the AnnotSV share/ directory (program runtime + human annotation
# databases) onto the Fly volume mounted at $ANNOTSV/share.
#
# WHY: the engine image is built with INSTALL_ANNOTSV_DB=false (lean image), and
# fly.toml mounts a persistent volume over /opt/AnnotSV/share. This installs the
# program share AND the human annotations onto the volume so AnnotSV works and
# the data survives restarts/redeploys.
#
# We deliberately DO NOT use AnnotSV's `make install-human-annotation`:
#   - it hardcodes a patch-versioned filename (Annotations_Human_3.4.2.tar.gz)
#     that 404s — the annotation bundles track the MINOR version (3.4), and
#   - it also downloads the ~2.7 GB Exomiser phenotype DB, which this pipeline
#     does not use (we never pass AnnotSV -hpo). Skipping it keeps us well
#     within a 10 GB volume.
#
# RUN ONCE, inside a running engine machine that has the volume mounted:
#   fly ssh console -a variantgpt-engine
#   bash /app/tracks/populate_annotsv_db.sh
set -euo pipefail

ANNOTSV="${ANNOTSV:-/opt/AnnotSV}"
VER="${ANNOTSV_VERSION:-v3.4.2}"
# Annotation bundle version — does NOT track the tool patch version (3.4.2 → 3.4).
ANNOT_VER="${ANNOTSV_ANNOT_VERSION:-3.4}"
BASE_URL="https://www.lbgi.fr/~geoffroy/Annotations"

echo ">> AnnotSV populate: tool ${VER}, annotations ${ANNOT_VER}, prefix ${ANNOTSV}"

# Free space from any previous failed run (e.g. partial Exomiser extraction).
rm -rf "${ANNOTSV}/share/AnnotSV/Annotations_Exomiser" 2>/dev/null || true

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Program share (tcl/python/bash runtime) onto the volume. Idempotent.
echo ">> Installing AnnotSV program files..."
git clone --depth 1 --branch "${VER}" https://github.com/lgmgeo/AnnotSV.git "$tmp/AnnotSV"
make -C "$tmp/AnnotSV" PREFIX="${ANNOTSV}" install >/dev/null

# 2. Human annotations only — download the correct bundle directly and extract.
mkdir -p "${ANNOTSV}/share/AnnotSV"
echo ">> Downloading Annotations_Human_${ANNOT_VER}.tar.gz (~2 GB)..."
curl -fL --retry 3 -o "$tmp/anno.tar.gz" "${BASE_URL}/Annotations_Human_${ANNOT_VER}.tar.gz"
echo ">> Extracting annotations to ${ANNOTSV}/share/AnnotSV/ ..."
tar -xf "$tmp/anno.tar.gz" -C "${ANNOTSV}/share/AnnotSV/"

# 3. Verify.
echo ">> Verifying..."
if AnnotSV -help >/dev/null 2>&1 && [ -d "${ANNOTSV}/share/AnnotSV/Annotations_Human" ]; then
  echo ">> OK — AnnotSV is functional."
  du -sh "${ANNOTSV}/share/AnnotSV/Annotations_Human"
  df -h "${ANNOTSV}/share" | tail -1
else
  echo ">> WARNING: verification failed — check output above." >&2
  exit 1
fi
