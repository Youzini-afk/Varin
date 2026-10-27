fn main() {
    // WinFsp is a user-installed, optional filesystem component. Loading the
    // kernel itself must never require its DLL to be present.
    if std::env::var_os("CARGO_FEATURE_WORKSPACE_MOUNT").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let dll = match arch.as_str() {
            "x86_64" => "winfsp-x64.dll",
            "aarch64" => "winfsp-a64.dll",
            "x86" => "winfsp-x86.dll",
            _ => panic!("WinFsp has no import library for {arch}"),
        };
        match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => {
                println!("cargo:rustc-link-lib=dylib=delayimp");
                println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
            }
            _ => panic!("The selected WinFsp binding requires a Windows MSVC target"),
        }
    }
}
