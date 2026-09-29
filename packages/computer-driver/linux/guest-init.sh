#!/bin/bash
set -euo pipefail

# cloud-init runs this once. Later package upgrades replace only /opt/varin/runtime
# from the attached seed; /var/lib/varin contains the persistent user state.
SEED=/mnt/varin-seed
STATUS=/var/lib/varin/bootstrap.status
mkdir -p /var/lib/varin /opt/varin /etc/varin
printf 'preparing\n' > "$STATUS"
on_exit() {
  local code=$?
  if (( code != 0 )); then printf 'failed: %s\n' "$code" > "$STATUS"; fi
}
trap on_exit EXIT

if ! mountpoint -q "$SEED"; then
  mkdir -p "$SEED"
  seed_device="$(blkid -L cidata || blkid -L CIDATA)"
  mount -o ro "$seed_device" "$SEED"
fi
install -m 0600 "$SEED/guest.env" /etc/varin/guest.env
install -m 0755 "$SEED/guest-upgrade.sh" /opt/varin/guest-upgrade.sh

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates qemu-guest-agent
systemctl enable --now qemu-guest-agent
/bin/bash /opt/varin/guest-upgrade.sh

# The managed desktop has its own long-lived user, browser profile and files.
sh /opt/varin/runtime/packages/web/server/computer-driver/linux/prepare-desktop.sh \
  --data-dir /var/lib/varin/computer-desktop

cat > /etc/systemd/system/varin-guest.service <<'UNIT'
[Unit]
Description=Varin guest Host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/varin/guest.env
WorkingDirectory=/opt/varin/runtime
ExecStartPre=/bin/bash /opt/varin/guest-upgrade.sh
ExecStart=/opt/varin/runtime/node /opt/varin/runtime/packages/web/bin/cli.js serve --foreground --host 0.0.0.0 --port 8765
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now varin-guest.service
printf 'ready\n' > "$STATUS"
