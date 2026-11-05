#![cfg_attr(windows, windows_subsystem = "console")]
fn main() {
    #[cfg(windows)]
    if let Err(error) = varin_computer_windows::windows::run() {
        eprintln!("Varin Computer: {error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Varin Computer requires an interactive Windows desktop");
        std::process::exit(1);
    }
}
