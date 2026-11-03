fn main() {
    println!("cargo:rerun-if-env-changed=VARIN_TAURI_UPDATER_PUBLIC_KEY");
    #[cfg(feature = "desktop")]
    {
        extract_presentation(
            "../../ui/src/lib/computerFeedback.ts",
            "COMPUTER_FEEDBACK_HTML",
            "computer-feedback.html",
        );
        extract_presentation(
            "../../ui/src/lib/computerControls.ts",
            "COMPUTER_CONTROLS_HTML",
            "computer-controls.html",
        );
        tauri_build::build();
    }
}

// These presentation templates have one source shared with Electron and the
// browser viewer. Fail rather than accidentally interpreting TypeScript here.
#[cfg(feature = "desktop")]
fn extract_presentation(source: &str, symbol: &str, output: &str) {
    println!("cargo:rerun-if-changed={source}");
    let content = std::fs::read_to_string(source).expect("Shared presentation source is required");
    let marker = format!("export const {symbol} = String.raw`");
    let (_, rest) = content
        .split_once(&marker)
        .expect("Presentation must be one inert String.raw literal");
    let (html, suffix) = rest
        .split_once('`')
        .expect("Presentation literal must close");
    assert_eq!(
        suffix.trim(),
        ";",
        "Presentation must not contain executable TypeScript after its literal"
    );
    assert!(
        !html.contains("${"),
        "Presentation interpolation is forbidden"
    );
    let target = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join(output);
    std::fs::write(target, html).expect("Shared presentation could not be embedded");
}
