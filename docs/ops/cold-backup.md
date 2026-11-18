# Cold Backup & Isolated Recovery

`scripts/cold-backup.mjs` provides a Linux ops CLI to copy declared roots completely, verify SHA-256 manifests, and restore into a fenced directory that blocks accidental Application Host startup. It does **not** replay WALs, migrate schemas, or perform live hot snapshots.

## Prerequisites & Scope

1. **Stop all writers first** (disable Docker/systemd auto-restart): Host, user commands, editors, external harnesses, and anything touching workspaces. Wait for confirmed exit (if shutdown reported `incomplete`, ensure the supervisor killed the process tree). Leave WAL and `.publish` files intact — they are crash-recovery inputs.
2. `--writers-stopped` is an operator assertion (the script sets a startup fence during copy and checks metadata/hash drift, which cannot substitute for actually stopping writers).
3. Include the entire `VARIN_DATA_DIR` (Rust Storage, Agent Catalog + ContentStore, KnowledgeStore, `hostId`, extensions, auth/pairing — treat the whole backup as secret-bearing). Declare external mounts (`workspaces`, `ssh`, `cloudflared`, linked Git common dirs) via `--scope name=dir`. Roots must not overlap; absolute/escaping symlinks, sockets, FIFOs, and devices are rejected.

```sh
node scripts/cold-backup.mjs create \
  --data-dir /srv/varin/data/varin \
  --scope workspace=/srv/varin/workspaces \
  --scope ssh=/srv/varin/data/ssh \
  --scope cloudflared=/srv/varin/data/cloudflared \
  --output /srv/backups/varin-2026-11-06 \
  --writers-stopped

node scripts/cold-backup.mjs verify --input /srv/backups/varin-2026-11-06
```

Manifests verify file presence, extra files, permissions, symlinks, and SHA-256 digests (`0700` root; hashes are integrity checks, not encryption).

## Isolated Inspection Copy (Default)

```sh
node scripts/cold-backup.mjs restore \
  --input /srv/backups/varin-2026-11-06 \
  --output /srv/isolated/varin-check
```

Writes `.varin-offline-restore.json` before copying data so normal Host startup fails closed. Keep the copy network-isolated when inspecting or testing schema upgrades; inspection copies cannot be promoted via `activate`. Running a live independent clone with a new identity is **not** supported.

## Disaster Recovery of the Original Logical Host

```sh
node scripts/cold-backup.mjs restore \
  --input /srv/backups/varin-2026-11-06 \
  --output /srv/recovery/varin --mode recovery

# Lift the startup fence only after verifying all three operator checks:
node scripts/cold-backup.mjs activate --restored-root /srv/recovery/varin \
  --source-fenced --effects-reviewed --bindings-reviewed
```

Operator checks required before `activate`:
1. `--source-fenced`: Original instance (and any other copy with the same `hostId`) is fenced off and cannot reconnect or restart.
2. `--effects-reviewed`: External side effects after the backup timestamp have been reconciled (`unknown` receipts stay unknown; never auto-replayed).
3. `--bindings-reviewed`: Absolute workspace paths, mounts, SSH/tunnels, model accounts, external harnesses, and schedules match (the tool never rewrites paths inside DBs).

Mount restored scopes at their expected paths and boot the matching Varin release so native owners run normal crash recovery. Regression tests: `node --test scripts/cold-backup.test.mjs`.
