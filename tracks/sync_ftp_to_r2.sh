#!/usr/bin/env bash
# Daily partner-lab SFTP -> R2 sync.
#
# Pulls sample folders from the partner SFTP straight into R2 (server-to-server,
# no laptop round-trip) under data/incoming/. Runs daily (cron). Idempotent:
# rclone COPY only transfers files not already in R2 (by size), and NEVER deletes
# — so R2 is a durable, growing archive even after the partner purges old data.
#
# Required env (set as Fly app secrets — never commit):
#   FTP_HOST FTP_USER FTP_PASS               partner SFTP login
#   R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ACCOUNT_ID   Cloudflare R2 (same as Worker)
# Optional env:
#   FTP_PATH      remote dir to mirror     (default: /)
#   FTP_PORT      SFTP port                (default: 22)
#   DATA_PREFIX   R2 destination prefix    (default: data/incoming)
#   R2_BUCKET     bucket name              (default: variantgpt)
#
# SECURITY: credentials are written ONLY to a 0600 temp rclone config in tmpfs,
# referenced by remote name — never passed on the command line or echoed (rclone
# logs remote NAMES, not inline creds), so a failure can't leak the password.
set -euo pipefail

: "${FTP_HOST:?set FTP_HOST}" "${FTP_USER:?set FTP_USER}" "${FTP_PASS:?set FTP_PASS}"
: "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_ACCOUNT_ID:?}"
FTP_PATH="${FTP_PATH:-/}"
FTP_PORT="${FTP_PORT:-22}"
DATA_PREFIX="${DATA_PREFIX:-data/incoming}"
R2_BUCKET="${R2_BUCKET:-variantgpt}"

# Locked-down temp config (tmpfs, 0600, removed on exit).
CFG="$(mktemp /tmp/rclone.XXXXXX.conf)"
chmod 600 "$CFG"
trap 'rm -f "$CFG"' EXIT
cat > "$CFG" <<CONF
[partner]
type = sftp
host = ${FTP_HOST}
port = ${FTP_PORT}
user = ${FTP_USER}
pass = $(rclone obscure "${FTP_PASS}")

[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
CONF

echo "[$(date -u +%FT%TZ)] sync sftp://${FTP_HOST}:${FTP_PORT}${FTP_PATH} -> r2:${R2_BUCKET}/${DATA_PREFIX}"

# copy (not sync): never deletes from R2 — accumulating archive.
# --size-only: SFTP has no cheap checksum, so skip files already in R2 with the
# same size (avoids re-pulling unchanged multi-GB FASTQs each day).
# RCLONE_EXTRA carries retention/limit flags, e.g. --max-age 180d (partner purges
# old data, so this skips scanning empty old folders).
rclone --config "$CFG" copy "partner:${FTP_PATH}" "r2:${R2_BUCKET}/${DATA_PREFIX}" \
  --s3-no-check-bucket \
  --size-only \
  --transfers 4 --checkers 8 \
  --sftp-disable-hashcheck \
  --stats 30s --stats-one-line \
  --log-level INFO \
  ${RCLONE_EXTRA:-}

echo "[$(date -u +%FT%TZ)] sync complete"
