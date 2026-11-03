# Windows sandbox bootstrap

The application DLL is built as `varin_desktop.dll`. The runnable executable is
CEF's official `bootstrap.exe`, renamed to `varin.exe`. That host derives its
application DLL filename from its own stem, so staging copies our DLL to
`varin.dll`. It exports the exact `RunWinMain` C entry. The bootstrap owns the
sandbox broker throughout this call; the vendored runtime passes the same pointer
to both `CefExecuteProcess` and `CefInitialize` and requires the sandbox.

`src/main.rs`'s Windows binary is a deliberately non-runnable build sentinel. It
must never be distributed as the app or launched by a development command.
`packages/tauri/scripts/desktop.mjs` invokes Tauri build with `--lib` on Windows,
then stages and, for `dev`, launches the genuine bootstrap. It uses one explicit
CEF cache for both Cargo and staging, not an installed system Chrome.

## Fixed upstream contract

- cef-rs: `cef 154.5.0+154.0.34`, `src/build_util/win/mod.rs`.
- CEF: `154.0.34+g14c5a08+chromium-154.0.8037.98` minimal distributions.
- x64 archive SHA-1: `be54bbaf3222191dec59ffd9c9ec7e8a7f44a26d`.
- arm64 archive SHA-1: `09c6b6807da289b18704bc6d66f8c24e13562b6d`.

The official `build_util::win::build_bundle(app_path, executable_name, release)`
invokes `cargo build -p executable_name --lib` and then
`bundle(app_path, target_path, executable_name)`. The bundle operation copies the
prebuilt SDK bootstrap; it does not rebuild a C++ bootstrap. Its same-name
package/DLL assumption does not fit this repository, so our Node stager performs
the explicit mapping above, retains the official compatibility manifest and
licenses, and adds bounded PE inspection and a complete SHA-256 byte inventory.
The archive SHA-1 is the pinned upstream download receipt, not a claim that a
metadata JSON alone proves downloaded archive integrity.

Children use the same `varin.exe` with CEF's `--type` switch. `RunWinMain` enters
`run_cef_helper_process` before any Host, UI or user-data initialization. The SDK
DLLs, locale packs and resource files sit beside the executable. No external
Chrome, remote-debugging socket, disabled sandbox or disabled TLS check is used.

## Build and development installer

On a native Windows x64 or arm64 runner with the matching MSVC toolchain:

1. Prepare the fixed Node/Host runtime, then run
   `node packages/tauri/scripts/desktop.mjs build --runtime <verified-runtime>`.
   The command prints the private, runnable engine generation.
2. For a development installer, run
   `node packages/tauri/scripts/windows-bundle.mjs --runtime <verified-runtime> --engine <engine-generation> --target-directory <cargo-target/debug> --bundles nsis`.
   `--target` accepts either MSVC triple when Cargo used an explicit target.
3. The bundle wrapper verifies both inventories, atomically replaces only the
   build sentinel with the validated bootstrap, and runs Tauri's separate
   `bundle` command. Its resource map includes the complete CEF generation and
   complete runtime. `bundle.cef.embed=false` disables only Tauri's redundant CEF
   copy from a second SDK source; the validated SDK files are explicit resources.

This is an executable **development acceptance** path, not a production release
bypass. Production runtime verification remains blocked until the required
platform, sandbox, migration and updater acceptance receipts exist.

## Signing order

After staging, an authorized release pipeline can call
`signWindowsBootstrap(directory, { sign, verifySignature })`. It verifies the
original generation, signs `varin.dll` first and the real `varin.exe` second,
requires the caller's actual Authenticode verifier to succeed for each, and
reseals SHA-256 values of the final bytes. Unrelated SDK files must be unchanged.
A failed signer/verifier leaves the generation invalid for bundling. The callback
is not a substitute for acquiring the publisher certificate or verifying its
identity. Upstream SDK signatures are retained.

Install the finalized bootstrap only after Cargo has finished. Bundle with
`--no-binary-patching` so Tauri does not invalidate that signature; sign the final
installer last. The development installer intentionally passes `--no-sign`.
Signing, notarization equivalents, Windows installer execution, native input,
DPI and sandbox runtime verification still require the corresponding real
platform runner. Synthetic PE fixtures test staging and integrity logic only.

## Attribution

The compatibility manifest is copied from cef-rs
`cef/src/build_util/win/cef-app.exe.manifest`, distributed under MIT OR Apache-2.0;
`CEF-RS-LICENSE-MIT` preserves its MIT notice. Its compatibility section is from
CEF's `tests/cefsimple/win/compatibility.manifest`. The bundled CEF SDK's own
`LICENSE.txt` and `CREDITS.html` are mandatory staging inputs and are shipped.

Official references:
https://github.com/tauri-apps/cef-rs/blob/dev/cef/src/build_util/win/mod.rs
https://github.com/tauri-apps/cef-rs/blob/dev/examples/cefsimple/src/win.rs
https://github.com/tauri-apps/tauri/tree/tauri-v3.0.0-alpha.5/crates/tauri-cli
