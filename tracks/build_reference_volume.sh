#!/usr/bin/env bash
# Populate the reference volume (mounted at /refs) with the GRCh38 reference and
# its BWA index, so the engine can align FASTQ -> BAM and run GATK without
# downloading a multi-GB reference per case.
#
# Downloads the FASTA + .fai + .dict from the public Broad bucket (no R2 creds
# needed), then builds the BWA index (~1 h for the human genome).
#
# RUN ONCE, detached, inside a machine that has the /refs volume mounted:
#   fly ssh console -a variantgpt-engine
#   nohup bash /app/tracks/build_reference_volume.sh >/tmp/refbuild.log 2>&1 &
# (then poll /tmp/refbuild.log)
set -e

# Default: a refs/ subdir on the AnnotSV volume (Fly allows only one volume, so
# reference + AnnotSV DB co-locate). Override with REF_DIR if mounted elsewhere.
REF_DIR="${REF_DIR:-/opt/AnnotSV/share/refs}"
BASE="https://storage.googleapis.com/gcp-public-data--broad-references/hg38/v0"
FASTA="Homo_sapiens_assembly38.fasta"

mkdir -p "$REF_DIR"
cd "$REF_DIR"

dl() { # url dest — skip if already present (resumable re-runs)
  if [ -f "$2" ]; then echo "exists: $2"; else
    echo "downloading: $2"; curl -fL --retry 8 --retry-delay 5 -o "$2" "$1"
  fi
}

echo "=== DOWNLOAD reference ==="
dl "$BASE/$FASTA"        "$FASTA"
dl "$BASE/$FASTA.fai"    "$FASTA.fai"
dl "$BASE/Homo_sapiens_assembly38.dict" "Homo_sapiens_assembly38.dict"

echo "=== BWA_INDEX_START ($(date -u +%H:%M:%S)) ==="
if [ -f "$FASTA.bwt" ]; then
  echo "BWA index already present — skipping"
else
  bwa index "$FASTA"
fi
echo "=== BWA_INDEX_DONE ($(date -u +%H:%M:%S)) ==="

echo "=== CONTENTS ==="
ls -lh "$REF_DIR"
df -h "$REF_DIR" | tail -1
echo "REFERENCE_VOLUME_DONE"
