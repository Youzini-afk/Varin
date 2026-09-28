# Varin Desktop

Electron desktop runtime for Varin on macOS, Windows, and Linux.

The desktop uses Electron 44 and requires macOS 13 or newer on Mac. Release artifacts target
x64 and ARM64. Electron and `electron-context-menu` are upgraded together because the menu
package uses Electron's clipboard API.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and Varin server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How it runs

Desktop starts the Varin web server in the same Electron main process. There is no separate sidecar subprocess for the Varin server.

The `main.ts` source imports `@varin/web/server/index.js` and calls `startWebUiServer()`; builds execute the generated `dist-bundle/main.mjs`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

Normal startup resolves the bundled Pi runtime, or the installation explicitly selected by the user.
It does not scan PATH or package managers. The production catalog worker's handshake establishes readiness;
there is no temporary probe worker before it. Startup remains on the loading screen while that handshake
is pending. Settings → Runtime → Rediscover explicitly inventories other installations and prepares external
install/upgrade actions; a missing selected runtime is reported rather than silently replaced.

That embedded Application Host starts the private Rust system kernel from `resources/kernel`; storage,
file/materialization, PTY/process, and fixed-view compute remain Host services and do not become a second
Electron backend or renderer IPC surface.

The workspace/user knowledge database is held by a private Application Host storage process using
Electron in Node mode. Its synchronous native queries and checkpoints do not execute on the window
thread. This does not move the Web server or introduce an Electron-specific backend; see
[knowledge storage](../web/application-host/lib/knowledge/DOCUMENTATION.md) for persistence and failure semantics.

Same-origin session-chat iframes complete an authenticated parent-frame handshake before creating their SDK client. The parent supplies its active in-memory endpoint and credentials; when relay is active it also supplies the public relay descriptor without any pairing grant, because Electron preload and IPC are unavailable inside the iframe. The iframe establishes its own transport and rebinds its SDK before rendering. Additional windows retain their own per-window runtime bootstrap instead of being overwritten by the main window. Credentials are never placed in iframe URLs, and other child pages do not receive this runtime state.

The `preload.ts` bridge exposes desktop-only APIs to the web UI through `window.__VARIN_DESKTOP__`. Privileged commands are checked in `main.ts`, not only in the UI.

## Main files

| File | Purpose |
|------|---------|
| `main.ts` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `startup-url-selection.ts` | Pure bundled/HMR startup probe policy used by main-process URL resolution |
| `preload.ts` | Safe bridge from the rendered UI to Electron IPC |
| `ssh-manager.ts` | SSH host import, connection lifecycle, tunnel/port forwarding helpers |
| `renderer-security-policy.ts` | Trusted-origin policy and remote-safe command gate for the preload bridge |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/build-web-assets.mjs` | Builds `packages/web` and stages UI assets into `resources/web-dist` |
| `pi-runtime.ts` | Resolves and starts the packaged Pi host through Electron's Node mode |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/main.mjs` for packaging |
| `scripts/verify-native.mjs` | Runs the staged release-kernel and TriviumDB smoke under Electron's Node runtime |
| `scripts/package.mjs` | Runs `electron-builder`; release automation can explicitly select unsigned Windows or macOS packaging |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

The TypeScript sources are bundled into `dist-bundle/main.mjs` and `dist-bundle/preload.mjs` by `scripts/bundle-main.mjs`. The `files` config in `package.json` ships only those two bundled entries — no `.ts` source, test, or loader reaches the packaged app.

## Desktop IPC contract

All 58 `desktop_*` commands, the preload bootstrap payload, desktop events, and shared DTOs (hosts, SSH, updates, capture, dialog) are typed in a single framework-neutral contract at `packages/application-client/src/desktop.ts`, exposed to the native bundle through the focused `@varin/application-client/desktop` subpath.

The contract exports:

- `VarinDesktopCommandMap` — a map from command name to `{ args, result }` for all 58 commands
- `VarinDesktopBridge` — the typed bridge interface implemented by preload and consumed by the UI
- `VARIN_DESKTOP_COMMAND_LIST` — the canonical command catalog (used by architecture tests)
- `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS` — the subset allowed for non-local renderers
- `PreloadBootstrapPayload` — a discriminated union that carries credentials only for local pages

The preload bridge (`preload.ts`) implements `VarinDesktopBridge` and accepts only the exhaustive event catalog shared with the typed main-process emit helpers. The main process validates raw command names with the shared runtime catalog, exhaustively handles the resulting command union, and gates remote-unsafe commands through `REMOTE_SAFE_DESKTOP_COMMANDS`.

The `desktop-contract.test.ts` suite verifies command and event catalog completeness, remote-safe subset equality, unknown-name rejection, argument/result type fixtures, and bootstrap credential isolation.

## Development

From the repo root:

```bash
bun install
bun run electron:dev
```

`bun run electron:dev` builds the Electron sources, starts the web dev server with HMR, then launches `packages/electron/dist-bundle/main.mjs`.
It waits until both the HMR UI and API are listening before opening the window, and launches the
verified installed Electron binary directly rather than passing through `npx` or npm.

The Electron workspace package trusts Electron's install script so `bun install` downloads the platform runtime in fresh checkouts and worktrees.

`postinstall` verifies that Electron's package, downloaded runtime, version, and native architecture agree. An interrupted or script-skipped install is repaired automatically; `electron:dev` performs the same check before starting any development servers.

Useful variants:

```bash
bun run electron:dev:bundled
bun run type-check:electron
bun run lint:electron
```

`electron:dev:bundled` builds and uses packaged web assets instead of the HMR server. Use it when testing behavior closer to a packaged app.

## Packaging

From the repo root:

```bash
bun run electron:build
```

That runs, in order:

1. `build:web-assets` to build the web UI and copy it into `packages/electron/resources/web-dist`.
2. `prepare:pi-runtime` to compile the Pi host bootstrap and runtime broker.
3. `bundle:main` to create `packages/electron/dist-bundle/main.mjs`.
4. `verify:native` to prepare target native libraries, start the manifest-verified release kernel,
   and perform a durable TriviumDB read/write through Electron's Node runtime. Storage and PTY no
   longer use Electron native addons.
5. `package.mjs` to build the target Rust kernel, stage it in `resources/kernel`, and run
   `electron-builder`. Its `afterPack` hook verifies the kernel identity/hash, keeps only the target
   TriviumDB binary, rejects optional transformers/ONNX dependencies and model weights in the base app,
   rejects retired `better-sqlite3` / `node-pty` / `bun-pty` authority packages, and
   removes the duplicate dependency copy of the already staged Web UI. It also verifies that every
   distribution-owned Host runtime needed after lazy activation, including the TypeScript language
   package and its `tsserver`, exists in the physical `app.asar.unpacked` tree.

Build output goes to `packages/electron/dist`. Development sources and the duplicate Web-owned kernel
are excluded from the desktop dependency tree; desktop uses `resources/kernel`.

### Windows installer payload and performance

The assisted NSIS installer keeps electron-builder's 7z payload and differential blockmap, but does not
use the stock 7z extraction path. Stock electron-builder first expands the whole archive below
`$PLUGINSDIR`, then copies that complete tree into `$INSTDIR`; tens of thousands of small runtime files
therefore hit the filesystem twice. Varin's `customExtractUsing7za` hook runs a pinned x86 `7za.exe`
directly against `$INSTDIR`, checks its exit status, and retries a failed interactive extraction. App
shutdown, old-version uninstall, registry/shortcut handling, updater cache and archive production remain
electron-builder-owned.

`bun-patches/app-builder-lib@26.15.7.patch` adds only the extraction-hook seam to the regular NSIS
template. `prepare-installer-tool.cjs` stages the checksum-pinned Windows 7-Zip binary and its licenses;
the installer embeds that helper in its private plugin directory rather than requiring 7-Zip on the
user's machine. `scripts/nsis-archive.test.mjs` exercises real 7z creation, differential blockmaps,
long Unicode paths and corrupt-payload failure so a builder upgrade cannot silently restore the
temporary-tree path or weaken error handling.

Desktop file filters omit JS/TS source maps, generated Host declarations, duplicate Web assets and
SDK-only sources/types. They do not blanket-remove `src`, TypeScript runtime inputs or Python stubs.
`node-module-file-policy.cjs` explicitly retains the built-in tsserver standard `.d.ts` libraries,
which electron-builder otherwise excludes. `afterPack` compiles a small Array/String/Promise program
with the packaged TypeScript runtime, in addition to the Pi handshake and PDF/Canvas checks.
The kernel resource filter ships only the current executable and manifest, not stale build outputs.
Pi workers and native/runtime assets remain outside ASAR; reducing installation file count is not
permission to make external Node processes depend on Electron's virtual filesystem.

The first upgrade from a file-heavy older release still pays that old release's uninstall cost; after
that transition, both install and later uninstall operate on the reduced payload. To compare only the
payload phase using the real NSIS toolchain without registering or installing Varin:

```powershell
$env:VARIN_INSTALLER_MEASURE_SAMPLES = '3'
node packages/electron/scripts/measure-installer-payload.mjs OLD.exe OLD_UNPACKED NEW.exe NEW_UNPACKED REPORT.json
```

In the default `auto` mode the old case uses electron-builder's stock 7z temporary-tree/copy path and
the new case uses Varin's direct extractor. Set `VARIN_INSTALLER_MEASURE_EXTRACTOR=direct` or `stock`
to isolate payload shape from extractor choice, and `VARIN_INSTALLER_MEASURE_TIMEOUT_MS` to change the
per-sample ceiling. The measurement uses disposable directories on the report's volume, verifies every
completed extraction by SHA-256 outside the timed interval, and records timeouts explicitly. It excludes
registry changes, shortcuts, app shutdown and old-version uninstall, so it is not a full upgrade
benchmark. Do not disable antivirus or replace installation safety checks to improve the measurement.

### Optional local semantic component

The base installer does not include MiniLM, transformers.js, or ONNX Runtime. Lexical and structural
retrieval remain available; configured remote embedding keeps its existing path. Settings → Agent
Harness → Retrieval installs local inference only when requested, or imports a downloaded `.tar.gz`.
Installation checks the platform, file digests and a real vector before activating the component in
the current Host. It does not require npm, Bun or Python on the user's machine.

Build its separate native archive with `bun run --cwd packages/electron package:local-semantic`.
This is the only build path that downloads the pinned model and prepares Node ONNX. It emits
`Varin-local-semantic-<version>-<platform>-<arch>.tar.gz` and a checksum into `dist`; the release
workflow publishes these alongside, rather than inside, the application. The archive excludes the
unused browser ONNX distribution. Set `VARIN_SMOKE_LOCAL_SEMANTIC_PACK` to that archive when running
the desktop smoke to additionally exercise the explicit import flow.

### Native libraries built from source

Two native recipes supply binaries absent from the pinned npm packages:

- Windows ARM64 builds TriviumDB 0.8.8 from commit
  `f4bdfe35e9a3b7c0587da798886ce29380976cfe`. Upstream's loader selects the
  actual Windows architecture; the npm archive does not include an ARM64 binary.
  The native runner needs Rust and the ARM64 MSVC toolchain.
- The optional semantic component's `prepare-onnx-runtime.mjs` builds macOS Intel ONNX Runtime 1.24.3 CPU and Node-API libraries from commit
  `3a728b75062256951b6e19ce718907cf1a1d4cf0`, matching the installed JavaScript API. The
  build uses Xcode command-line tools, Python 3, CMake 3.28 or newer, and Ninja.

These recipes run for their respective base or optional component builds. They validate the installed
dependency version, build from the fixed source revision, and check the resulting architecture.
Verified payloads and hash receipts are cached under `~/.cache/varin-native`; release jobs cache
only those outputs, not source checkouts or build directories. The optional component build runs real
MiniLM inference through Electron, so successful compilation alone does not establish runtime support.

macOS builds produce `dmg` and `zip` artifacts. Windows builds produce an NSIS installer. Linux builds produce an AppImage for the native x64 or arm64 host.

Every desktop icon, Web/README mark, and mobile launcher asset is generated from the same startup-cube
projection with `bun run branding:generate`. macOS packaging additionally compiles the
generated light/dark Icon Composer sources into `Assets.car` on the native Mac runner before packaging.

For a local or CI Windows x64 NSIS build, run from the repo root:

```bash
bun run electron:build:win
```

This is equivalent to running `bun run --cwd packages/electron package:win:x64` and produces `packages/electron/dist/*.exe`, `*.blockmap`, and `latest.yml`.

The assisted NSIS directory page treats a browsed path as the parent directory and displays the resolved
installation root. Selecting `D:\` therefore becomes `D:\Varin`; selecting an existing `D:\Varin`
remains unchanged instead of becoming `D:\Varin\Varin`.

Release ARM64 packages run natively on GitHub's `windows-11-arm` runner. The workflow sets
`VARIN_TARGET_ARCH=arm64`, packages with `--win --arm64`, executes the unpacked ARM64 application,
and publishes `latest-arm64.yml` beside the architecture-specific installer and blockmap.

After packaging, verify that the unpacked application starts the default bundled Pi runtime using only
packaged dependencies, then check the renderer app-ready signal/error boundary, lazy materialization and a
real hover request through the built-in TypeScript language service, plus a real terminal create/close
cycle. Merely finding compiled Host files is not proof that their unpacked assets or the bundled runtime
can execute:

```bash
bun run electron:smoke:win
```

The smoke always uses a clean temporary user-data directory and workspace, then removes both after the
run.

## Platform notes

macOS packages must be built on the matching native Intel or Apple Silicon runner. The public release
workflow currently produces unsigned `dmg` and `zip` assets by explicitly disabling identity discovery,
hardened runtime, DMG signing, and notarization. A future signed distribution can supply Apple signing
credentials and restore those production signing options without changing the application payload.

Windows packaging uses `electron-builder` with the NSIS target. For reliable native module rebuilds and NSIS installer creation, run Windows builds on a Windows runner or host. The default x64 path uses `node-pty`'s published N-API prebuild and therefore does not require Visual Studio's optional Spectre libraries; set `VARIN_REBUILD_NODE_PTY_FROM_SOURCE=1` only when intentionally testing its C++ source build. If no Windows signing environment is present, `package.mjs` intentionally disables code signing and produces an unsigned installer.

### Code signing

Windows code signing is optional. If signing credentials are present, `package.mjs` uses the standard `electron-builder` signing environment variables:

- `CSC_LINK` / `CSC_KEY_PASSWORD`
- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`

For compatibility with earlier Varin automation, `package.mjs` also maps `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` to the standard `WIN_CSC_*` names when the standard variables are not set.

When these variables are absent, the build falls back to an unsigned NSIS installer.

### Smoke builds

Run the `Windows Desktop Build` workflow on demand for a focused Windows x64, ARM64, or dual-architecture
build. For a release, run `Desktop Release Build` against an existing version tag. By default it builds and
smokes Windows x64/ARM64, Linux x64/ARM64, and macOS Apple Silicon on matching native GitHub runners,
assembles the architecture-specific updater channels, and can upload only the verified assets to an
existing draft GitHub Release. The slow macOS Intel target is a manual opt-in on that workflow, so routine
releases do not wait for the Intel runner. Publishing the draft remains a separate deliberate action.

The Linux and macOS smoke path starts the unpacked packaged application, waits for the renderer's
`__varinAppReady` signal, rejects the React error boundary, checks `/health`, and creates and closes a
real terminal. Linux additionally verifies the AppImage, Electron executable, desktop identity, and
packaged native module architecture. macOS checks the application executable and packaged `.node`
modules before launch.

Windows updates use `latest.yml` for x64 and the `latest-arm64.yml` channel for ARM64 so each installation resolves an architecture-matching installer.

Linux AppImages must be built natively. Set `VARIN_TARGET_ARCH=x64` or `VARIN_TARGET_ARCH=arm64` when packaging; the build rejects a target that does not match the Linux host. The same target selects the native Electron rebuild and Electron Builder architecture. Linux identity is stable across architectures: executable `varin`, desktop file `varin.desktop`, icon `varin`, and `StartupWMClass=varin`.

After packaging, run `bun run --cwd packages/electron verify:linux-appimage`. The verifier extracts the final AppImage and checks its ELF architecture, desktop identity, Electron executable, and all packaged native `.node` modules.

Running a packaged Linux AppImage requires FUSE (`libfuse.so.2`, typically `libfuse2` / `libfuse2t64` on Debian/Ubuntu). Without FUSE, start with `APPIMAGE_EXTRACT_AND_RUN=1`. Keep the AppImage on a writable path so in-app updates can replace it.

Linux updates are supported only when the packaged app is running from a writable AppImage. Update checks, downloads, and installation report an actionable error when `APPIMAGE` is missing, invalid, or read-only; a missing release feed (`latest-linux.yml` 404 before the first Linux publish) is treated as “no update available”. macOS and Windows updater behavior is unchanged. Release builds keep `latest-linux.yml` (x64) and `latest-linux-arm64.yml` separate and validate each manifest against its AppImage before upload. Linux AppImages download full updates (no `.blockmap` differential channel yet).

macOS release jobs retain each native builder manifest until the final assembly job. That job verifies
every referenced `zip`/`dmg` checksum and writes the Apple Silicon entry to `latest-mac.yml`. When the
manual Intel option is selected, it merges both architectures into that same manifest without overwriting
either entry.

### Updater end-to-end fixture

A loopback-only updater fixture is available for contributor QA of N-to-N+1 AppImage replacement and restart behavior. It is test infrastructure, not a user-configurable update source. See [`scripts/updater-e2e-fixture.md`](scripts/updater-e2e-fixture.md) for the controlled test procedure. Unit tests cover feed selection, check failures, no-update results, and fixture generation; actual AppImage replacement and restart remains a manual native N-to-N+1 release boundary because it requires executing two packaged versions on each supported architecture.

The package supports macOS, Windows, and Linux desktop features. Linux AppImage builds include in-app window controls, auto-update, system tray (right-click Show / Hide / Close), and launch-at-login (XDG autostart). Opening files in installed apps, installed-app discovery, and FreeDesktop icon lookup (including the default file manager) work on macOS, Windows, and Linux.

The macOS menu bar item is enabled by default and can be disabled in General settings. The setting applies after restart; while disabled, Desktop does not create the native tray controller or start the renderer subscriptions, polling, quota refresh, or IPC updates that feed it.

## Pi runtime

Packaged Desktop builds include Varin's compiled Host bootstrap and runtime broker, but runtime
execution no longer binds to a permanently bundled copy of the three Pi SDK packages. The Runtime
Manager discovers a user-level Pi installation, verifies its package root and Node executable, and
accepts it only after the Host handshake succeeds. Onboarding and Settings may select, install, or
upgrade that installation; a newer Pi is retained, and no downgrade or silent upgrade is performed.

Electron's executable provides Node mode for the Varin Host process, so running the desktop shell
does not require a separately installed Node runtime. Pi remains an independent user-level tool and
can still be used by the Pi CLI outside Varin. Cloud distributions deliberately keep a pinned Pi
runtime because their unattended hosts have different reproducibility needs.

The official ordinary installer still has to prove that its final dependency inventory contains no
unused Pi SDK copy; the optional offline distribution may instead carry an explicitly verified
standalone installation payload. The production dependencies that normal Node workers do require
remain unpacked for filesystem module resolution. Chromium locale files are limited to Varin's
supported interface languages.

## Common env vars

| Variable | Use |
|----------|-----|
| `VARIN_ELECTRON_DEV=1` | Marks the runtime as desktop development mode |
| `VARIN_ELECTRON_USE_BUNDLED_UI=1` | Uses staged web assets instead of the HMR dev server |
| `VARIN_SKIP_LOCAL_SERVER=1` | Skips the in-process local Varin server and uses the configured default remote instance; Desktop imports this from the user's login-shell environment, and packaged/bundled UI remains available for connection recovery |
| `VARIN_HMR_UI_PORT` | Preferred Vite UI port for desktop dev, default `5173` |
| `VARIN_HMR_API_PORT` | Preferred API port for desktop dev, default `3901` |
| `VARIN_RUNTIME=desktop` | Set by Electron before starting the web server |
| `VARIN_TARGET_ARCH` | Explicit desktop package architecture (`x64` or `arm64`); Linux requires it to match the native host |
| `VARIN_REBUILD_NODE_PTY_FROM_SOURCE=1` | Opts Windows packaging into the `node-pty` C++ source build instead of its verified published prebuild |
| `VARIN_DESKTOP_NOTIFY=true` | Enables desktop notification flow in the web server |
| `VARIN_SKIP_API_COMPRESSION=true` | Defaulted by Desktop to reduce local CPU overhead |
| `VARIN_STARTUP_PERF=1` | Enables privacy-safe startup phase timings in Desktop/server logs; disabled by default |

## Native features owned here

- Floating Mini Chat windows.
- Multiple native windows.
- Native notifications.
- One-click open/reveal/open-in-app actions.
- Desktop host switcher and deep-link imports.
- Local and remote instance handling.
- SSH host import, connections, logs, and port forwarding.
- SSH uses OpenSSH ControlMaster on macOS/Linux. Windows uses independent hidden OpenSSH processes for setup commands and each long-lived forward because Win32 OpenSSH does not support ControlMaster reliably.
- Tunnel lifecycle integration through the web server runtime.
- Auto-update checks, downloads, and restart/apply flow.

## IPC pattern

Renderer code should call the desktop bridge exposed by `preload.ts`. Do not import Electron from shared UI code.

Add new native capabilities in this order:

1. Add the command, arguments, result, and any event payload to the shared contract in `packages/application-client/src/desktop.ts`.
2. Add or update the `preload.ts` bridge only if a new renderer-facing shape is needed.
3. Add the real command handling in `main.ts` under `varin:invoke`; its exhaustive command check must continue to compile.
4. Gate privileged commands in main process logic so remote pages cannot access local filesystem or shell capabilities.
5. Keep server/runtime APIs in `packages/web` when the behavior is not inherently native.

## Logs and data

Electron uses `electron-log`. In development, console logs are also visible in the terminal. In packaged apps, logs are written through the platform log path for the `Varin` app name.

Development builds use a separate user data directory named `Varin Dev`, so dev state does not overwrite normal packaged app state.

## Things to be careful with

- Keep desktop-specific code in this package. Pi runtime behavior belongs in the host/broker packages.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@varin/web` and its runtime packages external in `bundle-main.mjs`; the packaged Host, Pi workers, kernel manifest and assets must resolve from the release layout.
- Run `verify:native` after changing Electron, Rust-kernel packaging, TriviumDB, sherpa, or target architecture; do not restore addon rebuilds for storage or PTY.
- Test both HMR dev mode and bundled UI mode when changing startup, preload, routing, or packaged asset behavior.

## Quick checks

```bash
bun run type-check:electron
bun run lint:electron
bun run --cwd packages/electron verify:native
bun run electron:dev:bundled
```

For full repo validation before shipping:

```bash
bun run type-check
bun run lint
```
