#!/usr/bin/env bash
# Populate the AnnotSV share/ directory (program data + human annotation
# databases) onto the Fly volume mounted at $ANNOTSV/share.
#
# WHY: the engine image is built with INSTALL_ANNOTSV_DB=false (lean image), and
# fly.toml mounts a persistent volume over /opt/AnnotSV/share — which shadows the
# program's baked-in share/ files. This script reinstalls BOTH the program share
# data AND the ~3 GB human annotations onto the volume, so AnnotSV works and the
# data survives restarts/redeploys.
#
# RUN ONCE, inside a running engine machine that has the volume mounted:
#   fly ssh console
#   bash /app/tracks/populate_annotsv_db.sh
#
# Takes a while (multi-GB download). Re-runnable (idempotent-ish: it re-installs).
set -euo pipefail

ANNOTSV="${ANNOTSV:-/opt/AnnotSV}"
VER="${ANNOTSV_VERSION:-v3.4.2}"

echo ">> Populating AnnotSV under ${ANNOTSV} (version ${VER})"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --depth 1 --branch "${VER}" https://github.com/lgmgeo/AnnotSV.git "$tmp/AnnotSV"

# Reinstall program share/ onto the (otherwise empty) mounted volume, then the
# human annotation databases.
make -C "$tmp/AnnotSV" PREFIX="${ANNOTSV}" install
make -C "$tmp/AnnotSV" PREFIX="${ANNOTSV}" install-human-annotation

echo ">> Done. Verifying AnnotSV responds..."
if AnnotSV -help >/dev/null 2>&1; then
  echo ">> OK — AnnotSV is functional. Annotations under ${ANNOTSV}/share"
else
  echo ">> WARNING: AnnotSV -help failed; check the install output above." >&2
  exit 1
fi
