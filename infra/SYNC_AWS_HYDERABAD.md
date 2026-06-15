# Partner SFTP → R2 sync from an AWS Hyderabad VM

MedGenome's SFTP allowlists client IPs and requires an **Indian** IP. Fly has no
Hyderabad region (and Mumbai is capacity-constrained), so the sync runs on a
small AWS EC2 in **ap-south-2 (Hyderabad)** with a static **Elastic IP** that
MedGenome allowlists. The VM pulls SFTP → R2 daily (server-to-server, no laptop).

The transfer logic is `tracks/sync_ftp_to_r2.sh` (hardened: creds only in a 0600
temp rclone config, never on the command line / in logs).

## 1. Launch the VM (AWS console or CLI)
- Region: **Asia Pacific (Hyderabad) / ap-south-2**
- AMI: Ubuntu 22.04/24.04 LTS · Instance: **t3.small** (2 GB; rclone is light,
  but multi-GB transfers like a bit of headroom) · 20 GB gp3 disk
- Key pair: your SSH key
- Security group:
  - **Inbound:** SSH (22) from *your* admin IP only
  - **Outbound:** allow all (needs SFTP:22 to MedGenome + HTTPS:443 to R2)

## 2. Allocate + associate an Elastic IP
EC2 → Elastic IPs → Allocate → Associate to the instance. **Note this IP — give
it to MedGenome to allowlist** for SFTP user `Dr_Rajesh_Bendre.11496`.

```bash
# (CLI alternative)
aws ec2 allocate-address --region ap-south-2
aws ec2 associate-address --region ap-south-2 --instance-id <i-...> --allocation-id <eipalloc-...>
```

## 3. Install rclone + the sync script
SSH in, then:
```bash
sudo -v ; curl https://rclone.org/install.sh | sudo bash   # latest rclone
rclone version

sudo mkdir -p /opt/vgpt-sync && sudo chown "$USER" /opt/vgpt-sync
# Copy the script from your repo checkout (run locally):
#   scp tracks/sync_ftp_to_r2.sh ubuntu@<elastic-ip>:/opt/vgpt-sync/
#   scp tracks/sync.env.example  ubuntu@<elastic-ip>:/opt/vgpt-sync/sync.env
chmod +x /opt/vgpt-sync/sync_ftp_to_r2.sh
```

## 4. Configure secrets
```bash
cd /opt/vgpt-sync
# edit sync.env with the real FTP + R2 values (ROTATE the SFTP password first)
nano sync.env
chmod 600 sync.env
```

## 5. Validate (once MedGenome has allowlisted the Elastic IP)
Confirm the connection + a capped first sync before pulling everything:
```bash
cd /opt/vgpt-sync
set -a; . ./sync.env; set +a

# (a) connectivity only — list remote folders (no transfer):
rclone lsf ":sftp,host=$FTP_HOST,user=$FTP_USER,pass=$(rclone obscure "$FTP_PASS")":"$FTP_PATH" --dirs-only | head

# (b) capped first sync to validate end-to-end (stops after ~5 GB):
RCLONE_EXTRA='--max-transfer 5G' bash sync_ftp_to_r2.sh

# (c) full sync once validated:
bash sync_ftp_to_r2.sh
```
A successful run mirrors `sftp:/projects/<patient>/…` → `r2:variantgpt/data/incoming/`,
and the samples appear in the app's **Data** tab automatically.

## 6. Daily schedule (cron)
```bash
( crontab -l 2>/dev/null; echo '0 2 * * * cd /opt/vgpt-sync && set -a && . ./sync.env && set +a && /opt/vgpt-sync/sync_ftp_to_r2.sh >> /var/log/vgpt-sync.log 2>&1' ) | crontab -
```
Runs daily at 02:00 IST-ish (set the VM timezone or adjust the hour). New partner
uploads sync automatically; `--size-only` means unchanged files aren't re-pulled.

## Notes
- **Cost:** t3.small (~$15/mo) + Elastic IP (free while associated) + R2 storage
  (grows with data; R2 has no egress fees). Stop the instance between syncs to
  save compute if desired — but keep the Elastic IP associated so it stays
  allowlisted.
- **Security:** the Elastic IP is the only thing MedGenome allowlists; the SFTP
  password lives only in `sync.env` (0600) and the temp rclone config. Rotate the
  password (the old one was exposed in a log) and keep `sync.env` off git.
