#!/usr/bin/env bash
# Exercises built production bytes. Run `bun run build` first; no deployment is
# made outside this invocation's temporary directory and loopback listener.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNNER_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/varin-cloud-smoke.XXXXXX")
export RUNNER_TEMP
ROOT="$RUNNER_TEMP/varin-cloud-deploy"
DATA_DIR="$ROOT/data"
GOOD_ARCHIVE="$RUNNER_TEMP/varin-cloud-good.tgz"
BAD_SOURCE="$RUNNER_TEMP/varin-cloud-bad-source.tgz"
BAD_ARCHIVE="$RUNNER_TEMP/varin-cloud-bad.tgz"
IDEMPOTENT_ARCHIVE="$RUNNER_TEMP/varin-cloud-idempotent.tgz"
INSECURE_ENV_ARCHIVE="$RUNNER_TEMP/varin-cloud-insecure-env.tgz"
INSECURE_ENV_FILE="$RUNNER_TEMP/varin-cloud-insecure.env"
LINK_ARCHIVE="$RUNNER_TEMP/varin-cloud-link-failure.tgz"
LOCK_ARCHIVE="$RUNNER_TEMP/varin-cloud-lock-failure.tgz"
PORT=

cleanup() {
  if [ -f "$ROOT/current/packages/web/bin/cli.js" ]; then
    VARIN_DATA_DIR="$DATA_DIR" node "$ROOT/current/packages/web/bin/cli.js" stop --port "$PORT" >/dev/null 2>&1 || true
  fi
  rm -rf "$RUNNER_TEMP"
}
trap cleanup EXIT
PORT=$(node -e "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")

verify_good() {
  test "$(basename "$(readlink -f "$ROOT/current")")" = "$GOOD_RELEASE"
  node --input-type=module -e "const response=await fetch('http://127.0.0.1:${PORT}/health');const body=await response.json();if(!response.ok||body.status!=='ok'||body.releaseId!=='${GOOD_RELEASE}'||body.kernel?.ready!==true)throw new Error(JSON.stringify(body));"
}

node scripts/build-cloud-runtime.mjs \
  --skip-build \
  --output "$RUNNER_TEMP/varin-cloud-runtime" \
  --archive "$GOOD_ARCHIVE"
cp "$GOOD_ARCHIVE" "$BAD_SOURCE"
GOOD_SHA=$(sha256sum "$GOOD_ARCHIVE" | awk '{print $1}')
GOOD_RELEASE="good-${GOOD_SHA:0:16}"

bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$GOOD_ARCHIVE" \
  --sha256 "$GOOD_SHA" \
  --release-id "$GOOD_RELEASE" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR"

verify_good

cp "$BAD_SOURCE" "$IDEMPOTENT_ARCHIVE"
bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$IDEMPOTENT_ARCHIVE" \
  --sha256 "$GOOD_SHA" \
  --release-id "$GOOD_RELEASE" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR"
verify_good

cp "$BAD_SOURCE" "$INSECURE_ENV_ARCHIVE"
printf '%s\n' 'VARIN_UI_PASSWORD=not-a-real-secret' > "$INSECURE_ENV_FILE"
chmod 0644 "$INSECURE_ENV_FILE"
if bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$INSECURE_ENV_ARCHIVE" \
  --sha256 "$GOOD_SHA" \
  --release-id "insecure-env-${GOOD_SHA:0:16}" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR" \
  --env-file "$INSECURE_ENV_FILE"; then
  echo "Deployment unexpectedly sourced a group/world-readable secret file." >&2
  exit 1
fi
verify_good

cp "$BAD_SOURCE" "$LOCK_ARCHIVE"
printf '%s\n' "$$" > "$ROOT/.deploy.lock"
if bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$LOCK_ARCHIVE" \
  --sha256 "$GOOD_SHA" \
  --release-id "locked-${GOOD_SHA:0:16}" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR"; then
  echo "Concurrent deployment unexpectedly acquired the active lock." >&2
  exit 1
fi
rm -f "$ROOT/.deploy.lock"
verify_good

cp "$BAD_SOURCE" "$LINK_ARCHIVE"
FAKE_BIN="$RUNNER_TEMP/varin-cloud-fake-bin"
MV_FAILURE_MARKER="$RUNNER_TEMP/varin-cloud-mv-failed"
REAL_MV=$(command -v mv)
mkdir "$FAKE_BIN"
cat > "$FAKE_BIN/mv" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "-Tf" ] && [ ! -e "$MV_FAILURE_MARKER" ]; then
  touch "$MV_FAILURE_MARKER"
  exit 73
fi
exec "$REAL_MV" "\$@"
EOF
chmod +x "$FAKE_BIN/mv"
if PATH="$FAKE_BIN:$PATH" bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$LINK_ARCHIVE" \
  --sha256 "$GOOD_SHA" \
  --release-id "link-failure-${GOOD_SHA:0:16}" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR"; then
  echo "Deployment with an injected current-link failure unexpectedly succeeded." >&2
  exit 1
fi
test -e "$MV_FAILURE_MARKER"
verify_good

mkdir "$RUNNER_TEMP/varin-cloud-bad"
tar -xzf "$BAD_SOURCE" -C "$RUNNER_TEMP/varin-cloud-bad"
node -e "require('node:fs').writeFileSync(process.argv[1], 'throw new Error(\"intentional cloud rollback smoke failure\");\n')" \
  "$RUNNER_TEMP/varin-cloud-bad/packages/web/server/index.js"
tar -czf "$BAD_ARCHIVE" -C "$RUNNER_TEMP/varin-cloud-bad" .
BAD_SHA=$(sha256sum "$BAD_ARCHIVE" | awk '{print $1}')

if bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$BAD_ARCHIVE" \
  --sha256 "$BAD_SHA" \
  --release-id "$GOOD_RELEASE" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR"; then
  echo "A release id was unexpectedly reused for a different archive." >&2
  exit 1
fi
verify_good

if bash scripts/deploy-cloud-runtime.sh \
  --root "$ROOT" \
  --archive "$BAD_ARCHIVE" \
  --sha256 "$BAD_SHA" \
  --release-id "bad-${BAD_SHA:0:16}" \
  --port "$PORT" \
  --bind-host 127.0.0.1 \
  --data-dir "$DATA_DIR" \
  --health-timeout 5; then
  echo "Broken cloud runtime unexpectedly deployed successfully." >&2
  exit 1
fi

verify_good
