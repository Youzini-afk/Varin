# Varin Desktop

Electron desktop runtime for Varin on macOS, Windows, and Linux.

The desktop uses Electron 44 and requires macOS 13 or newer on Mac. Release artifacts target
x64 and ARM64. Electron and `electron-context-menu` are upgraded together because the menu
package uses Electron's clipboard API.

This package owns the native shell: windows, menus, deep links, native notifications, auto-updates, host switching, SSH connections, tunnel helpers, and packaged desktop builds. The web UI and Varin server logic still live in `packages/web` and shared React UI lives in `packages/ui`.

## How it runs

Desktop starts the Varin web server in the same Electron main process. There is no separate sidecar subprocess for the Varin server.

The `main.ts` source imports `@varin/web/server/index.js` and calls `startWebUiServer()`; builds execute the generated `dist-bundle/main.mjs`. The Electron window then loads the UI from the local server in development, or from packaged `resources/web-dist` assets in packaged builds.

The embedded Application Host starts the native Rust kernel from `resources/kernel`. Its Agent Catalog
owns Thread/branch identity, history, queues and accepted execution. Storage, file/materialization,
PTY/process and fixed-view compute remain Host services; they do not become a second Electron backend
or renderer IPC surface. The UI observes native readiness and the Thread Catalog before presenting
conversation navigation. Missing or incompatible packaged runtime assets fail explicitly.

The workspace/user knowledge database is held by a private Application Host storage process using
Electron in Node mode. Its synchronous native queries and checkpoints do not execute on the window
thread. This does not move the Web server or introduce an Electron-specific backend; see
[knowledge storage](../web/application-host/lib/knowledge/DOCUMENTATION.md) for persistence and failure semantics.

Same-origin embedded Thread iframes complete an authenticated parent-frame handshake before binding their Host APIs. The parent supplies its active in-memory endpoint and credentials; when relay is active it also supplies the public relay descriptor without any pairing grant, because Electron preload and IPC are unavailable inside the iframe. The iframe establishes its own authenticated transport before rendering. Additional windows retain their own per-window runtime bootstrap instead of being overwritten by the main window. Credentials are never placed in iframe URLs, and other child pages do not receive this runtime state.

The `preload.ts` bridge exposes desktop-only APIs to the web UI through `window.__VARIN_DESKTOP__`. Privileged commands are checked in `main.ts`, not only in the UI.

The early startup document uses the shared loading scene's geometry, cube markup and Canvas renderer.
It holds the first frame without a playback loop, using the resolved desktop theme and saved splash
palette, so the application loading animation starts from the same composition.

## Main files

| File | Purpose |
|------|---------|
| `main.ts` | Electron main process, app lifecycle, windows, menus, deep links, native IPC handlers, updates, local server startup |
| `startup-url-selection.ts` | Pure bundled/HMR startup probe policy used by main-process URL resolution |
| `preload.ts` | Safe bridge from the rendered UI to Electron IPC |
| Application Host `lib/connections` | Shared SSH import, connection lifecycle and forwarding; Electron delegates through its embedded Host |
| `renderer-security-policy.ts` | Trusted-origin policy and remote-safe command gate for the preload bridge |
| `scripts/electron-dev.mjs` | Desktop dev launcher with Vite HMR support |
| `scripts/build-desktop.mjs` | Prepares the desktop product graph, production dependency tree and target runtime |
| `scripts/build-web-assets.mjs` | Stages the shared browser product into `resources/web-dist` |
| `scripts/stage-runtime.mjs` | Collects a closed production dependency tree and computes physical worker/native closures |
| `scripts/bundle-main.mjs` | Bundles Electron main code into `dist-bundle/main.mjs` for packaging |
| `scripts/verify-native.mjs` | Runs the staged release-kernel and TriviumDB smoke under Electron's Node runtime |
| `scripts/package.mjs` | Runs `electron-builder`; release automation can explicitly select unsigned Windows or macOS packaging |
| `resources/installer*.nsh` | Compact Windows setup pages, original UAC integration, extraction and explicit data-cleanup hooks |
| `installer/VarinSetup.cpp` | Native monochrome controls, streamed extractor progress and cleanup without following directory links |
| `scripts/build-installer-plugin.cjs` | Builds the x86 NSIS plugin and generates default-theme colors and localized copy |
| `resources/` | Packaged web assets, icons, and macOS entitlements |

The TypeScript sources are bundled into `dist-bundle/main.mjs` and `dist-bundle/preload.mjs` by `scripts/bundle-main.mjs`. Packaging stages those entries and `bootstrap.mjs` into a standalone production app; source checkouts, tests and development loaders stay outside that tree.

Ordinary app/tray quit confirms background-work risk, then lets Electron close its windows and run
`beforeunload` while the embedded Host is still available. `quit-lifecycle.ts` drains services at
`will-quit`, after renderer clients have disconnected, and then exits. A page that blocks unloading
cancels the pending quit; tray state and the Host remain available for another attempt. Update install
retains the updater's existing quit/install sequence.

## Desktop IPC contract

All `desktop_*` commands, the preload bootstrap payload, desktop events, and shared DTOs (hosts, SSH, updates, capture, dialog) are typed in a single framework-neutral contract at `packages/application-client/src/desktop.ts`, exposed to the native bundle through the focused `@varin/application-client/desktop` subpath.

The contract exports:

- `VarinDesktopCommandMap` — a map from command name to `{ args, result }` for the exhaustive command catalog
- `VarinDesktopBridge` — the typed bridge interface implemented by preload and consumed by the UI
- `VARIN_DESKTOP_COMMAND_LIST` — the canonical runtime command catalog
- `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS` — the subset allowed for non-local renderers
- `PreloadBootstrapPayload` — a discriminated union that carries credentials only for local pages

The preload bridge (`preload.ts`) implements `VarinDesktopBridge` and accepts only the exhaustive event catalog shared with the typed main-process emit helpers. The main process validates raw command names with the shared runtime catalog, exhaustively handles the resulting command union, and gates remote-unsafe commands through `REMOTE_SAFE_DESKTOP_COMMANDS`.

`renderer-security-policy.test.ts` verifies trusted renderer origins, remote command restrictions,
and bootstrap credential isolation. Command guards are tested in `application-client`;
production main/preload/UI consumers type-check against the shared desktop contract.

## Tests

`bun run test` discovers shell, updater-policy and path-opening behavior in one Vitest configuration;
Linux autostart is included only on Linux. `bun run test:packaging-tools` discovers Node helper tests,
including update manifests, and is included in the root `test:tooling` command. Do not run both entries
for the same helper suite. `test:linux-desktop` exercises Linux application discovery separately.
Installed-product and real-browser smoke commands remain separate from these source-level checks.

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

`package.mjs` owns the complete preparation through `build-desktop.mjs`. It consumes the shared
runtime, browser, platform Host and target kernel products from `scripts/build-products.mjs`, prepares
the target native recipe once, bundles main/preload, then collects a standalone production app under
`artifacts/build/desktop-<platform>-<arch>/app`. Collection resolves the installed dependency graph into
ordinary directories, preserving conflicting versions and runtime assets without traversing workspace
junctions. Desktop has no CLI payload or second frontend/kernel copy.

Each build stage records the actual source inputs, relevant toolchain/options and output hashes under
`artifacts/build/cache`. A matching input key alone is insufficient: modified or missing outputs rebuild.
Failed stages discard their receipt. These generated products and receipts can be deleted to request a
clean build; they contain no user state. CI can import the shared browser product and Linux x64 kernel
using `VARIN_FRONTEND_ARTIFACT` and `VARIN_KERNEL_ARTIFACT`; imports check both inputs and payload hashes.
Other native kernels, Host outputs and libraries stay on their matching platform runners.

Build output remains `packages/electron/dist`. Main-process JavaScript uses ASAR; Node worker and external
program dependency closures, native binaries and their assets remain physical. The generated builder
configuration owns those unpack patterns. `afterPack` verifies the actual virtual main-process import
path and physical knowledge process, managed script runtime, TypeScript libraries and PDF/Canvas runtime.
It also verifies the kernel identity/hash and rejects optional embedding weights, retired authority
packages and duplicate Web payload. Frontend assets live only in `resources/web-dist`; the kernel lives
only in `resources/kernel`. Production `@varin/web` contains its compiled `server` and package/license
metadata, excluding `public`, source and private Host development generations at collection time.

### Optional desktop companions

Preferences → Desktop companion owns the artwork library, download/cancel/resume, appearance selection,
deletion and wake/sleep controls. Sleeping closes the native presentation windows; execution remains in
the existing Host. The selected appearance and wake preference are local desktop settings, independent
of the Bot the companion speaks for. Accent colors still follow the application theme using one artwork pack.

The base installer includes the player, a small preview and `companion-catalog.json`, not the full atlases,
alpha pages or developer review bundles. Both Web-resource staging and electron-builder exclude those
directories; after-pack rejects an accidental full-art payload. Mobile also excludes the preview and player.
`scripts/companion-assets.mjs` derives the download catalog from the source bundle and matching occlusion
index, with an immutable GitHub source revision, exact file lengths and SHA-256 hashes.

Electron downloads inert JSON/PNG assets through its system-proxy-aware network stack into
`userData/companions/downloads`. Verified complete files survive cancellation and restart, while incomplete
appearances never become selectable. Once every file passes integrity checks, directory renames publish
the candidate under `userData/companions/packs`; a restart recovers an interrupted rename and reclaims
retired data. Installed packs work offline and survive application updates. Explicit deletion clears both
the installed appearance and its download cache. Startup never downloads optional artwork automatically.

The character, stool and decorative masks pin the same installed generation in their native window URL.
The existing `varin-ui://app/companion-assets/<id>/<version>/...` protocol serves only files declared by that
installed pack, without falling through to arbitrary filesystem paths or an HTML application fallback.
New application builds can offer an artwork update while retaining the previously installed appearance.
Wake completes after the player paints its first character frame. Loading windows stay hidden; a failed
asset load closes the incomplete window and returns the error to Settings. Normal presentation has no
persistent diagnostic or task-summary bars; right-click or the hover/focus menu opens the controls and details.

### Native workspace components

Normal chats and shared tasks do not require a filesystem component. Explicit independent workspaces
check the actual execution Host before inventory or content capture. Project settings show that Host's
backend, platform, architecture and dependency diagnostic, with an explicit refresh action.

Windows setup offers an optional WinFsp component page, selected by default when no compatible component
is detected and unselected when the installed component can be reused. `workspace-component.json` pins the
unmodified official **WinFsp 2026 Beta5 (2.2.26286)** MSI, SHA-256 and license. The selected preview
contains the upstream cached-write/concurrent-rename fixes; the installer names that preview explicitly.
`prepare-workspace-component.mjs` prepares the verified build cache through the existing Windows
before-pack hook. A matching or newer installed component is reused. User-selected installation asks
Windows for permission and reports cancellation, failure or a required restart without blocking normal
Varin use. Silent updates do not install a system component, and uninstall leaves the shared component
in place. The application ships its license and retains the required attribution in About and notices.

Linux deb/rpm packages declare FUSE3; AppImage users and standalone Hosts provide the system FUSE
device/helper and mount permission. macOS currently uses a separately installed macFUSE/libfuse3;
macFUSE is not redistributed by this package. Missing dependencies affect independent workspaces only.
Actual mount results remain separate from the read-only dependency inspection.

`workspace-component.test.mjs` compiles the real NSIS page and pinned MSI without installing it.
System installation and real filesystem mounts require separate platform testing.

### Windows installer payload and performance

Windows setup uses a product-owned, frameless native window for installation, upgrades and uninstall.
The first page centers Varin's vector mark, wordmark and primary action. Installation settings reveal
the target directory, desktop shortcut and user/machine scope together; the license link lives in
that settings view. The original window system still supplies dragging, minimizing, closing and
keyboard/accessibility behavior. Controls retain their native values and actions under custom drawing.
Installation and uninstallation both advance from completed file operations to their dedicated finish
page. The progress timer stops at that boundary, including aborted operations; unused wizard navigation
stays hidden when NSIS refreshes its controls after page callbacks.
Setup, uninstall and packaged application windows explicitly publish their current taskbar name and
relaunch identity, rather than relying on Explorer's cached executable description. Setup and uninstall
use distinct identities from the application.
Existing installations retain their location, and the original UAC bridge transfers the chosen
directory and shortcut preference when elevation is needed. The finish page offers opening Varin
or simply closing setup. English, Simplified Chinese and Traditional Chinese have dedicated copy;
other installer languages use English for these custom strings.

The native NSIS plugin uses Varin's default monochrome light/dark palette, generated from the same
theme sources as the workbench, and follows Windows' app appearance. It does not load the user's
workbench accent preference. Its vector geometry is generated from the versioned product glyph.
MSVC builds a small x86 Unicode DLL for NSIS on both Windows x64 and
ARM64 builders. No browser or additional desktop runtime is started for setup.

Upgrades run the remover embedded in the new package against the registered installation, so a fix
to removal also takes effect when upgrading an older build. File moves use extended Windows paths
and a temporary sibling on the installation volume. No complete tree is copied to the system temp
drive. A failed move restores already moved files; directory junctions move as links. The temporary
tree is removed before success is reported. File failures surface their path and allow an explicit
retry after the remover exits, rather than silently repeating the whole uninstall.
The preparation/removal phase uses an indeterminate indicator; only extraction shows a measured
percentage from 7-Zip.

Uninstall keeps data by default. Explicit cleanup names the initiating user's default application
data directory; UAC elevation does not substitute the administrator's profile. Project directories,
custom data roots and external index locations remain outside that cleanup. Directory junctions and
symlinks are removed as links without traversing their targets. Cleanup failures retain an actionable
result and can be retried. Upgrade uninstalls preserve data even with a cleanup flag.

The assisted NSIS installer keeps electron-builder's 7z payload and differential blockmap, but does not
use the stock 7z extraction path. Stock electron-builder first expands the whole archive below
`$PLUGINSDIR`, then copies that complete tree into `$INSTDIR`; tens of thousands of small runtime files
therefore hit the filesystem twice. Varin's `customExtractUsing7za` hook runs a pinned x86 `7za.exe`
directly against `$INSTDIR`, checks its exit status, and retries a failed interactive extraction. App
shutdown, uninstall registration/shortcut handling, updater cache and archive production remain
electron-builder-owned; Varin supplies the long-path-safe installation-file removal hook.

`bun-patches/app-builder-lib@26.17.0.patch` adds narrow hooks for page composition, extraction and
application-data cleanup and current-package upgrade removal to the regular NSIS template. `prepare-installer-tool.cjs` stages the
checksum-pinned Windows 7-Zip binary, its licenses, localized strings and the native UI plugin;
the installer embeds that helper in its private plugin directory rather than requiring 7-Zip on the
user's machine. `scripts/nsis-archive.test.mjs` exercises real 7z creation, differential blockmaps,
long Unicode paths and corrupt-payload failure so a builder upgrade cannot silently restore the
temporary-tree path or weaken error handling. The same focused suite checks default preservation,
upgrade preservation and explicit cleanup through a real generated uninstaller.

Extraction progress comes directly from 7-Zip's output. NSIS owns the subsequent registration and
shortcut steps, then advances directly to the completion page. Progress has no wizard navigation.
An extraction failure shows its diagnostic in the same window with Retry and Exit;
the failed extractor has exited before a retry starts. Uninstall shows its current phase with an indeterminate bar rather than estimating
a percentage by scanning the filesystem first. Detailed output is available on demand.

Desktop file filters omit JS/TS source maps, generated Host declarations, duplicate Web assets and
SDK-only sources/types. They do not blanket-remove `src`, TypeScript runtime inputs or Python stubs.
`node-module-file-policy.cjs` explicitly retains the built-in tsserver standard `.d.ts` libraries,
which electron-builder otherwise excludes. `afterPack` compiles a small Array/String/Promise program
with the packaged TypeScript runtime, alongside PDF/Canvas checks.
The kernel resource filter ships only the current executable and manifest, not stale build outputs.
Node workers and native/runtime assets remain outside ASAR; reducing installation file count is not
permission to make external Node processes depend on Electron's virtual filesystem. Packaged runtime
checks and Catalog readiness do not alone establish a successful authenticated model conversation.

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

### Native libraries built from source

The optional memory/knowledge embedding component is built separately with
`bun run --cwd packages/electron package:local-semantic`. It produces
`Varin-local-semantic-<version>-<platform>-<arch>.tar.gz` and its checksum. Settings →
Memory and knowledge embeddings selects, installs or imports it. Normal app startup
does not download the component; the selected encoder loads on demand.

Its pinned Transformers/ONNX dependency graph lives in `scripts/local-embedding-runtime`.
The component builder installs that graph into an isolated temporary directory, validates
a real vector through Electron's Node Worker, and packages the model, runtime and licenses.
The Host loads only the pure JavaScript tokenizer; ONNX stays in the disposable Worker.
Replacing a component drains its original requests, releases the old encoder and reclaims
the previous component files. Failed validation keeps the current component active.
The base application has no Transformers/ONNX dependency for embeddings. On macOS Intel,
the optional builder prepares ONNX Runtime 1.30.0 from its pinned source revision when
upstream does not provide the native binary. A separate release job publishes the component
archive alongside the application; no code-index runtime is included. Its internal version derives
from the model/runtime/build inputs rather than the application version. A verified archive is cached
under `~/.cache/varin-components/local-semantic/<platform>-<arch>` and reused when only the app changes;
the transport filename retains the app version for existing component discovery. Cache misses still
run the real inference check before publication.

The native preparation recipe supplies a binary absent from the pinned npm package:

- Windows ARM64 builds TriviumDB 0.8.10 from commit
  `221a628209838483e20296d29bcf35fc3e2dd156`. The preparation step patches
  upstream's x64-only Windows loader to select the added ARM64 binary.
  The native runner needs Rust and the ARM64 MSVC toolchain.
The recipe runs during the corresponding application build. It validates the installed
dependency version, builds from the fixed source revision, and checks the resulting architecture.
Verified payloads and hash receipts are cached under `~/.cache/varin-native`; release jobs cache
only those outputs, not source checkouts or build directories.

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

After packaging, run the shared startup smoke against the unpacked Windows executable. It checks
the main workspace, renderer readiness and the embedded Host's `/health` response:

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

Windows packaging uses `electron-builder` with the NSIS target. Use a matching Windows runner or host for native dependencies and NSIS installer creation. PTYs and process control belong to the Rust kernel; packaging rejects retired `node-pty` and `bun-pty` authorities. If no Windows signing environment is present, `package.mjs` intentionally disables code signing and produces an unsigned installer.

### Code signing

Windows code signing is optional. If signing credentials are present, `package.mjs` uses the standard `electron-builder` signing environment variables:

- `CSC_LINK` / `CSC_KEY_PASSWORD`
- `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`

For compatibility with earlier Varin automation, `package.mjs` also maps `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` to the standard `WIN_CSC_*` names when the standard variables are not set.

When these variables are absent, the build falls back to an unsigned NSIS installer.

### Smoke builds

Run the `Windows Desktop Build` workflow on demand for a focused Windows x64, ARM64, or dual-architecture
build. For a release, run `Release Build` against an existing version tag. By default it builds and
smokes Windows x64/ARM64, Linux x64/ARM64, and macOS Apple Silicon on matching native GitHub runners,
assembles the architecture-specific updater channels, and can upload only the verified assets to an
existing draft GitHub Release. Android's signed APK and checksum are built alongside desktop targets
and required by final assembly; see [mobile signing](../mobile/README.md#android-release).
The slow macOS Intel target is a manual opt-in on that workflow, so routine releases do not wait for
the Intel runner. `publish_release` uploads assets to the draft; additionally setting `publish_draft`
publishes it after the complete verified asset set has uploaded. Both options default to false.

The workflow accepts the tag's exact source SHA and Android counter once, retaining that candidate in
an artifact. Browser assets build once; the Linux x64 kernel is shared with native acceptance, VM guest
and Linux x64 packaging. Source checks, native acceptance, platform packaging, optional inference
components and Android run along their actual dependencies in parallel. Only Linux x64 packaging waits
for the VM guest. The manual Windows workflow calls the same packaging workflow and product builder.

Use GitHub's **Re-run failed jobs** to resume a candidate: completed product artifacts remain usable,
and retrying preserves its source and Android version code. Final assembly requires every selected
product, its original source/tooling identity and exact file hashes, then generates `release-source.json`
and `SHA256SUMS`. Both upload and publication recheck the tag. If the tag has moved, the candidate's
verified artifacts remain available but are not attached to the changed release. Start a new workflow
run for the new source instead of mixing products from different commits.

All platforms share one startup smoke: launch the unpacked packaged application with clean temporary
data configured to use the local Host, wait for its main workspace and renderer readiness, then check
the embedded Host and native kernel through `/health`. The Windows entry only supplies its default executable path. Feature
verification for terminals, recovery, language services, semantic components and editors stays with
the respective owners. Linux separately verifies the AppImage, Electron executable, desktop identity,
and packaged native module architecture. macOS checks executable and native module architecture
before launch; signing and payload checks remain part of packaging.

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

## Packaged runtime boundary

Desktop ships the compiled Application Host, its native kernel executable/manifest and the runtime
assets needed by lazily activated services. Electron's executable supplies Node mode to Host-owned
workers, so the desktop shell does not require a separately installed Node runtime. Those workers
retain the same owners as Web deployments; Electron adds no conversation broker or alternate store.

Production dependencies required by Node workers remain unpacked for filesystem module resolution.
Chromium locale files are limited to Varin's supported interface languages. Keep the shipped LICENSE,
THIRD_PARTY_NOTICES and kernel notices with the distribution.

## Local Host startup mode

Settings → Work connections → Connect to an Agent controls whether this desktop
starts an embedded Host. The preference is `desktopLocalHostEnabled` in the
existing native `settings.json`; it does not follow the selected remote Agent.
Saving changes the next launch only. The UI distinguishes the saved preference,
effective next-launch policy, current embedded/external/stopped runtime, and a
pending restart. Its explicit restart drains the existing native lifecycle and
never applies a downloaded update.

Frontend-only mode stops providing embedded local execution and built-in SSH
forwarding. Remote Agents remain independent, but local work is not migrated or
guaranteed to continue through a restart. The bundled chooser/recovery UI can
atomically re-enable local startup and select the local Host without deleting
saved remote connections. `VARIN_SKIP_LOCAL_SERVER=1` still takes precedence;
`VARIN_SERVER_URL` also prevents recovery from silently changing an explicit
startup target.

The GUI permits disabling local startup only when the active build has bundled
recovery assets. HMR or server-rendered development keeps its local Host enabled,
including when a saved preference came from a bundled build. The explicit
environment-variable mode remains available for developers who manage their own
HMR/recovery environment.

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

- Keep desktop-specific code in this package. Runtime behavior belongs in the Application Host and Rust kernel.
- Use hidden Windows process launches for background helpers. Avoid visible console flashes.
- Keep `@varin/web` and its runtime packages external in `bundle-main.mjs`; the packaged Host, Node workers, kernel manifest and assets must resolve from the release layout.
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
