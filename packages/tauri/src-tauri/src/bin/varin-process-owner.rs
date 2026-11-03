fn main() {
    if let Err(reason) = varin_desktop::process_owner::run() {
        // Errors never include command arguments, environment values or app output.
        eprintln!("{reason}");
        std::process::exit(125);
    }
}
