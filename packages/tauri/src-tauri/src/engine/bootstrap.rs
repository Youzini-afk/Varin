//! CEF's official Windows bootstrap owns the sandbox broker for this entire call.
//! Based on tauri-apps/cef-rs cefsimple/src/win.rs (MIT OR Apache-2.0).

/// Entry point loaded by CEF bootstrap.exe from the adjacent application DLL.
/// The four parameters and C ABI are part of CEF's bootstrap contract.
#[cfg(windows)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn RunWinMain(
    _instance: tauri_runtime_cef::cef::sys::HINSTANCE,
    _command_line: *const u8,
    _command_show: i32,
    sandbox_info: *mut u8,
) -> i32 {
    crate::host_windows_guardian::run_if_requested();
    // SAFETY: this entry point is called synchronously by CEF's bootstrap host,
    // which supplies and retains the sandbox broker until this function returns.
    if unsafe { tauri_runtime_cef::set_windows_sandbox_info(sandbox_info) }.is_err() {
        return 1;
    }
    if std::env::args_os().any(|arg| arg.to_str().is_some_and(|arg| arg.starts_with("--type="))) {
        tauri_runtime_cef::run_cef_helper_process();
    } else {
        crate::run();
    }
    0
}
