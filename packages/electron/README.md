# Varin Desktop

Electron 45 desktop runtime for Varin on macOS (13+), Windows, and Linux (x64 & ARM64). Upgrade
Electron and `electron-context-menu` together because the menu package depends on Electron's
clipboard API.

This package owns the native shell: windows, menus, Mini Chat, deep links, native notifications,
auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The Web
UI and Application Host live in `packages/web`, and shared React UI lives in `packages/ui`.

## Runtime Architecture & Security

- **Embedded Host (full desktop)**: Starts `@varin/web/server/index.js` (`startWebUiServer()`) in
  the Electron main process via `embedded-host.ts` (no separate server sidecar). Bundled entrypoints
  are `bootstrap.mjs`, `dist-bundle/main.mjs`, and `dist-bundle/preload.mjs`. Windows load the HMR
  dev server in development or `resources/web-dist` in packaged builds.
- **Native kernel & Host workers**: The embedded Host launches the Rust kernel from
  `resources/kernel` (Catalog owns Threads, queues, execution, PTYs, and processes; retired
  `node-pty`/`bun-pty` authorities are rejected). Electron supplies Node mode to Host-owned workers
  (no system Node required); worker dependencies stay unpacked outside ASAR. The knowledge DB runs
  in a private Application Host storage process off the window thread; see
  [knowledge storage](../web/application-host/lib/knowledge/DOCUMENTATION.md).
- **LAN access & UI password**: Independent preferences. Enabling LAN binds all interfaces even with
  an empty password, passing `allowUnauthenticatedLan` for that startup without mutating
  `VARIN_ALLOW_UNAUTHENTICATED_LAN`.
- **Iframe & preload security**:
  - Same-origin Thread iframes perform an authenticated parent-frame handshake receiving in-memory
    endpoint/credentials (and public relay descriptor without pairing grant when relay is active),
    never via URLs. Additional windows retain per-window bootstrap state.
  - `preload.ts` exposes `window.__VARIN_DESKTOP__` typed by the single contract at
    `packages/application-client/src/desktop.ts` (imported via `@varin/application-client/desktop`):
    `VarinDesktopCommandMap`, `VarinDesktopBridge`, `VARIN_DESKTOP_COMMAND_LIST`,
    `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS`, and `PreloadBootstrapPayload` (credentials for local pages
    only). `main.ts` validates command names against the catalog and gates non-local renderers with
    `renderer-security-policy.ts` (`renderer-security-policy.test.ts`).
- **Native language & splash**: `native-i18n.ts` covers all 10 locales for native menus, tray,
  dialogs, and computer-control overlays (locale normalization in `application-client/locale`).
  Renderers sync via `desktop_set_locale` -> persisted `desktopLocale` -> `varin:locale-changed`;
  Chromium applies the saved locale on next launch. The early splash paints the shared loading cube's
  static first frame using the resolved theme and splash palette.
- **Quit lifecycle**: Confirms background-work risk, then lets windows run `beforeunload` while the
  embedded Host is still live. `quit-lifecycle.ts` drains Host services and computer controls at
  `will-quit`; an unload veto cancels quit and keeps the Host/tray alive.
- **Local Host startup mode**: Controlled in Settings → Work connections → Connect to an Agent
  (`desktopLocalHostEnabled` in native `settings.json`, applied next launch; explicit restart drains
  lifecycle without installing a downloaded update). Frontend-only mode disables embedded local
  execution and built-in SSH forwarding; the bundled chooser/recovery UI can atomically re-enable
  local startup without deleting saved remotes. `VARIN_SKIP_LOCAL_SERVER=1` and `VARIN_SERVER_URL`
  take precedence; the GUI allows disabling local startup only when bundled recovery assets exist.
- **SSH & tray**: SSH import/lifecycle/forwarding delegates to Application Host `lib/connections`
  (OpenSSH ControlMaster on macOS/Linux; independent hidden OpenSSH processes on Windows). The macOS
  menu bar item can be disabled in General settings (takes effect after restart and stops tray
  subscriptions/polling).

## Main Files

| Path (package-relative unless noted) | Purpose |
| --- | --- |
| `main.ts` | Electron main process, lifecycle, windows, menus, deep links, IPC handlers, updates, Host startup |
| `preload.ts` / `renderer-security-policy.ts` | Safe `window.__VARIN_DESKTOP__` bridge, trusted-origin policy, and remote-safe command gate |
| `startup-url-selection.ts` / `quit-lifecycle.ts` | Bundled/HMR startup URL probe policy and `will-quit` drain lifecycle |
| `embedded-host.ts` / `native-i18n.ts` | In-process `@varin/web` Host loader and 10-language native shell catalog |
| `scripts/electron-dev.mjs` | Dev launcher with Vite HMR + API readiness checks |
| `scripts/build-desktop.mjs` / `scripts/package.mjs` | Desktop product preparation, staging, and `electron-builder` driver |
| `scripts/build-web-assets.mjs` / `scripts/bundle-main.mjs` | Stages `resources/web-dist` and bundles `dist-bundle/{main,preload}.mjs` |
| `scripts/stage-runtime.mjs` / `scripts/verify-native.mjs` | Closed production dependency tree + worker closures; release-kernel & TriviumDB smoke |
| `installer/VarinSetup.cpp` / `resources/installer*.nsh` | Native monochrome Windows NSIS UI plugin, direct 7-Zip extraction, upgrade & cleanup hooks |
| `scripts/build-installer-plugin.cjs` / `resources/` | Builds x86 NSIS plugin + localized copy; packaged web assets, icons, entitlements |

## Development

From the repo root:

```bash
bun install
bun run electron:dev            # HMR dev server + Electron
bun run electron:dev:bundled    # Staged web-dist assets (closer to packaged app)
bun run type-check:electron
bun run lint:electron
bun run --cwd packages/electron verify:native
```

- `bun install` trusts Electron's install script; `postinstall` and `electron:dev` verify Electron
  package/runtime/version/arch agreement and repair interrupted installs automatically. `electron:dev`
  waits for both HMR UI and API before launching the verified installed Electron binary directly.
- **Tests**:
  - `bun run --cwd packages/electron test` — Vitest suite for shell, updater policy, and path-open
    behavior (Linux autostart tests run on Linux only).
  - `bun run --cwd packages/electron test:packaging-tools` — Node helper tests including update
    manifests (also run by root `test:tooling`; avoid running both for the same suite).
  - `bun run --cwd packages/electron test:linux-desktop` — Linux application discovery check.
- **Full repo validation**: `bun run type-check && bun run lint`.

## Packaging

From the repo root:

```bash
bun run electron:build                                 # Native host package -> packages/electron/dist
bun run electron:build:win                             # Windows x64 NSIS (package:win:x64)
bun run electron:smoke:win                             # Clean temp-dir startup + /health smoke
bun run --cwd packages/electron verify:linux-appimage  # ELF, desktop identity & native addon check
bun run branding:generate                              # Regenerate icons/marks (macOS compiles Assets.car)
```

### Build Pipeline, Caching & Payload Verification

- `scripts/package.mjs` drives `scripts/build-desktop.mjs`, consuming shared runtime/frontend/Host/kernel
  products from repo-root `scripts/build-products.mjs` and staging a standalone app under
  `artifacts/build/desktop-<platform>-<arch>/app` (output in `packages/electron/dist`).
- Stage receipts (inputs, toolchain/options, output hashes) live in `artifacts/build/cache`; delete
  them for a clean build. CI imports shared browser and Linux x64 kernel products via
  `VARIN_FRONTEND_ARTIFACT` and `VARIN_KERNEL_ARTIFACT`.
- Main JS lives in ASAR; Node worker dependency closures, native binaries, standard `tsserver`
  `.d.ts` libs (`scripts/node-module-file-policy.cjs`), and `resources/kernel` stay unpacked.
  Frontend assets live only in `resources/web-dist`; Chromium locales are restricted to Varin's 10
  languages; preserve `LICENSE`, `THIRD_PARTY_NOTICES.md`, and kernel notices.
- `scripts/after-pack.cjs` verifies main virtual imports, physical knowledge process, managed script
  runtime, packaged TypeScript compile smoke, PDF/Canvas runtime, kernel hash, and real extension
  broker IPC handshake, while rejecting optional embedding weights, retired `node-pty`/`bun-pty`,
  and duplicate Web payloads.

### Light Desktop Release (`--role=light`)

- Built alongside full in **Release Build** from the same source and shared frontend (staged under
  `artifacts/build/desktop-light-<platform>-<arch>/`; assets named
  `Varin-Light-<version>-{win-<arch>.exe,linux-<x86_64|arm64>.AppImage,mac-<arch>.{dmg,zip}}`).
- Ships no embedded Host, Rust kernel, ripgrep, VM guest, Puppeteer, or native resource drivers, and
  cannot enable a local Host via preferences or env flags. Loads `varin-ui://app/index.html` with
  pre-auth onboarding/recovery; relay profiles check session auth once (timeouts stay on recovery);
  native background SSE is direct-only.
- Uses isolated `userData`/`sessionData` (never reads/migrates `VARIN_DATA_DIR`) and dedicated
  updater channels (`light.yml`, `light-arm64.yml`, `light-linux.yml`, `light-linux-arm64.yml`;
  macOS Light is manual unsigned DMG with no auto-update feed). Light is a separate product, not an
  in-place full-to-light migration.

### Optional desktop companions

- Managed in **Preferences → Desktop companion** (download/cancel/resume, appearance selection,
  deletion, wake/sleep; sleeping closes native windows without affecting Host execution).
- Base installers ship only the player, small preview, and `companion-catalog.json` (no full
  atlases; mobile excludes player/preview too). Artwork lives in
  [Varin-companion-assets](https://github.com/Youzini-afk/Varin-companion-assets), pinned by commit,
  length, and SHA-256 in `packages/web/companion-assets.lock.json` and validated by
  `scripts/companion-assets.mjs`.
- Dev/publish commands: `bun run companion:fetch` (downloads locked atlases into
  `packages/web/public/companion-assets/`, or reads local `VARIN_COMPANION_ASSETS` without
  overwriting modified files); to publish, push under `pack/varin/` in the artwork repo and run
  `bun run companion:lock <artwork checkout>`.
- Electron downloads inert JSON/PNG files via its proxy-aware stack into `userData/companions/downloads`,
  verifies integrity, and atomically renames into `userData/companions/packs` (works offline,
  survives updates, never auto-downloads on startup). Windows serve strictly from
  `varin-ui://app/companion-assets/<id>/<version>/...` without filesystem or SPA fallback.

### Native Workspace Components

- Needed only for explicit independent workspaces (not normal chats/shared tasks).
- **Windows**: `resources/workspace-component.json` pins **WinFsp 2026 Beta5 (2.2.26286)** MSI,
  SHA-256, and license (`scripts/prepare-workspace-component.mjs --assets-only` uses Node built-ins
  for CI). Setup offers it unselected if a compatible/newer version exists, skips it on silent
  updates, and leaves it installed on uninstall. `scripts/workspace-component.test.mjs` compiles the
  NSIS page without installing.
- **Linux / macOS**: deb/rpm declare `fuse3` (AppImage/standalone require host FUSE); macOS uses a
  separately installed macFUSE/libfuse3 (not redistributed).

### Windows Installer (NSIS) & Payload Measurement

- Frameless monochrome native UI (`installer/VarinSetup.cpp`, `scripts/build-installer-plugin.cjs`,
  `resources/installer*.nsh`) with EN / zh-CN / zh-TW copy, distinct setup/uninstall taskbar
  identities, and parent-directory resolution (`D:\` -> `D:\Varin`, existing `D:\Varin` unchanged).
- Direct 7-Zip extraction (`customExtractUsing7za` via repo-root `bun-patches/app-builder-lib@26.18.0.patch`
  and checksum-pinned x86 `7za.exe` staged by `scripts/prepare-installer-tool.cjs`) eliminates stock
  `$PLUGINSDIR` double-copy while keeping differential `.blockmap` updates.
- Upgrades run the new package's embedded remover using extended paths and a same-volume temp
  sibling (junctions move as links, partial move failures roll back). Uninstall preserves data by
  default; explicit cleanup removes only the initiating user's default data directory (never
  traversing links; preserved on upgrades). Tested by `scripts/nsis-archive.test.mjs`.
- Payload benchmark (no registration/install; SHA-256 verified outside timed window):

```powershell
$env:VARIN_INSTALLER_MEASURE_SAMPLES = '3'
node packages/electron/scripts/measure-installer-payload.mjs OLD.exe OLD_UNPACKED NEW.exe NEW_UNPACKED REPORT.json
```

  Optional env vars: `VARIN_INSTALLER_MEASURE_EXTRACTOR=direct|stock`,
  `VARIN_INSTALLER_MEASURE_TIMEOUT_MS`.

### Native Libraries Built from Source

- **Optional local-semantic embeddings**: `bun run --cwd packages/electron package:local-semantic`
  builds `Varin-local-semantic-<version>-<platform>-<arch>.tar.gz` from repo-root
  `scripts/local-embedding-runtime`, validated via Electron Node Worker and cached under
  `~/.cache/varin-components/local-semantic/<platform>-<arch>` (macOS Intel builds ONNX Runtime
  1.30.0 from pinned source). Installed on demand in Settings → Memory and knowledge embeddings;
  never bundled in the base app or downloaded on startup.
- **Windows ARM64 TriviumDB**: Native recipe builds TriviumDB 0.9.1
  (`46f767f8c5befeb7da091267f2b19052f3cba8d9`) and the one-time 0.8.10 WAL checkpoint helper
  (`221a628209838483e20296d29bcf35fc3e2dd156`, with ARM64 loader repair), requiring Rust + ARM64
  MSVC. Cached in `~/.cache/varin-native` and staged outside ASAR (target arch only).

### Platform Matrix, Signing, CI & Updater

| Platform | Target / Feeds | Key Notes |
| --- | --- | --- |
| Windows | NSIS x64 (`latest.yml`), ARM64 (`latest-arm64.yml`, native `windows-11-arm`, `VARIN_TARGET_ARCH=arm64`) | Optional signing via `CSC_LINK`/`CSC_KEY_PASSWORD`, `WIN_CSC_*`, or legacy `WINDOWS_CSC_*`; unsigned fallback if absent. |
| macOS | Native Apple Silicon (default) & opt-in Intel `dmg`/`zip` (merged into `latest-mac.yml`) | Public release workflow produces unsigned assets; supply Apple signing creds to restore signing/notarization. |
| Linux | Native x64 (Ubuntu 22.04, glibc ≤ 2.35) & ARM64 AppImage (`latest-linux.yml`, `latest-linux-arm64.yml`) | `VARIN_TARGET_ARCH` must match host; identity `varin`/`varin.desktop`/`StartupWMClass=varin`; needs `libfuse2`/`libfuse2t64` or `APPIMAGE_EXTRACT_AND_RUN=1`; writable AppImage required for full in-app updates. |

- **CI workflows**: `Windows Desktop Build` runs on-demand Windows builds. `Release Build` runs on an
  existing version tag (`publish_release` / `publish_draft` default false), builds desktop + required
  Android APK ([mobile signing](../mobile/README.md#android-release)), smokes unpacked builds
  against `/health`, generates `release-source.json` + `SHA256SUMS`, and blocks upload if the tag
  moved. Use **Re-run failed jobs** to resume a candidate without mixing commits.
- **Updater**: Pending download state persists only for the same version/payload. For manual
  N-to-N+1 Linux AppImage replacement QA, see [`scripts/updater-e2e-fixture.md`](scripts/updater-e2e-fixture.md).

## Common Env Vars

| Variable | Use |
| --- | --- |
| `VARIN_ELECTRON_DEV=1` | Marks desktop development mode |
| `VARIN_ELECTRON_USE_BUNDLED_UI=1` | Uses staged `resources/web-dist` instead of HMR server |
| `VARIN_SKIP_LOCAL_SERVER=1` | Skips embedded Host and uses default remote instance (imported from login shell; bundled recovery stays available) |
| `VARIN_HMR_UI_PORT` / `VARIN_HMR_API_PORT` | Preferred Vite UI (`5173`) and API (`3901`) dev ports |
| `VARIN_RUNTIME=desktop` | Set by Electron before starting the Host |
| `VARIN_TARGET_ARCH` | Explicit package arch (`x64` or `arm64`; must match Linux host) |
| `VARIN_DESKTOP_NOTIFY=true` | Enables desktop notifications in Host |
| `VARIN_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to lower local CPU overhead |
| `VARIN_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in logs |

## Adding Desktop IPC & Pitfalls

1. Add command/args/result/event types to `packages/application-client/src/desktop.ts`.
2. Update `preload.ts` only if a new renderer-facing bridge shape is needed (never import Electron in `packages/ui`).
3. Handle the command exhaustively in `main.ts` (`varin:invoke`) and gate privileged commands against remote renderers.
4. Keep non-native runtime/server logic in `packages/web` and the Rust kernel.

- **Logs & dev profile**: Uses `electron-log` (platform `Varin` log path in packaged apps; terminal
  in dev). Dev builds isolate state in a separate `Varin Dev` userData directory.
- **Watch out for**: Hidden Windows spawns (avoid console flashes), keeping `@varin/web` and
  runtime packages external in `scripts/bundle-main.mjs`, running `verify:native` after Electron/kernel/TriviumDB/sherpa/arch
  changes, and testing both HMR and `electron:dev:bundled` modes for startup/preload/asset changes.
