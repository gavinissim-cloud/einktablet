#!/bin/bash
# Startup script for a free Google Cloud server (an "e2-micro" VM; see the
# README, "A free server on Google Cloud"). Paste it into the VM's
# "Startup script" box. It runs on every boot: the first boot installs
# everything (about 10 minutes), later boots fetch the newest version of the
# app and restart it, so restarting the VM is how you update.
#
# Settings come from the VM's metadata (Edit VM -> Metadata), not from this
# script, so no keys are written here:
#   gemini-api-key   the Gemini API key (required)
#   signup-code      the code people need to sign up (recommended)
#
# The site is served over HTTPS at https://<external IP with dashes>.sslip.io
# (sslip.io turns the address into a name, so a certificate can be issued
# without buying a domain). Documents and learning are kept in
# /var/lib/hebrew-handwriting on the VM's disk.
set -euo pipefail

REPO=https://github.com/gavinissim-cloud/einktablet.git
BRANCH=claude/hebrew-handwriting-converter-oqrwqk
APP=/opt/hebrew-handwriting
DATA=/var/lib/hebrew-handwriting

meta() { curl -fsS -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1" 2>/dev/null || true; }
say() { echo "hebrew-handwriting: $*"; echo "hebrew-handwriting: $*" > /dev/console 2>/dev/null || true; }

# The free VM has 1 GB of memory; swap keeps installs from running out.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile
fi
swapon /swapfile 2>/dev/null || true

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  say "installing Node.js"
  apt-get update -q
  apt-get install -y -q ca-certificates curl git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null; then
  say "installing Caddy (HTTPS)"
  apt-get install -y -q caddy
fi

id -u hw >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin hw
mkdir -p "$DATA" && chown hw:hw "$DATA" && chmod 700 "$DATA"

say "fetching the app"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$APP"
fi
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)

KEY=$(meta instance/attributes/gemini-api-key)
CODE=$(meta instance/attributes/signup-code)
[ -n "$KEY" ] || say "WARNING: no gemini-api-key in the VM's metadata; pages can't be read"
umask 077
cat > /etc/hebrew-handwriting.env <<EOF
NODE_ENV=production
PORT=3000
DATA_DIR=$DATA
TRUST_PROXY=1
GEMINI_API_KEY=$KEY
SIGNUP_CODE=$CODE
EOF
umask 022

cat > /etc/systemd/system/hebrew-handwriting.service <<EOF
[Unit]
Description=Hebrew handwriting to text
After=network-online.target
Wants=network-online.target

[Service]
User=hw
WorkingDirectory=$APP
EnvironmentFile=/etc/hebrew-handwriting.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q hebrew-handwriting
systemctl restart hebrew-handwriting

IP=$(meta instance/network-interfaces/0/access-configs/0/external-ip)
if [ -n "$IP" ]; then
  HOST="${IP//./-}.sslip.io"
  cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl restart caddy
  say "ready at https://$HOST"
else
  say "WARNING: the VM has no external IP address, so the site can't be reached"
fi
