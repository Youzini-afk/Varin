#!/bin/sh
set -eu
# Invoked only by the user's Prepare Desktop operation, never ordinary startup.
if [ "$(id -u)" = 0 ]; then
  privilege=''
else
  privilege='sudo -n'
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo 'Automatic desktop preparation currently requires Debian or Ubuntu (apt). Existing desktops remain usable.' >&2
  exit 1
fi
$privilege apt-get update
$privilege env DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core libatk-adaptor tigervnc-standalone-server xfce4 dbus-x11 xauth fonts-noto-cjk
if ! command -v firefox-esr >/dev/null 2>&1; then
  if ! apt-cache show firefox-esr >/dev/null 2>&1; then
    # Mozilla's official DEB avoids depending on an interactive Snap session.
    $privilege env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
    key_file="$(mktemp)"
    trap 'rm -f "$key_file"' EXIT HUP INT TERM
    curl --fail --location https://packages.mozilla.org/apt/repo-signing-key.gpg --output "$key_file"
    fingerprint="$(gpg --show-keys --with-colons "$key_file" | awk -F: '$1 == "fpr" { print $10; exit }')"
    if [ "$fingerprint" != 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3 ]; then
      echo 'Mozilla repository signing key did not match its published identity' >&2
      exit 1
    fi
    $privilege install -d -m 0755 /etc/apt/keyrings
    $privilege install -m 0644 "$key_file" /etc/apt/keyrings/varin-mozilla.asc
    printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/varin-mozilla.asc] https://packages.mozilla.org/apt mozilla main' | $privilege tee /etc/apt/sources.list.d/varin-mozilla.list >/dev/null
    $privilege apt-get update
  fi
  $privilege env DEBIAN_FRONTEND=noninteractive apt-get install -y firefox-esr
fi
if [ -n "${key_file:-}" ]; then rm -f "$key_file"; fi
exec /usr/bin/python3 "$(dirname "$0")/desktop.py" prepare "$@"
