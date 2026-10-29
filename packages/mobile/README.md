# Varin Mobile

Capacitor shell for the dedicated Varin mobile web surface.

The mobile package reuses the web build, then rewrites `mobile.html` to `index.html` in `packages/mobile/dist` so native iOS/Android always launch `MobileApp` instead of the hosted surface selector.

The native product identity is Varin-owned:

- app/package ID: `dev.varin.mobile`;
- iOS App Group: `group.dev.varin.mobile`;
- widget extension: `dev.varin.mobile.widget`;
- notification service: `dev.varin.mobile.notification-service`;
- deep-link scheme: `varin://`.

## Runtime model

- The native app bundles the mobile UI only; the Application Host and native Agent runtime stay on the connected server.
- On first launch in Capacitor, the app shows a connection screen for an existing Varin server.
- Connections are saved locally in the app and can be managed from the mobile overflow menu under `Instances`.
- The connection screen and `Instances` menu item are Capacitor-only. Hosted `mobile.html` in a normal browser keeps the regular web behavior.
- Password-protected Varin servers can be unlocked from the mobile app. The app stores the issued client token with the saved connection.
- `varin://` connection and Thread/branch links open the native app on Android and iOS. Android declares a
  browsable intent filter; iOS declares the same scheme for the app and bundled widgets.
- The Terminal workspace surface runs its PTY on the active Varin server over the shared authenticated runtime transport; it never opens a local shell on the phone or tablet. Closing the surface detaches the renderer while the server session remains available for reattachment. On touch devices, dragging scrolls the buffer while long-pressing and dragging selects terminal text.

The shared native Thread Catalog owns conversation identity. Mobile uses `ThreadsAPI` for history,
input, queues and control; the shell does not create a separate conversation runtime. Host switching
fences old reads and drafts. PDF attachments use the same Thread-scoped material upload and fixed
snapshot references as desktop/Web, while file editing retains the mobile CodeMirror adapter.

## Commands

Run these from `packages/mobile`, or use the root `mobile:*` aliases.

- `bun run build`: builds the shared web client and prepares mobile web assets, without compiling the server or Rust kernel.
- `bun run build:assets`: prepares mobile assets from an existing `packages/web/dist` build; the root workspace build uses this to avoid rebuilding web.
- `bun run sync`: prepares assets and runs `cap sync`.
- `bun run add:ios`: creates the native iOS project.
- `bun run add:android`: creates the native Android project.
- `bun run build:android:debug`: builds a debug Android APK without launching an emulator.
- `bun run build:android:release`: builds and signs the release APK, verifies its signature and installed identity/version, and stages it with a SHA-256 checksum.
- `bun run build:ios:simulator`: builds an iOS Simulator app without launching Xcode or Simulator.
- `bun run sim:run`: boots a simulator if needed, installs the built iOS app, and launches it.
- `bun run sim:dev`: one-command dev loop — builds the simulator app, installs + launches it, starts the `serve-sim` stream, and prints the preview URL; Ctrl+C stops the stream. Pass `--no-build` to skip the build step.
- `bun run sim:serve`: starts `serve-sim` in detached JSON mode and prints the browser preview URL.
- `bun run sim:list`: lists running `serve-sim` streams.
- `bun run sim:kill`: stops running `serve-sim` streams.
- `bun run open:ios`: opens the iOS project.
- `bun run open:android`: opens the Android project.

## Headless quickstart

```sh
bun run build
bun run sync
bun run build:ios:simulator
bun run build:android:debug
```

These commands build and sync the native projects without launching Xcode, Android Studio, Simulator, or an emulator.

## Local tooling

The default scripts assume the local Homebrew/Xcode paths prepared for this workspace:

- Xcode: `/Applications/Xcode.app/Contents/Developer`
- JDK 21: `/opt/homebrew/opt/openjdk@21`
- Android SDK: `/opt/homebrew/share/android-commandlinetools`

Override `DEVELOPER_DIR`, `JAVA_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT` when using a different local setup.

Required local tools:

- Xcode with iOS Simulator support.
- CocoaPods for iOS dependency installation.
- JDK 21 for Android Gradle builds.
- Android SDK command-line tools with platform/build-tools 36; Gradle 8.14.3 and AGP 8.13.2 match the installed Capacitor 8 plugins.

## Android release

The `Release Build` workflow (`.github/workflows/desktop-release.yml`) builds Android alongside the
desktop targets after source quality succeeds. The assembly job requires the verified APK and checksum
before uploading the complete artifact or attaching assets to an existing draft GitHub Release:

- `Varin-<version>-android.apk` (one APK containing the supported Android architectures);
- `Varin-<version>-android.apk.sha256`.

`versionName` follows the root product version and the release tag must match it. Official Android
`versionCode` uses this workflow's increasing `github.run_number`; retrying a run preserves its code.
Continue using the same workflow counter and signing key so users can install future updates.

Configure these repository Actions secrets once:

| Secret | Value |
| --- | --- |
| `VARIN_ANDROID_KEYSTORE_BASE64` | Base64 encoding of the persistent release keystore |
| `VARIN_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `VARIN_ANDROID_KEY_ALIAS` | Signing key alias |
| `VARIN_ANDROID_KEY_PASSWORD` | Signing key password |
| `VARIN_ANDROID_GOOGLE_SERVICES_JSON` | Optional Varin Firebase JSON for `dev.varin.mobile` |

The signing file exists only in the runner's temporary directory and is removed after the job.
Keep the original key and passwords outside the source checkout. Missing signing configuration fails
the Android job with the missing secret names, before installing build dependencies.
Firebase is optional; without it the APK works with push registration unavailable.

For a local signed build, set `VARIN_ANDROID_VERSION_CODE`, `VARIN_ANDROID_KEYSTORE_PATH` (an absolute
path to the existing keystore), and the three password/alias variables above, then run
`bun run mobile:build:android:release` from the repo root. `JAVA_HOME` should select JDK 21 and
`ANDROID_HOME` or `ANDROID_SDK_ROOT` the SDK. Build Tools 36.0.0 are used for signature/metadata checks;
`VARIN_ANDROID_BUILD_TOOLS` can select another installed revision. Output is in
`packages/mobile/release-assets/`. This command syncs Android plugin paths from the actual installation
and uses the original Gradle wrapper through Java on Windows, Linux and macOS.

## Push configuration

The repository does not ship another product's Firebase or Apple credentials.

- Android builds remain usable without Firebase, but push registration is disabled. Official
  release automation can supply a Varin-owned `android/app/google-services.json` for
  `dev.varin.mobile` through the optional secret above; that file is ignored by Git.
- iOS signing must provision `dev.varin.mobile`, its widget and notification-service identifiers,
  the `group.dev.varin.mobile` App Group, and the APNs entitlement.
- A central push relay is opt-in through `VARIN_PUSH_RELAY_URL`. Source builds have no inherited
  default relay. Self-hosters can instead configure direct APNs delivery with the documented
  `VARIN_APNS_*` environment variables.

## Troubleshooting

- If `xcodebuild` reports that the active developer directory is Command Line Tools, keep using the provided scripts or set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
- If Android builds fail with `Unable to locate a Java Runtime` or `source release: 21`, install/use JDK 21 and set `JAVA_HOME` accordingly.
- If Android SDK packages are missing, install `platform-tools`, `platforms;android-36`, and `build-tools;36.0.0`, then accept SDK licenses.
- If CocoaPods cannot find Capacitor pods after reinstalling dependencies, run `bun install` from the workspace root, then rerun `bun run sync`.
- If connecting to a remote Varin server fails from the app while `/health` works in curl, check that the server build includes the packaged-client CORS allowlist for `capacitor://localhost` and local dev origins.
- If `serve-sim` preview says the stream is not producing frames, check the raw MJPEG stream before assuming the simulator stopped. In prior testing the raw stream worked while the browser preview UI stayed stale.

## Generated assets

Launcher, adaptive, and splash assets are generated from Varin's shared startup-cube mark. From the
repository root, regenerate every product surface together:

```sh
bun run branding:generate
```

The generated native assets are committed so Android/iOS builds do not depend on a release-time
image tool. Run `bun run test:identity` after changing identifiers, targets, schemes, or branding.
