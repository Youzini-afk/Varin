#!/bin/sh
set -eu
if command -v genisoimage >/dev/null 2>&1; then exit 0; fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo 'Automatic NoCloud seed preparation requires Debian or Ubuntu (apt)' >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then privilege=''; else privilege='sudo -n'; fi
$privilege apt-get update
$privilege env DEBIAN_FRONTEND=noninteractive apt-get install -y genisoimage
