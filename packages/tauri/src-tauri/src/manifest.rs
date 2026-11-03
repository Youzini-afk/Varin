//! Immutable build receipts, never executable paths supplied by a renderer.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, io::Read, path::{Component, Path, PathBuf}};

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
pub struct FrameworkLinkReceipt { pub path: String, pub target: String }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyElectronRuntime {
    pub schema: u32, pub version: String, pub source_sha: String,
    pub executable: String, pub directory: String, pub protocol: u32,
    #[serde(default)]
    pub links: Vec<FrameworkLinkReceipt>,
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

fn relative_resource(name: &str) -> Result<&Path> {
    // Require the portable manifest representation, including on Unix where a
    // Windows drive or backslash would otherwise be an ordinary filename.
    if name.is_empty() || name.contains(['\\', ':']) || name.bytes().any(|b| b < 32) || name.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return Err(ManifestError::Invalid("unsafe resource path".into()));
    }
    let relative = Path::new(name);
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(ManifestError::Invalid("resource is not relative".into()));
    }
    Ok(relative)
}

pub fn contained_file(root: &Path, name: &str) -> Result<PathBuf> {
    let relative = relative_resource(name)?;
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

// The only link exception is Apple's versioned framework layout inside the
// controlled reader. Ordinary FileReceipt and all active entries stay no-follow.
fn framework_link_info(link: &FrameworkLinkReceipt) -> Result<(String, bool)> {
    relative_resource(&link.path)?;
    relative_resource(&link.target)?;
    const PREFIX: &str = "Varin.app/Contents/Frameworks/";
    let invalid = || ManifestError::Invalid("invalid legacy framework symbolic link".into());
    let tail = link.path.strip_prefix(PREFIX).ok_or_else(invalid)?;
    let (bundle, alias) = tail.split_once('/').ok_or_else(invalid)?;
    let name = bundle.strip_suffix(".framework").filter(|s| !s.is_empty()).ok_or_else(invalid)?;
    let version = |s: &str| s != "Current" && s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    let target: Vec<_> = link.target.split('/').collect();
    let current = alias == "Versions/Current";
    let allowed = if current { target.len() == 1 && version(target[0]) } else {
        [name, "Resources", "Libraries", "Helpers", "Headers", "Modules"].contains(&alias)
            && target.len() == 3 && target[0] == "Versions"
            && (target[1] == "Current" || version(target[1])) && target[2] == alias
    };
    if !allowed { return Err(invalid()); }
    Ok((format!("{PREFIX}{bundle}"), current || alias != name))
}

fn verify_framework_links(root: &Path, links: &[FrameworkLinkReceipt], platform: &str) -> Result<()> {
    if links.is_empty() { return Ok(()); }
    if platform != "darwin" || !fs::symlink_metadata(root)?.is_dir() {
        return Err(ManifestError::Invalid("invalid legacy framework link inventory".into()));
    }
    let mut names = HashSet::new();
    let mut expected = HashMap::new();
    for link in links {
        framework_link_info(link)?;
        if !names.insert(link.path.to_lowercase()) {
            return Err(ManifestError::Invalid("duplicate legacy framework symbolic link".into()));
        }
        expected.insert(link.path.as_str(), link);
    }
    fn resolve(root: &Path, name: &str, expected: &HashMap<&str, &FrameworkLinkReceipt>, visited: &mut HashSet<String>) -> Result<(String, fs::Metadata)> {
        let parts: Vec<_> = name.split('/').collect();
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() { prefix.push('/'); }
            prefix.push_str(part);
            let file = root.join(&prefix);
            let meta = fs::symlink_metadata(&file)?;
            if meta.file_type().is_symlink() {
                let link = expected.get(prefix.as_str()).ok_or_else(|| ManifestError::Invalid("unlisted legacy framework symbolic link".into()))?;
                if !visited.insert(prefix.clone()) || fs::read_link(file)?.as_os_str() != std::ffi::OsStr::new(&link.target) {
                    return Err(ManifestError::Invalid("legacy framework symbolic link changed or contains a cycle".into()));
                }
                let parent = prefix.rsplit_once('/').map(|(parent, _)| parent).unwrap_or("");
                let mut target = format!("{parent}/{}", link.target);
                for rest in &parts[index + 1..] { target.push('/'); target.push_str(rest); }
                return resolve(root, &target, expected, visited);
            }
            if index == parts.len() - 1 { return Ok((prefix, meta)); }
            if !meta.is_dir() { return Err(ManifestError::Invalid("legacy framework parent is not a directory".into())); }
        }
        Err(ManifestError::Invalid("empty legacy framework target".into()))
    }
    for link in links {
        let (framework, directory) = framework_link_info(link)?;
        let mut parent = root.to_path_buf();
        let parts: Vec<_> = link.path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            parent.push(part);
            if !fs::symlink_metadata(&parent)?.is_dir() {
                return Err(ManifestError::Invalid("legacy framework link parent must be an ordinary directory".into()));
            }
        }
        let file = root.join(&link.path);
        if !fs::symlink_metadata(&file)?.file_type().is_symlink() || fs::read_link(file)?.as_os_str() != std::ffi::OsStr::new(&link.target) {
            return Err(ManifestError::Invalid("legacy framework symbolic link changed".into()));
        }
        let (resolved, meta) = resolve(root, &link.path, &expected, &mut HashSet::new())?;
        if !resolved.starts_with(&format!("{framework}/Versions/")) || !(if directory { meta.is_dir() } else { meta.is_file() }) {
            return Err(ManifestError::Invalid("legacy framework symbolic link has an invalid target".into()));
        }
    }
    Ok(())
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
        if let Some(legacy) = &manifest.legacy_electron {
            verify_framework_links(&root.join("legacy-electron"), &legacy.links, &manifest.platform)?;
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
        if let Some(legacy) = &self.manifest.legacy_electron {
            verify_framework_links(&self.root.join("legacy-electron"), &legacy.links, &self.manifest.platform)?;
        }
        for file in &self.manifest.files { self.verify_file(&file.path)?; }
        self.verify_inventory("")?;
        Ok(())
    }
    pub fn verify_legacy(&self) -> Result<()> {
        let legacy = self.manifest.legacy_electron.as_ref()
            .ok_or_else(|| ManifestError::Invalid("legacy exporter is unavailable".into()))?;
        self.verify_file(&legacy.executable)?;
        verify_framework_links(&self.root.join("legacy-electron"), &legacy.links, &self.manifest.platform)?;
        for file in &self.manifest.files {
            if file.path.starts_with("legacy-electron/") { self.verify_file(&file.path)?; }
        }
        self.verify_inventory("legacy-electron")
    }
    fn verify_inventory(&self, scope: &str) -> Result<()> {
        let files: HashSet<_> = self.manifest.files.iter().map(|file| file.path.as_str()).collect();
        let links: HashSet<_> = self.manifest.legacy_electron.iter().flat_map(|legacy| &legacy.links)
            .map(|link| format!("legacy-electron/{}", link.path)).collect();
        fn visit(root: &Path, relative: &str, files: &HashSet<&str>, links: &HashSet<String>) -> Result<()> {
            let path = root.join(relative);
            let meta = fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                for entry in fs::read_dir(path)? {
                    let name = entry?.file_name().into_string().map_err(|_| ManifestError::Invalid("invalid runtime filename".into()))?;
                    let child = if relative.is_empty() { name } else { format!("{relative}/{name}") };
                    visit(root, &child, files, links)?;
                }
            } else if meta.file_type().is_symlink() {
                if !links.contains(relative) { return Err(ManifestError::Invalid("unlisted runtime symbolic link".into())); }
            } else if !meta.is_file() || (relative != "runtime-manifest.json" && !files.contains(relative)) {
                return Err(ManifestError::Invalid("unlisted runtime file or special file".into()));
            }
            Ok(())
        }
        visit(&self.root, scope, &files, &links)
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

    #[cfg(unix)]
    fn framework_fixture() -> (tempfile::TempDir, RuntimePaths) {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let framework = "Varin.app/Contents/Frameworks/Electron Framework.framework";
        let mut files = Vec::new();
        for (name, bytes) in [
            ("Varin.app/Contents/MacOS/Varin".to_string(), b"executable".as_slice()),
            (format!("{framework}/Versions/A/Electron Framework"), b"framework".as_slice()),
            (format!("{framework}/Versions/A/Resources/Info.plist"), b"resources".as_slice()),
        ] {
            let name = format!("legacy-electron/{name}");
            let file = dir.path().join(&name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, bytes).unwrap();
            files.push(serde_json::json!({ "path": name, "size": bytes.len(), "sha256": format!("{:x}", Sha256::digest(bytes)) }));
        }
        let mut links = Vec::new();
        for (alias, target) in [("Electron Framework", "Versions/Current/Electron Framework"), ("Resources", "Versions/Current/Resources"), ("Versions/Current", "A")] {
            let name = format!("{framework}/{alias}");
            symlink(target, dir.path().join("legacy-electron").join(&name)).unwrap();
            links.push(serde_json::json!({ "path": name, "target": target }));
        }
        let executable = "legacy-electron/Varin.app/Contents/MacOS/Varin";
        let manifest = serde_json::from_value(serde_json::json!({
            "schema": 1, "product": "varin-tauri-desktop", "channel": "development", "platform": "darwin", "architecture": "arm64",
            "node": { "version": "test", "executable": executable },
            "host": { "entry": executable, "settingsEntry": executable, "browserEntry": executable },
            "kernel": { "executable": executable, "manifest": executable }, "frontend": { "entry": executable }, "files": files,
            "legacyElectron": { "schema": 1, "protocol": 1, "version": "1.2.3", "sourceSha": "a".repeat(40),
                "executable": executable, "directory": "legacy-electron", "links": links },
        })).unwrap();
        let entry = dir.path().join(executable);
        let runtime = RuntimePaths { root: dir.path().to_path_buf(), manifest, node: entry.clone(), host: entry.clone(), kernel: entry.clone(), frontend: entry };
        (dir, runtime)
    }

    #[cfg(unix)]
    #[test]
    fn framework_links_are_scoped_receipts_not_regular_file_entries() {
        let (_dir, runtime) = framework_fixture();
        runtime.verify_legacy().unwrap();
        runtime.verify_all().unwrap();
        let legacy = runtime.manifest.legacy_electron.as_ref().unwrap();
        assert!(verify_framework_links(&runtime.root.join("legacy-electron"), &legacy.links, "linux").is_err());
        let alias = "legacy-electron/Varin.app/Contents/Frameworks/Electron Framework.framework/Electron Framework";
        assert!(contained_file(&runtime.root, alias).is_err());
        assert!(runtime.verify_file(alias).is_err());
        assert!(contained_file(&runtime.root, "legacy-electron/Varin.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework").is_ok());
        // The entry exception never extends to an aliased exporter executable.
        fs::remove_file(&runtime.node).unwrap();
        std::os::unix::fs::symlink("../Frameworks/Electron Framework.framework/Electron Framework", &runtime.node).unwrap();
        assert!(runtime.verify_legacy().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_verification_rejects_changed_unlisted_and_flattened_framework_links() {
        use std::os::unix::fs::symlink;
        let (_dir, runtime) = framework_fixture();
        let framework = runtime.root.join("legacy-electron/Varin.app/Contents/Frameworks/Electron Framework.framework");
        let binary_alias = framework.join("Electron Framework");
        // Path equality normalizes separators; link receipts must compare the
        // original OS text, including a trailing slash that breaks file opens.
        for target in ["Versions//Current/Electron Framework", "Versions/Current/Electron Framework/"] {
            fs::remove_file(&binary_alias).unwrap(); symlink(target, &binary_alias).unwrap();
            assert!(runtime.verify_legacy().is_err(), "{target}");
        }
        fs::remove_file(&binary_alias).unwrap(); symlink("Versions/Current/Electron Framework", &binary_alias).unwrap();
        let current = framework.join("Versions/Current");
        fs::remove_file(&current).unwrap(); symlink("B", &current).unwrap();
        assert!(runtime.verify_legacy().is_err());
        fs::remove_file(&current).unwrap(); fs::create_dir(&current).unwrap();
        assert!(runtime.verify_legacy().is_err());
        fs::remove_dir(&current).unwrap(); symlink("A", &current).unwrap();
        let extra = framework.join("extra"); symlink("Versions/A", &extra).unwrap();
        assert!(runtime.verify_legacy().is_err());
        fs::remove_file(&extra).unwrap(); fs::write(&extra, b"unlisted").unwrap();
        assert!(runtime.verify_legacy().is_err());
        fs::remove_file(extra).unwrap(); runtime.verify_legacy().unwrap();
        fs::write(framework.join("Versions/A/Resources/Info.plist"), b"corrupted").unwrap();
        assert!(runtime.verify_legacy().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn framework_links_reject_cycles_external_targets_and_unlisted_intermediates() {
        let (_dir, runtime) = framework_fixture();
        let legacy = runtime.manifest.legacy_electron.as_ref().unwrap();
        let root = runtime.root.join("legacy-electron");
        for target in ["Current", "../A", "/tmp/A", "C:/A", "A\\child", "A/child", "A\n"] {
            let mut links = legacy.links.clone(); links.last_mut().unwrap().target = target.into();
            assert!(verify_framework_links(&root, &links, "darwin").is_err(), "{target}");
        }
        let mut links = legacy.links.clone(); links.push(links[0].clone());
        assert!(verify_framework_links(&root, &links, "darwin").is_err());
        assert!(verify_framework_links(&root, &legacy.links[..2], "darwin").is_err());
        let resources = root.join("Varin.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources");
        fs::remove_dir_all(&resources).unwrap(); std::os::unix::fs::symlink("/tmp", &resources).unwrap();
        assert!(verify_framework_links(&root, &legacy.links, "darwin").is_err());
    }
}
