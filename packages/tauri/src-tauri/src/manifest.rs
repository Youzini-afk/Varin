//! Immutable build receipts, never executable paths supplied by a renderer.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::{Component, Path, PathBuf}};

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("Desktop runtime is unavailable: {0}")]
    Invalid(String),
    #[error("Desktop runtime file could not be read: {0}")]
    Io(#[from] std::io::Error),
    #[error("Desktop runtime manifest is malformed")]
    Json(#[from] serde_json::Error),
}
type Result<T> = std::result::Result<T, ManifestError>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReceipt {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default)]
    pub executable: bool,
}
#[derive(Clone, Deserialize)]
pub struct NodeRuntime { pub version: String, pub executable: String }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRuntime { pub entry: String, pub settings_entry: String, pub browser_entry: String }
#[derive(Clone, Deserialize)]
pub struct KernelRuntime { pub executable: String, pub manifest: String }
#[derive(Clone, Deserialize)]
pub struct FrontendRuntime { pub entry: String }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyElectronRuntime {
    pub schema: u32, pub version: String, pub source_sha: String,
    pub executable: String, pub directory: String, pub protocol: u32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema: u32,
    pub product: String,
    pub channel: String,
    pub platform: String,
    pub architecture: String,
    pub node: NodeRuntime,
    pub host: HostRuntime,
    pub kernel: KernelRuntime,
    pub frontend: FrontendRuntime,
    pub files: Vec<FileReceipt>,
    #[serde(default)]
    pub legacy_electron: Option<LegacyElectronRuntime>,
}
#[derive(Clone)]
pub struct RuntimePaths {
    pub root: PathBuf,
    pub manifest: RuntimeManifest,
    pub node: PathBuf,
    pub host: PathBuf,
    pub kernel: PathBuf,
    pub frontend: PathBuf,
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "windows") { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" }
}
pub fn architecture() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

pub fn contained_file(root: &Path, name: &str) -> Result<PathBuf> {
    // Require the portable manifest representation, including on Unix where a
    // Windows drive or backslash would otherwise be an ordinary filename.
    if name.is_empty() || name.contains(['\\', ':', '\0']) || name.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err(ManifestError::Invalid("unsafe resource path".into()));
    }
    let relative = Path::new(name);
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(ManifestError::Invalid("resource is not relative".into()));
    }
    let root = root.canonicalize()?;
    let mut file = root.clone();
    for part in relative.components() {
        file.push(part.as_os_str());
        if fs::symlink_metadata(&file)?.file_type().is_symlink() {
            return Err(ManifestError::Invalid("resource links are not permitted".into()));
        }
    }
    if !file.is_file() || !file.canonicalize()?.starts_with(&root) {
        return Err(ManifestError::Invalid("resource is not a contained file".into()));
    }
    Ok(file)
}

impl RuntimePaths {
    pub fn open(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;
        let manifest: RuntimeManifest = serde_json::from_slice(&fs::read(contained_file(&root, "runtime-manifest.json")?)?)?;
        if manifest.schema != 1 || manifest.product != "varin-tauri-desktop" {
            return Err(ManifestError::Invalid("unsupported manifest generation".into()));
        }
        if manifest.platform != platform() || manifest.architecture != architecture() {
            return Err(ManifestError::Invalid("runtime belongs to another platform or architecture".into()));
        }
        if !matches!(manifest.channel.as_str(), "development" | "production") {
            return Err(ManifestError::Invalid("unknown distribution channel".into()));
        }
        let mut names = HashSet::new();
        for file in &manifest.files {
            if !names.insert(if cfg!(target_os = "linux") { file.path.clone() } else { file.path.to_lowercase() }) || file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(ManifestError::Invalid("invalid or duplicate file receipt".into()));
            }
            contained_file(&root, &file.path)?;
        }
        let node = contained_file(&root, &manifest.node.executable)?;
        let host = contained_file(&root, &manifest.host.entry)?;
        let kernel = contained_file(&root, &manifest.kernel.executable)?;
        let frontend = contained_file(&root, &manifest.frontend.entry)?;
        let runtime = Self { root, manifest, node, host, kernel, frontend };
        // Startup checks the process and UI entry points. Full payload verification
        // is a build/install boundary; rehashing Chromium and every dependency on
        // every window creation would add unrelated work to the UI hot path.
        for name in [&runtime.manifest.node.executable, &runtime.manifest.host.entry,
            &runtime.manifest.host.settings_entry, &runtime.manifest.host.browser_entry,
            &runtime.manifest.kernel.executable, &runtime.manifest.kernel.manifest,
            &runtime.manifest.frontend.entry] {
            runtime.verify_file(name)?;
        }
        Ok(runtime)
    }
    pub fn verify_file(&self, name: &str) -> Result<()> {
        let receipt = self.manifest.files.iter().find(|f| f.path == name)
            .ok_or_else(|| ManifestError::Invalid("entry has no build receipt".into()))?;
        let path = contained_file(&self.root, name)?;
        let mut file = fs::File::open(&path)?;
        if file.metadata()?.len() != receipt.size { return Err(ManifestError::Invalid("resource size changed".into())); }
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop { let n = file.read(&mut buffer)?; if n == 0 { break; } hash.update(&buffer[..n]); }
        if format!("{:x}", hash.finalize()) != receipt.sha256.to_lowercase() {
            return Err(ManifestError::Invalid("resource digest changed".into()));
        }
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt;
          if receipt.executable && file.metadata()?.permissions().mode() & 0o111 == 0 {
              return Err(ManifestError::Invalid("runtime executable has no execute permission".into()));
          }
        }
        Ok(())
    }
    pub fn verify_all(&self) -> Result<()> {
        for file in &self.manifest.files { self.verify_file(&file.path)?; }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_from_other_platforms_and_traversal() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("ok"), b"ok").unwrap();
        assert!(contained_file(dir.path(), "ok").is_ok());
        for name in ["../ok", "/ok", "a/../ok", "C:/ok", "a\\ok", "./ok", "a//ok", ""] {
            assert!(contained_file(dir.path(), name).is_err(), "{name}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_links_even_when_they_point_inside_the_payload() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("ok"), b"ok").unwrap();
        std::os::unix::fs::symlink("ok", dir.path().join("alias")).unwrap();
        assert!(contained_file(dir.path(), "alias").is_err());
    }
}
