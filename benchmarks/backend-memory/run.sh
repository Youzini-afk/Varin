#!/usr/bin/env bash
set -euo pipefail
image="$1"
variant="$2"
source_sha="$3"
script_dir="$(cd "$(dirname "$0")" && pwd)"
output="$(realpath -m "$4")"
mkdir -p "$output"
name="varin-memory-${variant}"
sampler=''
cleanup() {
  touch "$output/stop-sampler"
  if [ -n "$sampler" ]; then wait "$sampler" || true; fi
  docker inspect "$name" > "$output/container-final.json" 2>/dev/null || true
  docker logs "$name" > "$output/server.log" 2>&1 || true
  docker rm --force "$name" 2>/dev/null || true
  sudo chown -R "$(id -u):$(id -g)" "$output" || true
  python3 "$script_dir/summarize.py" "$output" > "$output/summary.stdout.json" || true
}
trap cleanup EXIT
printf 'startup' > "$output/phase"
# Explicit benchmark limits, not a proposed production hard limit.
docker run --detach --init --cpus=2 --memory=2g --memory-swap=2g --pids-limit=512 \
  --name "$name" --env VARIN_UI_PASSWORD=varin-memory-fixture-only \
  --publish 127.0.0.1:3000:3000 "$image"
docker inspect "$name" > "$output/container-initial.json"
docker image inspect "$image" > "$output/image.json"
uname -a > "$output/host.txt"
lscpu >> "$output/host.txt"
free -b >> "$output/host.txt"
docker version >> "$output/host.txt"
pid="$(docker inspect --format '{{.State.Pid}}' "$name")"
sudo python3 "$script_dir/sample.py" "$pid" "$output" &
sampler=$!
for attempt in $(seq 1 120); do
  if curl --fail --silent http://127.0.0.1:3000/health > "$output/health.json"; then break; fi
  if [ "$attempt" -eq 120 ]; then echo 'Host did not become ready' >&2; exit 1; fi
  sleep 1
done
EXPECTED="image-$source_sha" HEALTH="$output/health.json" node --input-type=module -e 'import fs from "node:fs";const h=JSON.parse(fs.readFileSync(process.env.HEALTH));if(h.releaseId!==process.env.EXPECTED)throw Error(JSON.stringify(h));'
printf 'idle' > "$output/phase"
sleep 60
printf 'prepare' > "$output/phase"
node "$script_dir/load.mjs" "$name" "$output"
printf 'recovery' > "$output/phase"
sleep 60
curl --fail --silent http://127.0.0.1:3000/health > "$output/final-health.json"
