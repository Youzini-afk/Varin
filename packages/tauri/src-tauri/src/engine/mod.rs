//! Bundled Chromium and transparent native surfaces. Arbitrary browser pages
//! remain windowed CEF children; OSR is only used where alpha is required.
mod bootstrap;
mod drag;
mod drag_data;
mod gpu;
mod input_forward;
pub mod macos_chrome;
pub mod network;
mod network_ring;
pub mod offscreen;
mod pixels;

use tauri_runtime_cef::{Cef, RemoteDebugging, SandboxPolicy, SecretStorage};

pub fn configure(builder: tauri::Builder) -> tauri::Builder {
    let root_cache = crate::settings::data_directory()
        .expect("Varin data directory is required before Chromium can start")
        .join("cef");
    let cef = Cef::default()
        .root_cache_path(&root_cache)
        .sandbox(SandboxPolicy::Required)
        .secret_storage(SecretStorage::System)
        .remote_debugging(RemoteDebugging::Disabled)
        .with_settings(move |settings| {
            settings.root_cache_path = root_cache.to_string_lossy().as_ref().into();
            settings.windowless_rendering_enabled = 1;
            settings.persist_session_cookies = 1;
        })
        .on_window_event(offscreen::on_window_event);
    // Chromium's GTK loader reuses an already-loaded toolkit. Keep the explicit
    // selection aligned with tauri-winit's GTK4 for chooser/theme paths too.
    #[cfg(target_os = "linux")]
    let cef = cef.command_line_arg("gtk-version", Some("4"));
    builder.runtime(cef)
}
