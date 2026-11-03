# Desktop runtime preparation

These scripts prepare the existing Application Host for the Tauri shell. They do not
create another server, kernel, Knowledge owner or extension runtime. The normal Electron
release remains independent until the native desktop's browser, platform and update gates
are complete.

## Build inputs and commands

Use the repository's Node 24, pinned Bun and Rust toolchain. Install the lockfile dependencies
first. Host native modules are prepared on a matching **native** target runner: Darwin, Linux
or Windows, each with x64 or arm64. Passing a foreign target to staging fails; copying a
foreign Node executable does not make the installed Node-API modules cross-platform.

Node **24.22.1** is pinned independently of the build machine's executable. Its six official
archive hashes are in [node-runtime.lock.json](node-runtime.lock.json), transcribed from
[Node's official checksum list](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt). Linux uses
the glibc distribution. Changing this version requires updating all six verified hashes and
rerunning the native checks, not just changing a download URL.

From the repository root:

```sh
# Explicit preparation on the build machine, not an installed-product action.
node packages/tauri/scripts/node-runtime.mjs fetch

# Offline Node consumption; reuse the shared Host/frontend/kernel build products.
node packages/tauri/scripts/stage-desktop.mjs

# Replace linux-x64 with the native target.
node packages/tauri/scripts/runtime-manifest.mjs artifacts/build/tauri-linux-x64/runtime
node packages/tauri/scripts/smoke-runtime.mjs artifacts/build/tauri-linux-x64/runtime

# Use the verified generation with the native development shell.
node packages/tauri/scripts/desktop.mjs dev --runtime artifacts/build/tauri-linux-x64/runtime
node packages/tauri/scripts/desktop.mjs build --runtime artifacts/build/tauri-linux-x64/runtime

node --test packages/tauri/scripts/*.test.mjs packages/electron/scripts/stage-runtime.test.mjs
```

`fetch` supports `--platform darwin|linux|win32`, `--arch x64|arm64`, and `--cache directory`.
It accepts only the fixed official URL and SHA256. Failed downloads never replace an existing
archive. Staging accepts `--node-archive file` for a prepared archive, `--output directory`, and
`--host`, `--frontend`, `--kernel` directories for already-built products. With no overrides,
it calls `prepareHost`, `prepareFrontend` and `prepareKernel` from the shared build owner.
Existing `VARIN_KERNEL_ARTIFACT` / `VARIN_KERNEL_PREBUILT` development rules still apply.
There is no system-Node fallback or runtime Node downloader.

Without `--runtime`, `desktop.mjs` stages a fresh generation. Its configuration passes an
absolute frontend path and `VARIN_DESKTOP_RUNTIME_DIR`; it does not repoint shared resources
under a running process. `dev` uses the bundled UI and disables automatic restarts. Rebuild
and restart after frontend or Host changes. `build` produces a debug executable only, with
`--no-bundle`; its printed runtime directory is still required to run that executable.
Generations remain on disk for explicit reuse, not automatically deleted while a process
may still own them. CEF's native build and sandbox requirements apply separately, including
the Windows bootstrap executable; the Rust DLL is not a standalone Windows app.

## Runtime layout and verification

```text
runtime/
  runtime-manifest.json
  node/node[.exe]
  node/LICENSE
  host/package.json
  host/node_modules/@varin/web/server/desktop-host.js
  host/node_modules/@varin/web/server/desktop-browser.js
  host/node_modules/@varin/web/server/desktop-settings.js
  host/node_modules/...                # complete production dependency closures
  kernel/manifest.json
  kernel/varin-kernel[.exe]
  frontend/index.html
  frontend/...
  tools/rg[.exe]
  tools/...                           # upstream ripgrep and PCRE2 licenses
  legal/LICENSE
  legal/THIRD_PARTY_NOTICES.md
  legal/kernel-third-party-notices.md
```

The ordinary Node dependency tree reuses the existing staging implementation, without
Electron's bootstrap, main/preload bundles, frontend-only Tauri API or Tauri CLI. Workspace
runtime declarations, extension broker entries, language assets and dependency license files
are retained. The native ripgrep target and its licenses reuse the existing tool preparer;
the Host resolves them through `VARIN_RESOURCES_PATH`. Both Knowledge binaries are pruned to
the selected target using their existing owner. Shared desktop frontend filtering and companion catalog generation are reused;
optional artwork retains its existing product delivery policy.

Manifest schema 1 records the target, product version, exact Node archive provenance,
process/UI entry points, kernel manifest path, build product digests when available, and
**every** file's SHA256, byte length and executable mode. Verification rejects absent,
changed or unlisted files, duplicate/path-traversal entries, symbolic links, mismatched binary
architecture, missing worker/PDF/parser assets or licenses, incompatible Node pins and inconsistent Host/kernel versions.
The manifest is an integrity receipt, not a substitute for installer/code signatures.

Code, native assets and receipts are verified before publication. Publication restores the
previous generation if promotion fails, and retains its backup with an explicit error if
rollback also fails. Node extraction copies only the executable and the complete upstream
license from the verified archive; npm and build headers are not part of the app runtime.

`smoke-runtime.mjs` executes the **bundled Node**, then the existing real kernel authority,
Knowledge persistence/upgrade, and extension broker checks with temporary data. This proves
more than file shape but does not prove a native window, model account, browser sandbox,
installer update, or another platform. Fixtures in `*.test.mjs` cover packaging failures
without downloading Chromium or building Rust.

## Native candidates and the old-engine handoff

The Host stage remains `channel: development` and has `browser: null` until the native
builder adds the actual pinned CEF receipt. A runtime manifest is never its own permission
to release. `release.qualification` points to external signed evidence, not an editable
eligibility flag. The original Electron release workflow remains unchanged.

Build from one committed SHA on each matching native runner. The same source exports the
shared frontend once, builds the controlled old-engine reader, and stages the Host runtime:

```sh
node packages/tauri/scripts/prepare-exporter.mjs artifacts/tauri-input/exporter
node packages/tauri/scripts/stage-desktop.mjs --output artifacts/tauri-runtime --legacy-electron artifacts/tauri-input/exporter/source
# CEF_PATH is the same explicit cache used by compilation and SDK validation.
node packages/tauri/scripts/build-candidate.mjs --runtime artifacts/tauri-runtime --output artifacts/tauri-candidate
node packages/tauri/scripts/smoke-native.mjs artifacts/tauri-candidate/candidate.json --output artifacts/tauri-native-smoke.json
```

Unsigned native CI builds are test candidates only. `--allow-dirty` permits local diagnostic
builds but their dirty-source receipts cannot qualify. `--no-installers` deliberately omits
installer evidence. Neither option is a release override. The source SHA, CEF archive pins,
actual runtime/engine inventories and every installer digest are recorded separately.

`legacy-electron/` contains a complete matching Electron engine with only the standalone
`--varin-export-private-state` entry and its dependency closure. It cannot start the old
normal desktop, Host or updater. Only `--mode electron-to-tauri` packages this reader.
A subsequent `--mode tauri` build/package must have no `legacyElectron` resources, leaving
one Chromium engine. Fresh installations start without an exporter. An existing unmigrated
old profile with no exporter blocks before new Host startup and directs the user to the
signed transition release; it is not treated as empty data. The fixed manifest path, architecture, source SHA and all
file digests are verified before its native-only one-shot protocol runs. It remains inside
the new installation, so removing/replacing the previous executable cannot strand its
Chromium storage. Actual data-root locking, secret/cookie acknowledgements and migration
recovery belong to the native migration owner. Preparing this bundle does not claim that
an installed user's migration succeeded.

Platform packaging deliberately wraps the **real Tauri payload** in the existing
installer owner rather than changing installed identity:

Every payload retains CEF's original redistribution license and Chromium credits.
`download-cef` 3.0.0 removes the archive-root `LICENSE.txt` while flattening its cache;
the original bytes from the pinned minimal archive are retained under `licenses/`
and verified against `cef-runtime.lock.json` before staging. A conflicting SDK
license is rejected rather than silently replaced. The native binary name is
explicitly `varin`, independent of Cargo's package name.

- Windows uses the official CEF sandbox bootstrap and same-stem Rust DLL. The
  bootstrap receives the original Varin icon/version resources before signing. Original
  electron-builder NSIS app ID, UI, installation scope, optional WinFsp component,
  upgrade removal and data-retention UX remain. Tauri-specific notification COM hooks
  are composed separately, without changing the still-shipping Electron installer.
- macOS preserves `dev.varin.desktop`, `Varin.app`, the DMG design and Electron-compatible
  ZIP, plus Tauri's `.app.tar.gz` of the same signed app. The official Tauri bundler creates
  the CEF framework/helper layout. Both Intel and Apple Silicon artifacts are required.
- Linux preserves the AppImage format and executable identity. Host resources resolve at
  `AppDir/usr/lib/Varin/runtime`; CEF libraries remain beside the executable. The original
  AppImage desktop integration stays, but its automatic `--no-sandbox` fallback is removed.
  X11 or an already enabled XWayland session is required; pure Wayland embedding is
  not supported by the current CEF runtime. GTK4 >= 4.14 is required by the current native dependency graph. This is not a claim of
  compatibility with every older Electron-supported distribution.

Portable AppImages cannot use a setuid helper on a `nosuid` mount. On machines restricting
unprivileged user namespaces, including common Ubuntu AppArmor configurations, a sandboxed
portable launch can fail. The tests record that failure; they never disable sandboxing,
change sysctls, or grant broad user-namespace access. A fixed-path system installation and
administrator-approved policy/helper would require separate implementation and acceptance.
See Chromium's [AppArmor guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Signing and qualification

A protected release operator supplies existing keys; no script creates keys or publishes.
The compiled `VARIN_TAURI_UPDATER_PUBLIC_KEY` must match the Tauri minisign key supplied by
`TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`, with the optional
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Artifact and metadata signatures bind the exact
version in the authenticated trusted comment. OS signatures are separate:

- Windows uses the existing `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` interface
  (or electron-builder's `WIN_CSC_*` / `CSC_*` aliases). The real DLL/bootstrap are signed
  before resealing the engine manifest, then the NSIS installer is signed and verified.
  No certificate is persisted in the runner's certificate store.
- macOS requires an existing `APPLE_SIGNING_IDENTITY`, optional `APPLE_KEYCHAIN`, and
  `VARIN_APPLE_NOTARY_PROFILE` naming an already configured notarytool profile. Nested
  code is signed, runtime hashes are resealed, and the outer app is signed, notarized,
  stapled and assessed. Development ad-hoc signatures cannot qualify a release.
- Linux has no invented OS certificate. Its acceptance records actual signed-update
  verification and the native installation/sandbox observations.

Run `build-candidate.mjs ... --signed` with those supplied inputs to produce final signed
bytes. Observe those exact bytes, not the previous unsigned CI output. Each of the six
native targets requires `<target>.acceptance.json` in a flat evidence directory:

```json
{
  "schema": 1,
  "target": "linux-x64",
  "sourceSha": "<40-character committed source SHA>",
  "version": "<release version>",
  "runtimeManifestSha256": "<exact runtime receipt SHA256>",
  "engineManifestSha256": "<exact engine receipt SHA256>",
  "artifacts": { "<actual installer name>": "<SHA256>" },
  "results": [
    {
      "domain": "startup-local-remote",
      "status": "passed",
      "procedure": "<procedure actually performed on this candidate>",
      "evidence": { "name": "<observation file>", "size": 123, "sha256": "<SHA256>" }
    }
  ]
}
```

`artifacts` must include every update and Electron-compatible installer format. Each of
these ten domains requires one passed result with an actual nonempty evidence file:
`startup-local-remote`, `browser-sandbox`, `browser-interaction`, `companion-animation`,
`platform-integration`, `legacy-data-migration`, `installer-update-uninstall`,
`update-cancellation`, `operating-system-signature`, `resource-performance`. A nonce-bound eleven-case GUI smoke
covers a useful subset but cannot be substituted for all ten domains. The performance domain additionally parses its measurement JSON using
`performance-evidence.mjs`: every design scenario must contain same-source, same-frontend,
same-data and same-configuration Electron/Tauri runs; exact candidate artifact hashes;
OS/CPU/GPU/display context; monotonic whole-owned-process-tree samples; private/PSS memory
(no duplicated shared RSS sum), CPU time, handles and documented GPU accounting; and real
frame/input measurements for interactive cases. An accepted comparison includes its
method and result. A manually written `passed` bit, empty samples or a main-process-only
number cannot qualify. Collection of these platform observations remains separate from
the schema validator. Source/binary
hashes, missing targets, altered evidence, stale versions and unsigned artifacts fail closed.

Collect six relocated native output directories, each containing `candidate.json` and
`assets/`. Repeat `--input` for every target; the tooling SHA comes from this checkout:

```sh
node packages/tauri/scripts/collect-candidate.mjs \
  --input darwin-x64=/accepted/darwin-x64 --input darwin-arm64=/accepted/darwin-arm64 \
  --input linux-x64=/accepted/linux-x64 --input linux-arm64=/accepted/linux-arm64 \
  --input win32-x64=/accepted/win32-x64 --input win32-arm64=/accepted/win32-arm64 \
  --acceptance /accepted/evidence --output /accepted/collected \
  --source-sha <commit> --version <next-version> \
  --mode electron-to-tauri --previous-electron <installed-version>
node packages/tauri/scripts/release.mjs verify --directory /accepted/collected --candidate /accepted/collected/tauri-candidate.json
node packages/tauri/scripts/release.mjs assemble --directory /accepted/collected --candidate /accepted/collected/tauri-candidate.json --output /accepted/metadata
node packages/tauri/scripts/runtime-manifest.mjs <runtime-directory> --production --qualification /accepted/metadata/tauri-qualification.json
```

The explicit transition mode emits valid original `latest*.yml` feeds containing real
replacement installers for existing Electron clients, and a separate authenticated
`tauri-v1.json` used only by Tauri. macOS's legacy feed includes both ZIP architectures.
Artifact URLs bind the immutable version tag; feeds are never interchanged. The initial
transition also emits signed `electron-transition.json`. Later `--mode tauri` collection
requires `--previous-tauri` and `--legacy-bridge <original-electron-transition.json>`. It
verifies that bridge and republishes its unchanged legacy YAML pointing to the original
replacement. This keeps old Electron installations that skipped the transition release
updatable after newer Tauri releases become GitHub's latest release. They migrate once,
then use only the Tauri feed. The next version must exceed both prior shell versions.
The assembler only writes files. Uploading, replacing feeds, publishing or retiring Electron shipping
requires a separately approved release operation.

At runtime, update checks authenticate metadata and artifact signatures. Downloads only
cache verified bytes; the existing `Finished` event does not install. Explicit restart
re-verifies bytes, awaits the native close guards and actual local service-scope end, then
invokes installation. A cancelled drain preserves the pending update. If the installer
fails after drain, the app cannot pretend that stopped services are still available or
that its files are unchanged; it shows native recovery and requires exit/reopen rather
than automatically retrying. A damaged local cache is never installed.

## Native CI permissions and evidence

`ci.yml` detects native changes, but the new runner jobs are currently manual opt-in through
`workflow_dispatch` with `tauri_native: true`, after approval of the required runner tool
installations. `tauri_full: true` selects all six targets; false selects Linux x64, Windows
x64 and macOS arm64 for iteration. An omitted native run is explicitly skipped, not a passed
native qualification. The reusable workflow has its own `authorized_tools` gate. Existing
Electron release jobs are not replaced or disabled.

Native-only iteration can dispatch `tauri-desktop.yml` directly with the immutable
`source_sha`, `authorized_tools: true` and `full: true|false`. This runs the same candidate
builder and native observations without repeating the unrelated full source/container
pipeline. It does not replace the final source-quality checks for that exact commit.

Linux runners use the official Ubuntu 24.04 repositories, installing the declared C/C++,
GTK3/GTK4, display/audio, Xvfb, D-Bus, FUSE and Mesa dependencies. XDG file dialogs use
`xdg-desktop-portal` plus `xdg-desktop-portal-gtk`, not in-process GTK3 dialogs alongside
GTK4. Windows reuses the hosted MSVC/SDK/CMake tools; macOS selects the hosted Xcode26 SDK.
All use official Node/Bun/Rust tooling, lockfile registry dependencies, the pinned CEF SDK,
and the original Electron/installer tooling. WinFsp is downloaded and embedded, not
installed on a runner. CI has read-only repository permission, no signing secrets and no
publication step. Native GUI reports and exact unsigned candidate assets are retained even
when a case fails. No real platform acceptance or signing is inferred from unit fixtures.


## URL activation verification

Windows NSIS registers `varin://` in its selected scope and removes only a matching owned
command on uninstall. macOS merges the real `CFBundleURLTypes` into the Tauri app before
signing. Linux's generated desktop entry declares `x-scheme-handler/varin` and forwards
URLs with `AppRun %U`; the packager extracts and validates that actual entry and launcher.
These are installation contracts, not proof that a cold OS activation has been observed.

On a **disposable OS user/session**, install the exact candidate using its normal installer,
then run the native smoke with `--protocol-warm --installed-executable <actual installed
binary or AppImage> --disposable-os-user`. It first verifies that the OS's current handler
selects that executable/app, without changing registrations, then waits for the native
ready nonce and invokes the OS URL opener. The native result must observe the same nonce
through `Opened` or the single-instance owner. macOS LaunchServices and other OS launchers
can start a second process without inheriting the test subprocess's environment; changing
HOME only on the initial process is therefore insufficient isolation. The explicit
disposable-user requirement is recorded in evidence. A warm result does not qualify cold
activation. Cold activation and installer/uninstaller observations remain required in the
platform integration acceptance procedure.

macOS automatic Electron-to-Tauri replacement also depends on a valid existing code-signing
identity accepted by Squirrel.Mac. The old unsigned-mac packaging path is not proof of
that prerequisite. Such installations need an explicitly accepted installer transition;
producing a ZIP or a feed alone cannot make their auto-update signature checks pass.
