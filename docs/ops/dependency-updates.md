# Dependency Maintenance

See [development.md](../development.md) and [ops/README.md](README.md).

## Security Audits & Local Patches

- [scripts/audit-dependencies.mjs](../../scripts/audit-dependencies.mjs) owns active advisory exceptions and consumer-level behavior checks. Published upstream fixes are always preferred over local patches.
- Remaining local `bun-patches/` fixes (e.g. `braces`, `http-cache-semantics`, `sprintf-js`, `deepmerge`, and `bash-language-server` Zod 4 backport) only exempt their version-based advisories after passing real-consumer regression checks; remove each patch and exception as soon as a fixed upstream release lands.
- Keep `package.json` overrides and `scripts/cloud-runtime.bun.lock` synchronized so production containers get the exact same security fixes.

## Dependabot Policy

Configured in [.github/dependabot.yml](../../.github/dependabot.yml):

| Ecosystem | Schedule (UTC) | Cooldown |
| --- | --- | --- |
| Bun `/` | Daily 00:00 | 1d patch / 3d minor / 7d major (3d other) |
| Cargo `/kernel` | Daily 01:00 | 1d patch / 3d minor / 7d major (3d other) |
| GitHub Actions `/` | Monday 02:00 | 3d |

- Coupled ecosystems (React, PDF.js/canvas, CodeMirror/Lezer, Vite, Vitest, ESLint, Electron, Capacitor, SQLite, tree-sitter/Wasmtime/Cranelift, artifact actions) are grouped for joint review; auth, network, native, compiler, and risky `0.x` packages stay ungrouped.
- `triviumdb-upgrade-0.8` is a legacy migration reader pinned on the `0.8` line — never bump it alongside current `triviumdb`.
- Security updates bypass normal cooldowns, but note that Dependabot does not yet generate automated security PRs for Bun — handle urgent Bun advisories proactively. Auto-merge stays off.

## PR Preflight, Reports & Cloud Lockfile

- **Preflight**: Dependabot PRs run frozen lockfile checks (lifecycle scripts disabled) and verify the production dependency graph against `scripts/cloud-runtime.bun.lock`.
- **Automated report**: [dependency-report.yml](../../.github/workflows/dependency-report.yml) collects upstream changelogs/compare links into a single PR comment + artifact (read-only metadata; never runs PR code). Test parser with `node --test scripts/dependabot-report.test.mjs`.
- **Updating production lock**: Whenever runtime dependencies or overrides change, run:
  ```sh
  bun run update:cloud-runtime-lock
  ```
  and review the diff (see [cloud-deployment.md](cloud-deployment.md#building-the-canonical-runtime-directly)).
