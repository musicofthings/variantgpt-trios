#!/usr/bin/env bash
# Daily partner-lab SFTP -> R2 sync.
#
# Pulls sample folders from the partner SFTP straight into R2 (server-to-server,
# no laptop round-trip) under data/incoming/. Designed to run on a Fly scheduled
# machine (cron). Idempotent: rclone sync only transfers new/changed files.
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

# --size-only: SFTP has no cheap checksum, so compare by size (filenames are
# unique per sample); avoids re-pulling unchanged multi-GB FASTQs each day.
# Subset/limits can be passed via RCLONE_EXTRA (e.g. --include or --max-transfer).
rclone --config "$CFG" sync "partner:${FTP_PATH}" "r2:${R2_BUCKET}/${DATA_PREFIX}" \
  --s3-no-check-bucket \
  --size-only \
  --transfers 4 --checkers 8 \
  --sftp-disable-hashcheck \
  --stats 30s --stats-one-line \
  --log-level INFO \
  ${RCLONE_EXTRA:-}

echo "[$(date -u +%FT%TZ)] sync complete"
