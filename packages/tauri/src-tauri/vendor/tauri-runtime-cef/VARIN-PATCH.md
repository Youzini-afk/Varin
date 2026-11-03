# Varin CEF runtime integration

Source: tauri-runtime-cef 3.0.0-alpha.6, upstream commit
1991873f5e2baa68773f21465f61baa93077498f (tauri-v3.0.0-alpha.5).
Registry archive SHA-256:
1fc02ef8f4295b0036b1d6cbe99111e263b587c870f0d54d9bc386602f10b947.
Upstream originally pins cef and cef-dll-sys to 154.5.0. The local manifests
pin both to 156.3.0, resolved as 156.3.0+156.0.15 in Cargo.lock, so the CEF
Chromium 156.0.8078.80 does not downgrade profiles from the transition exporter's
Electron 45.2.1 / Chromium 156.0.8078.75. This version relation alone does not
prove profile or encrypted-storage migration. Upstream MIT terms are preserved
in LICENSE-MIT.

The two updated registry crates come from cef-rs commit
224a785c7b41758b51821cbb7395ea57ba493a63. Their archive SHA-256 values are:

- cef: 630eba7cb50b3cc5ee13ece8c922f36f72ace8a1db8e81b6f694b98c5cf373b1.
- cef-dll-sys: 02d194589b022eed4f975dc40fc8a6318ea7b42e2ff8b393f880f496790cafc4.

The six platform minimal SDKs are pinned in `../../../scripts/cef-runtime.lock.json`.
Their CEF source is cf671c072925b27823a61181152f4f288e8e4306. The license at that
fixed source is byte-identical to the preserved `CEF-LICENSE.txt`; its SHA-256 is
unchanged. Chromium credits still come from each matching SDK.

All six generated bindings select CEF API 15600, matching that CEF source's
`cef_api_versions.json`. Runtime and helper API declarations continue to use
`CEF_API_VERSION_LAST`; no older or experimental ABI is forced. The used public
binding types/signatures retain their shape except for the two added Settings
keychain fields, covered by the existing `..Default::default()` initialization.
The sys build script, Windows bundle helper/manifest and macOS library loader
are unchanged from the earlier binding release. This source review is not a
replacement for six-platform native builds, sandbox startup and migration smoke.

The local change registers only the process-local sandbox pointer supplied by
CEF bootstrap.exe to the Rust DLL's RunWinMain. The original pointer reaches
all CefExecuteProcess and CefInitialize calls. Missing broker information still
fails SandboxPolicy::Required. No no-sandbox fallback is introduced. The setter
is unsafe because bootstrap owns the pointer and its lifetime; it is not an IPC
command and is never exposed to a renderer.

Reference implementation:
https://github.com/tauri-apps/cef-rs/blob/224a785c7b41758b51821cbb7395ea57ba493a63/examples/cefsimple/src/win.rs
https://github.com/tauri-apps/cef-rs/blob/224a785c7b41758b51821cbb7395ea57ba493a63/cef/src/build_util/win/mod.rs

Browser Use may provide a per-webview native download handler factory so its original owner can retain a CEF before-download callback while the private staging destination is allocated. It does not open a renderer API or grant a page any filesystem authority. Popups retain the default conservative handler.

## Native-only and lifecycle boundaries

`CefWebviewAttributes::native_only` clears the pending IPC handler,
initialization scripts and frontend drag/drop bridge before browser creation.
A per-browser CEF extra-info bit permits the renderer-side `window.ipc` binding
only for trusted application views; unmarked popups are denied. IPC accepts
only the main frame and uses its actual CEF URL rather than a renderer-supplied
URL string. Browser Use and decorative Computer Use/pet surfaces use this mode.

A per-view native close callback acknowledges the real CEF `on_before_close`,
not a request to close. Optional native dialog and download handler factories
retain CEF callbacks for the existing private Host owner. These factories are
Rust-only, not renderer commands.

The `varin-companion` resource scheme requires an originating browser because
the registered webview label selects that surface's asset capability. Browserless
workers and CefURLRequest may not borrow an arbitrary live label. The upstream
browserless fallback remains available for ordinary static application schemes.

Custom OSR native drag owners receive CEF DragTarget/DragSource input and keep
original drag data through actual Drop/Cancel. The runtime's file-only Tauri
notification handler must not overwrite that owner's selected native action.

`SandboxPolicy::Required` also clears executable-supplied Chromium switches in
development builds. CEF's original deep-link restoration remains active; native
acceptance cannot opt out with `--no-sandbox` or expose a remote debugging port.

Linux helper discovery follows the pinned Chromium selection order: an existing
adjacent `chrome-sandbox` shadows `CHROME_DEVEL_SANDBOX` even when its ownership,
mode or AppImage `nosuid` mount makes it unusable. The environment fallback is
eligible only without that adjacent file and when the executable belongs to the
current real user. Discovery changes no permissions and does not make a missing
sandbox acceptable under `SandboxPolicy::Required`.

Pinned selection source:
https://github.com/chromium/chromium/blob/156.0.8078.80/sandbox/linux/suid/client/setuid_sandbox_host.cc
