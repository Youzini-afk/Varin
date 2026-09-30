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
$privilege env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 ca-certificates
exec /usr/bin/python3 "$(dirname "$0")/desktop.py" prepare "$@"
