# Security model

Status: Pi-native host, desktop, recovery, and extension boundaries in place; release verification active

Last updated: 2026-08-24

## Protected assets

- Provider and MCP credentials.
- Source files, ignored files, and workspace history.
- Pi session contents and prompt history.
- Extension configuration and project-local executable resources.
- Host operating-system access available to Pi tools and extensions.

## Trust boundaries

1. The renderer is untrusted relative to Electron main and workers.
2. A project is untrusted until its Pi resources and executable MCP configuration are approved.
3. Third-party Pi packages are executable code, not passive themes or metadata.
4. Model providers and web research providers are external data recipients.
5. A remote client is never equivalent to a local desktop client without an explicit capability
   grant.

## Required controls

- Context isolation enabled and Node integration disabled in every renderer window.
- Explicit preload methods with input validation; no generic `send(channel, payload)` escape hatch.
- Pi and extension execution restricted to isolated worker processes.
- Renderer logs redact credential values, prompt bodies, file contents, authorization headers, and
  environment values.
- Project trust approval includes executable paths, command lines, cwd, environment key names, and
  changed capabilities.
- Credential storage uses Pi's auth runtime or an operating-system credential store.
- Local HTTP helpers bind loopback, use unpredictable bearer/session tokens, and are not exposed to
  remote renderers without a brokered tunnel.
- Recovery actions use session/workspace writer leases and explicit user confirmation for data
  deletion or hard restore.
- Web fetch keeps private/reserved network ranges blocked by default. Browser-cookie access is
  explicit opt-in.

## Extension capability labels

Varin reports observed capabilities rather than claiming a complete sandbox:

- filesystem read/write;
- subprocess execution;
- network access;
- model/provider request;
- session mutation;
- workspace recovery;
- persistent storage;
- credential store;
- interactive UI;
- background processes.

These labels inform trust decisions. They do not reduce the operating-system permissions of an
extension process.

## Release gates

- Dependency lockfile and reproducible clean install.
- Protocol fuzz/bounds tests.
- No secrets in packaged defaults or fixture logs.
- Electron security smoke test.
- Native dependency and asar-unpack inventory.
- Windows child-process shutdown and orphan scan.
- Recovery crash-injection and concurrent-writer tests.
- Installer upgrade/uninstall data-retention test.

Security-sensitive behavior changes require an architecture note and focused regression test.

### Desktop renderer credential boundary

Electron keeps saved host tokens, custom request headers, local filesystem identity, and relay host
identity in the main process. A preload obtains the current window's bootstrap over synchronous IPC
at document start; the main process returns those sensitive fields only when the requesting frame is
the packaged `varin-ui://app` renderer, the exact local application origin, or the exact development
UI origin. They are never passed through Chromium `additionalArguments`, where operating-system
process inspection and crash diagnostics could expose them.

Remote pages rendered inside a desktop window retain presentation and window-management commands,
but cannot enumerate saved hosts, probe arbitrary addresses through the main process, or discover the
desktop LAN address. Navigation hands only `http:` and `https:` URLs to the operating system; custom,
file, and script protocols are denied.

Document replacement writes a temporary sibling and renames it over the destination. If replacement
is unavailable on the current filesystem, the write fails and preserves the previous document; it
does not delete the destination to force the rename.

The OpenChamber fork migration must preserve its stronger workspace containment, remote-client
capabilities and allowed-directory policy, external-access audit, renderer origin gates, and
awaited background shutdown semantics. Deleting an OpenCode-specific module does not authorize
deleting the security boundary that module currently enforces.

## Upstream dependency baseline

Pi `0.84.3` publishes `brace-expansion` `5.0.9` and `undici` `8.9.0` in its npm shrinkwrap, so
Varin no longer mutates Pi's installed dependency tree after installation. The root and cloud
lockfiles keep those resolved versions reproducible. Confirm both resolutions
when the bundled Pi moves; the floor is the requirement, and the exact Pi release is only where it
currently comes from.

The root `allowScripts` policy pins approval to esbuild `0.28.1`, whose postinstall validates its
platform binary. The no-op Google GenAI preinstall and protobufjs postinstall are explicitly denied;
new or changed dependency lifecycle scripts remain visible during clean install.
