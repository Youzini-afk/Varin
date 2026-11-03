#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    varin_desktop::run_service_guardian_if_requested();
    varin_desktop::run();
}

// The distributable Windows executable is CEF's signed bootstrap host, which
// loads varin.dll (staged from Cargo's varin_desktop.dll) and enters
// engine::bootstrap::RunWinMain. desktop.mjs builds --lib and stages this real
// host; windows-bundle.mjs installs it before Tauri bundles. This build-only
// executable must never silently start an unsandboxed browser.
#[cfg(windows)]
fn main() {
    eprintln!(
        "Start the packaged Varin CEF bootstrap executable; this build entry has no sandbox broker."
    );
    std::process::exit(1);
}
