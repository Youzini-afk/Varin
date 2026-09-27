# Maintained extension integration

Status: integration contract, not a per-release certification

Last updated: 2026-09-15

## What this document is

This records **what Varin depends on from each maintained Pi extension**: the commands, events,
RPC versions, and native configuration files an adapter reads or invokes. That is the surface that
breaks when a plugin changes, and it is the surface Varin can be held to.

## What this document is not

It is not a certification that each plugin version works on each Pi version.

Varin previously kept a dated table of plugin versions with pass/fail load results against one
exact Pi release. That does not scale: the plugins and Pi both move independently, so the table
becomes a claim nobody re-establishes, and a stale claim of verification is worse than no claim.
Varin therefore does not assert per-release plugin compatibility, and a Pi upgrade is not gated on
re-smoking every plugin.

What is maintained instead:

- Adapters observe availability through a plugin's own public surface, so an incompatible or missing
  plugin degrades to an unavailable state rather than a broken page.
- Varin never reads a plugin's private state, so a plugin's internal changes cannot silently
  corrupt Varin behavior.
- Contract expectations that matter are asserted in code, under `packages/pi-host/test`, rather than
  written down as prose evidence.

If you want a load check for one extension, the harness is still there:

```sh
node scripts/smoke-extension.mjs <path-to-extension-entry>
```

It creates an isolated agent directory and disposable workspace, loads one extension, lists its
registered commands and public read-only MCP catalog when present, then disposes and removes all
test state. It invokes no network, model, recovery, or destructive commands, so it proves entry-point
loading and command registration and nothing more. Published tarballs work when their `pi.extensions`
entries and production dependencies are present.

## Current upstream source audit

The versions below are the sources reviewed on 2026-08-23, not a promise that every runtime path was
exercised on every operating system. They record which upstream contract changed and why an adapter
did or did not need code changes. Published versions come from the npm registry; the local extension
source checkouts used for the audit were fast-forwarded to their tracked upstreams.

| Extension | Source reviewed | Adapter result |
| --- | --- | --- |
| `pi-subagents` | npm/source `0.55.0` | Removed the deleted durable-chain catalog, accepted grouped runtime output, and added the current provider/thinking/output overrides. |
| `pi-background-tasks` | npm/source `2.4.2` | EventBus v1 and Fleet ownership are unchanged; no adapter change. |
| `@cortexkit/pi-magic-context` | npm `0.38.1`; source tag `0.39.0` | Added Todo/Mural controls and `/todos`; 0.39 installations write Pi model execution under `historian.pi` / `dreamer.pi`, while plugin-supported legacy fields remain visible until migrated. |
| `pi-openai-codex-compat` | npm/source `0.0.9` | Recommendation now uses the stable tag and exposes `applyPatchDebug`. |
| `pi-observational-memory` | npm/source `3.0.4` | Native settings and public commands are unchanged; no adapter change. |
| `context-mode` | npm/source `1.0.169` | Still has no single native settings authority; the generic configuration surface remains correct. |
| `@cortexkit/aft-pi` | npm/source `0.52.1` | Added the inspect diagnostics deadline and user-only GitHub CLI shim with the plugin's real project-strip rules. |
| `pi-lens` | npm/source `4.1.1` | The only relevant schema addition is project Helm configuration, already covered by the adapter. |
| `pi-hermes-memory` | npm/source `0.9.6` | Native authority and command observation are unchanged; no adapter change. |
| `pi-rtk-optimizer` | npm/source `0.9.0` | Native JSON and `rtk` command contract are unchanged; the narrower upstream peer range remains metadata, not a Varin compatibility layer. |
| `@varin/pi-mcp-adapter` | upstream `2.29.0`; maintained fork `16123de`; npm `2.29.0-varin.1` | Merged upstream runtime snapshots, progress, cache and raw-tool fixes without dropping `configCatalog/v1`. New Varin installs use the public scoped npm package; the previous maintained Git source and upstream package name remain identity aliases, so existing installations are adopted rather than duplicated or replaced. |
| `pi-web-access` | npm/source `0.24.2` | Added the complete provider list, OpenAI auth-provider priority, summary/inline limits, image/PDF controls, new credentials and API gateway fields. |
| `pi-workspace-history` | npm/source `0.2.2` | Its commands and native settings remain independently available; Varin native recovery neither installs nor invokes it. |
| `pi-wtf` | npm/source `0.2.4` | Commands and `wtf.json` contract are unchanged; no adapter change. |

## Integration surface per extension

Each row is the public contract Varin consumes. Varin owns none of these files or commands.

| Extension | Varin consumes | Native authority |
| --- | --- | --- |
| `pi-wtf` | Registered prompt-repair commands | Plugin-owned `wtf.json` |
| `pi-workspace-history` | Focused native configuration plus ordinary registered commands, independent of Varin recovery | Plugin-owned history store |
| `pi-subagents` | Public `subagents:rpc:v1` with advertised `fleetStatus: { version: 1 }`; provider-owned agent management tool | Scoped Pi `settings.json`, Agent Markdown, and global runtime JSON |
| `pi-background-tasks` | Public EventBus v1 `request`/`response`/`terminal` for Fleet run, bounded logs, kill | Plugin-owned task store |
| `pi-mcp-adapter` | Public `status/v1` snapshots and read-only `configCatalog/v1`; adapter commands | Adapter-reported JSON/JSONC sources (six in normal mode, one in exclusive mode) |
| `pi-web-access` | Registered command catalog for Curator, account diagnostics, stored results | Agent-level `web-search.json` |
| `@cortexkit/pi-magic-context` | Registered `ctx-*` commands; native Pi status component; public custom entries | CortexKit user/project JSONC |
| `pi-openai-codex-compat` | Registered settings command | Global and project `openai-codex-compat.json` |
| `pi-observational-memory` | Registered status/view commands | Native `settings.json#observational-memory` |
| `context-mode` | Generic plugin configuration surface | No single authoritative settings file |
| `pi-lens` | Registered Lens commands and packaged skill commands | Plugin-owned user/recent-project config |
| `pi-hermes-memory` | Presence of `memory-insights` in `command.list` | Agent-root `hermes-memory-config.json` |
| `@cortexkit/aft-pi` | Presence of `aft-status` in `command.list` | CortexKit user `aft.jsonc`, project `.cortexkit/aft.jsonc` |
| `pi-rtk-optimizer` | Presence of the exact `rtk` command | `<agentDir>/extensions/pi-rtk-optimizer/config.json` |

## Ownership rules the adapters keep

- **Recovery** resolves the selected `varin.workspace-recovery@5` Host service. The official
  `varin.builtin.recovery` provider owns affected-file checkpoints, restore, undo, retention, and
  crash reconciliation. `pi-workspace-history` and `pi-wtf` remain optional Pi packages whose own
  commands and settings never satisfy or replace that service.
- **Fleet** is a registry of Host adapters keyed by `providerId + key`. One degraded provider does
  not hide another. The public DTO carries kind, state, name, and advertised actions only; private
  paths, PIDs, output files, and plugin kill messages never reach the renderer, and Varin does not
  read `.pi/tasks` or parse terminal text.
- **MCP** consumes the adapter's status and effective-server projection and edits one revisioned
  native source at a time. Varin never merges the sources in the renderer and never handles
  transports, OAuth, or the credential store. The catalog excludes arguments, environment, headers,
  tokens, OAuth data, and URL credentials.
- **Magic Context** invokes registered `ctx-*` commands and renders only their public entries or UI.
  No private database is inspected.
- **Web Access**, **Codex Compat**, **Observational Memory**, **AFT**, **Hermes Memory**, and **RTK
  Optimizer** each edit only their own native configuration, preserving unknown and future fields.
  Runtime observation is command presence only; command presence proves the extension loaded, not
  that an external binary, provider, or background subsystem is healthy.
- **Availability is reported truthfully.** Transport failure, no active session, an unavailable
  provider, and a successful-but-empty observation stay distinct. No generic loaded or
  reload-needed state is invented where Pi exposes no such contract.

## Version relationships worth knowing

Some upstream metadata does not match Varin's bundled runtime, and that is recorded rather than
worked around:

- `pi-rtk-optimizer` declares peer support that stops well below Varin's bundled Pi. Varin
  integrates the published `npm:pi-rtk-optimizer` package directly and maintains neither a fork nor
  an old-Pi compatibility layer, so the narrower peer range is upstream metadata, not a blocker.
- `pi-openai-codex-compat` declares a Pi range that Varin's bundled runtime satisfies. Its
  provider transport and remote compaction are network paths that entry-point loading does not
  exercise, so Varin does not describe them as verified.

The bundled Pi version is declared once, in `packages/pi-host/package.json`, and read from there by
the handshake tests. Do not copy it into new assertions or documents.
