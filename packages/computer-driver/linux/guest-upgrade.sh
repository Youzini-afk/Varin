#!/bin/bash
set -euo pipefail

# Runs before each Host start. The seed ISO may have been replaced while the
# VM was shut off. Install a complete new runtime before changing the active
# pointer, leaving /var/lib/varin and desktop/browser profiles untouched.
SEED=/mnt/varin-seed
BASE=/opt/varin
STATUS=/var/lib/varin/bootstrap.status
mkdir -p "$SEED" "$BASE" /var/lib/varin
staged=''
previous="$BASE/runtime-previous"
on_exit() {
  local code=$?
  if (( code != 0 )); then
    printf 'failed: runtime upgrade (%s)\n' "$code" > "$STATUS"
    if [[ ! -d "$BASE/runtime" && -d "$previous" ]]; then mv "$previous" "$BASE/runtime"; fi
  fi
  if [[ -n "$staged" && -d "$staged" ]]; then rm -rf -- "$staged"; fi
}
trap on_exit EXIT
printf 'preparing\n' > "$STATUS"
if ! mountpoint -q "$SEED"; then
  seed_device="$(blkid -L cidata || blkid -L CIDATA)"
  mount -o ro "$seed_device" "$SEED"
fi
cd "$SEED"
sha256sum --check --status bundle.sha256
desired="$(sha256sum runtime.tgz | cut -d' ' -f1)"
update_self() {
  install -m 0755 "$SEED/guest-upgrade.sh" "$BASE/guest-upgrade.next"
  mv -f -- "$BASE/guest-upgrade.next" "$BASE/guest-upgrade.sh"
}
if [[ -f "$BASE/runtime.sha256" && -d "$BASE/runtime" && "$(cat "$BASE/runtime.sha256")" == "$desired" ]]; then
  update_self
  printf 'ready\n' > "$STATUS"
  exit 0
fi

staged="$(mktemp -d "$BASE/runtime-new.XXXXXX")"

tar -xzf "$SEED/runtime.tgz" -C "$staged"
install -m 0755 "$SEED/node" "$staged/node"
install -m 0755 "$SEED/bun" "$staged/bun"
cd "$staged"
./bun install --production --frozen-lockfile
./node verify-kernel.mjs packages/web

# This path is owned only by the managed guest. The old runtime is retained
# until the new tree has passed install and kernel verification.
if [[ -d "$previous" ]]; then rm -rf -- "$previous"; fi
if [[ -d "$BASE/runtime" ]]; then mv "$BASE/runtime" "$previous"; fi
mv "$staged" "$BASE/runtime"
staged=''
update_self
# Upgrade the desktop helper as well. The VM was shut off for the seed swap,
# so no user interaction is in progress, but its dimensions and profile stay.
desktop_data=/var/lib/varin/computer-desktop
desktop_script="$BASE/runtime/packages/web/server/computer-driver/linux/desktop.py"
if [[ -f "$desktop_data/config.json" ]]; then
  read -r width height < <(/usr/bin/python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["width"], c["height"])' "$desktop_data/config.json")
  /usr/bin/python3 "$desktop_script" stop --data-dir "$desktop_data"
  sh "$BASE/runtime/packages/web/server/computer-driver/linux/prepare-desktop.sh" \
    --data-dir "$desktop_data" --width "$width" --height "$height"
fi
printf '%s\n' "$desired" > "$BASE/runtime.sha256"
printf 'ready\n' > "$STATUS"
if [[ -d "$previous" ]]; then rm -rf -- "$previous"; fi
