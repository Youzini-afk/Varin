# Windows CEF bootstrap integration

Source: tauri-runtime-cef 3.0.0-alpha.6, upstream commit
1991873f5e2baa68773f21465f61baa93077498f (tauri-v3.0.0-alpha.5).
Registry archive SHA-256:
1fc02ef8f4295b0036b1d6cbe99111e263b587c870f0d54d9bc386602f10b947.
The crate pins cef and cef-dll-sys to 154.5.0; the resolved CEF release is
154.5.0+154.0.34. Upstream MIT terms are preserved in LICENSE-MIT.

The local change registers only the process-local sandbox pointer supplied by
CEF bootstrap.exe to the Rust DLL's RunWinMain. The original pointer reaches
all CefExecuteProcess and CefInitialize calls. Missing broker information still
fails SandboxPolicy::Required. No no-sandbox fallback is introduced. The setter
is unsafe because bootstrap owns the pointer and its lifetime; it is not an IPC
command and is never exposed to a renderer.

Reference implementation:
https://github.com/tauri-apps/cef-rs/blob/dev/examples/cefsimple/src/win.rs
https://github.com/tauri-apps/cef-rs/blob/dev/cef/src/build_util/win/mod.rs

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
