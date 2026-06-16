<#
.SYNOPSIS
  Interim weekly SFTP -> R2 pull from a laptop, until the EC2 Hyderabad sync is
  allowlisted by MedGenome. Re-runnable: copies only new files (skip-by-size),
  never deletes, so R2 keeps growing.

.PREREQUISITES
  rclone installed, with two remotes already configured on this machine:
    - partner : sftp  (host sftp.medgenome.com, port 2222, user/pass)
    - r2      : s3 (Cloudflare R2, bucket variantgpt)

.USAGE
  pwsh -File tracks\sync-local.ps1                 # last 90 days
  pwsh -File tracks\sync-local.ps1 -MaxAge 30d     # just the freshest
  pwsh -File tracks\sync-local.ps1 -MaxAge 365d    # a year

  Register as a weekly task (see the bottom of this file).
#>
param(
  [string]$Source    = "partner:/projects",
  [string]$Dest      = "r2:variantgpt/data/incoming",
  [string]$MaxAge    = "90d",
  [int]   $Transfers = 8,
  [string]$LogDir    = "$env:LOCALAPPDATA\vgpt-sync"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  Write-Error "rclone not found on PATH. Install it (see infra/SYNC_AWS_HYDERABAD.md) or add it to PATH."
  exit 1
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$log   = Join-Path $LogDir "sync_$stamp.log"

Write-Host "[$(Get-Date -Format o)] SFTP -> R2 copy : $Source -> $Dest (max-age $MaxAge)"
Write-Host "log: $log"

# copy (never deletes) | --size-only (skip files already in R2) | --max-age (skip
# the partner's purged-empty old folders). Speed flags help over a slow uplink.
rclone copy $Source $Dest `
  --s3-no-check-bucket `
  --size-only `
  --max-age $MaxAge `
  --transfers $Transfers `
  --sftp-concurrency 64 `
  --multi-thread-streams 4 `
  --stats 30s --stats-one-line `
  --log-file $log --log-level INFO `
  -P

$code = $LASTEXITCODE
Write-Host "[$(Get-Date -Format o)] done (exit $code)  log: $log"

# Keep only the last 12 logs.
Get-ChildItem $LogDir -Filter "sync_*.log" | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 12 | Remove-Item -Force -ErrorAction SilentlyContinue

exit $code

<#
  REGISTER AS A WEEKLY TASK (run once, in this repo dir; no admin needed for a
  user-context task — the laptop must be on/logged in at the scheduled time):

    $script = (Resolve-Path .\tracks\sync-local.ps1).Path
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
                 -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 2am
    Register-ScheduledTask -TaskName "VariantGPT-WeeklySync" -Action $action `
      -Trigger $trigger -Description "Interim weekly SFTP->R2 sync (until EC2 is allowlisted)"

  Remove later (once the EC2 cron takes over):
    Unregister-ScheduledTask -TaskName "VariantGPT-WeeklySync" -Confirm:$false
#>
