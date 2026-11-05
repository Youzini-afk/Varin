use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=VARIN_COMPUTER_VERSION");
    println!("cargo:rerun-if-env-changed=VARIN_COMPUTER_BUILD_ID");
    let version = env::var("VARIN_COMPUTER_VERSION")
        .unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap());
    let build = env::var("VARIN_COMPUTER_BUILD_ID").unwrap_or_else(|_| "development".into());
    println!("cargo:rustc-env=VARIN_COMPUTER_VERSION={version}");
    println!("cargo:rustc-env=VARIN_COMPUTER_BUILD_ID={build}");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    // Cross-platform cargo check validates Windows bindings without pretending
    // that a Windows resource compiler or a signed executable was produced.
    if !env::var("HOST").unwrap().contains("windows") {
        return;
    }
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let resource_dir = root.join("../../../packages/computer-driver/windows");
    let manifest = resource_dir.join("VarinComputer.manifest");
    let icon = root.join("../../../packages/electron/resources/icons/icon.ico");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rerun-if-changed={}", icon.display());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let rc = out.join("VarinComputer.rc");
    let res = out.join("VarinComputer.res");
    let parts: Vec<u16> = version
        .split('.')
        .take(4)
        .map(|part| part.parse().expect("numeric product version"))
        .collect();
    let mut numbers = [0u16; 4];
    for (index, part) in parts.into_iter().enumerate() {
        numbers[index] = part;
    }
    let file_version = numbers.map(|part| part.to_string()).join(",");
    let quote = |path: PathBuf| path.to_string_lossy().replace('\\', "\\\\");
    fs::write(
        &rc,
        format!(
            r#"#pragma code_page(65001)
#include <windows.h>
1 RT_MANIFEST "{}"
1 ICON "{}"
1 VERSIONINFO
FILEVERSION {file_version}
PRODUCTVERSION {file_version}
FILEOS VOS_NT_WINDOWS32
FILETYPE VFT_APP
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904B0"
  BEGIN
   VALUE "CompanyName", "Varin\0"
   VALUE "FileDescription", "Varin Computer desktop helper\0"
   VALUE "FileVersion", "{version}\0"
   VALUE "InternalName", "VarinComputer\0"
   VALUE "OriginalFilename", "VarinComputer.exe\0"
   VALUE "ProductName", "Varin\0"
   VALUE "ProductVersion", "{version}\0"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
"#,
            quote(manifest),
            quote(icon)
        ),
    )
    .expect("write Computer version resources");
    let status = Command::new("rc.exe")
        .arg("/nologo")
        .arg("/c65001")
        .arg(format!("/fo{}", res.display()))
        .arg(&rc)
        .status()
        .expect("Windows SDK rc.exe is required to build VarinComputer");
    assert!(status.success(), "Windows resource compilation failed");
    println!("cargo:rustc-link-arg-bin=VarinComputer={}", res.display());
    // Static CRT: the installed helper must not depend on a separately installed VC runtime.
    // RUSTFLAGS is supplied by the platform build entry, and verified against PE imports there.
}
