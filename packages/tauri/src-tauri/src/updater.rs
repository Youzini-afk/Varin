//! Trusted desktop update owner. The renderer supplies neither feed, target,
//! public key, file path nor an installation/drain receipt.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const FEED: &str = "https://github.com/Youzini-afk/Varin/releases/latest/download/tauri-v1.json";
const PUBLIC_KEY: Option<&str> = option_env!("VARIN_TAURI_UPDATER_PUBLIC_KEY");
struct Pending {
    update: Update,
    downloaded: Option<PathBuf>,
}
#[derive(Default)]
pub struct Owner {
    pending: Mutex<Option<Pending>>,
}

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::DynRuntime, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new()
        .pubkey(PUBLIC_KEY.unwrap_or(""))
        .build()
}
fn target() -> String {
    format!(
        "{}-{}",
        crate::manifest::platform(),
        crate::manifest::architecture()
    )
}
fn public_key() -> Result<&'static str, String> {
    PUBLIC_KEY
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Updates are unavailable: this build has no release verification key".into())
}
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    public_key()?;
    let mut builder = app
        .updater_builder()
        .target(target())
        .endpoints(vec![url::Url::parse(FEED).expect("fixed updater URL")])
        .map_err(|_| "Invalid installed updater configuration")?
        .pubkey(public_key()?)
        .timeout(Duration::from_secs(120));
    #[cfg(target_os = "linux")]
    {
        let appimage = PathBuf::from(
            app.env()
                .appimage
                .ok_or("Updates require the installed AppImage, not an extracted application")?,
        );
        if !appimage.is_absolute() || !appimage.is_file() {
            return Err("The installed AppImage is unavailable".into());
        }
        builder = builder.executable_path(appimage);
    }
    let handle = app.clone();
    builder = builder.on_before_exit(move || handle.cleanup_before_exit());
    builder
        .build()
        .map_err(|_| "The installed updater could not be initialized".into())
}
fn validate_bytes(update: &Update, bytes: &[u8]) -> Result<(), String> {
    update
        .verify(bytes)
        .map_err(|_| "Update package signature verification failed")?;
    let artifact = &update.raw_json["platforms"][target()];
    let sha = format!("{:x}", Sha256::digest(bytes));
    if artifact["size"].as_u64() != Some(bytes.len() as u64)
        || artifact["sha256"].as_str() != Some(sha.as_str())
    {
        return Err("Update package differs from its signed release metadata".into());
    }
    Ok(())
}
fn save_download(directory: &Path, bytes: &[u8], metadata: &Value) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|_| "Update cache is unavailable")?;
    if std::fs::symlink_metadata(directory)
        .map_err(|_| "Update cache is unavailable")?
        .file_type()
        .is_symlink()
    {
        return Err("Update cache cannot be a symbolic link".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Update cache could not be secured")?;
    }
    let file = directory.join(format!("{}.update", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        use std::io::Write;
        let mut writer = options.open(&file)?;
        writer.write_all(bytes)?;
        writer.sync_all()
    })()
    .map_err(|_: std::io::Error| "Verified update could not be cached".to_owned());
    if let Err(error) = result {
        let _ = std::fs::remove_file(&file);
        return Err(error);
    }
    let record = directory.join("pending.json");
    let temporary = directory.join(format!("{}.pending", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut writer = options
            .open(&temporary)
            .map_err(|_| "Update receipt could not be saved")?;
        let value = json!({"schema":1,"file":file.file_name().and_then(|name|name.to_str()),"metadata":metadata});
        writer
            .write_all(
                &serde_json::to_vec(&value).map_err(|_| "Update receipt could not be encoded")?,
            )
            .map_err(|_| "Update receipt could not be saved")?;
        writer
            .sync_all()
            .map_err(|_| "Update receipt could not be synced")?;
        std::fs::rename(&temporary, &record)
            .map_err(|_| "Update receipt could not be committed")?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        let _ = std::fs::remove_file(&file);
        return Err(error);
    }
    Ok(file)
}
fn restore_pending(app: &AppHandle, cache: &Path) -> Result<Option<Pending>, String> {
    let record = cache.join("pending.json");
    match std::fs::symlink_metadata(&record) {
        Ok(stat) if stat.is_file() => {}
        Ok(_) => return Err("Update receipt is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Update receipt is unavailable".into()),
    }
    let document: Value = serde_json::from_slice(
        &std::fs::read(&record).map_err(|_| "Update receipt is unavailable")?,
    )
    .map_err(|_| "Invalid cached update receipt")?;
    if document["schema"] != 1 {
        return Err("Unsupported update cache generation".into());
    }
    let name = document["file"]
        .as_str()
        .ok_or("Missing cached update file")?;
    let id = name
        .strip_suffix(".update")
        .ok_or("Invalid cached update filename")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid cached update filename")?;
    crate::update_metadata::verify(&document["metadata"], public_key()?, &target())?;
    let Some(update) = updater(app)?
        .restore_update(document["metadata"].clone())
        .map_err(|_| "Cached update could not be restored")?
    else {
        let _ = std::fs::remove_file(record);
        return Ok(None);
    };
    let file = crate::manifest::contained_file(cache, name)
        .map_err(|_| "Cached update is not a contained regular file")?;
    let bytes = std::fs::read(&file).map_err(|_| "Cached update file is unavailable")?;
    validate_bytes(&update, &bytes)?;
    Ok(Some(Pending {
        update,
        downloaded: Some(file),
    }))
}
fn forget(pending: Pending) {
    if let Some(file) = pending.downloaded {
        if let Some(directory) = file.parent() {
            let _ = std::fs::remove_file(directory.join("pending.json"));
        }
        let _ = std::fs::remove_file(file);
    }
}
#[derive(Debug)]
pub enum InstallFailure {
    Preparation(String),
    Drain(String),
    Installation(String),
}
impl std::fmt::Display for InstallFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Preparation(message) | Self::Drain(message) | Self::Installation(message) => {
                f.write_str(message)
            }
        }
    }
}
impl Owner {
    pub async fn check(&self, app: &AppHandle) -> Result<Value, String> {
        let mut pending = self
            .pending
            .try_lock()
            .map_err(|_| "Another update operation is already running")?;
        if pending.is_none() {
            let cache = crate::settings::data_directory()?.join("updates");
            match restore_pending(app, &cache) {
                Ok(restored) => *pending = restored,
                Err(_) => {
                    // A damaged local cache is never installed. Discard only our
                    // receipt, then allow a fresh signed online check/download.
                    let _ = std::fs::remove_file(cache.join("pending.json"));
                }
            }
        }
        // A failed check does not discard a previously verified pending package.
        let update = updater(app)?.check().await.map_err(
            |_| "Unable to check for updates; check your network connection and try again",
        )?;
        if let Some(update) = &update {
            crate::update_metadata::verify(&update.raw_json, public_key()?, &target())?;
        }
        let result = match &update {
            Some(update) => {
                json!({"available":true,"currentVersion":app.package_info().version.to_string(),"version":update.version,"body":update.body,"date":update.raw_json["pub_date"]})
            }
            None => {
                json!({"available":false,"currentVersion":app.package_info().version.to_string(),"version":null,"body":null,"date":null})
            }
        };
        if let (Some(old), Some(new)) = (&*pending, &update) {
            if old.update.raw_json == new.raw_json {
                return Ok(result);
            }
        }
        if let Some(old) = pending.take() {
            forget(old);
        }
        *pending = update.map(|update| Pending {
            update,
            downloaded: None,
        });
        Ok(result)
    }
    /// The historical command says "download and install", but its desktop
    /// contract stops at Finished. Explicit desktop_restart performs installation.
    pub async fn download(
        &self,
        app: &AppHandle,
        cache: &Path,
        emit: impl Fn(Value) + Send + Sync,
    ) -> Result<(), String> {
        let mut state = self
            .pending
            .try_lock()
            .map_err(|_| "Another update operation is already running")?;
        let pending = state
            .as_mut()
            .ok_or("No pending update; check for updates first")?;
        public_key()?;
        let _ = app;
        emit(
            json!({"event":"Started","data":{"contentLength":pending.update.raw_json["platforms"][target()]["size"]}}),
        );
        if let Some(file) = &pending.downloaded {
            if let Ok(bytes) = std::fs::read(file) {
                if validate_bytes(&pending.update, &bytes).is_ok() {
                    emit(json!({"event":"Finished","data":{}}));
                    return Ok(());
                }
            }
            let _ = std::fs::remove_file(file);
            pending.downloaded = None;
        }
        let mut downloaded = 0_u64;
        let bytes=pending.update.download(|chunk,total|{
            downloaded=downloaded.saturating_add(chunk as u64);
            emit(json!({"event":"Progress","data":{"chunkLength":chunk,"downloaded":downloaded,"total":total.unwrap_or(0)}}));
        },||{}).await.map_err(|_|"Update download or signature verification failed; the installed version was not changed")?;
        validate_bytes(&pending.update, &bytes)?;
        pending.downloaded = Some(save_download(cache, &bytes, &pending.update.raw_json)?);
        emit(json!({"event":"Finished","data":{}}));
        Ok(())
    }
    pub async fn downloaded(&self) -> bool {
        self.pending
            .lock()
            .await
            .as_ref()
            .is_some_and(|p| p.downloaded.is_some())
    }
    /// The only installation boundary. Verification precedes close prompts;
    /// cancellation preserves the pending update and never reaches install().
    pub async fn install_after_drain<F, Fut>(
        &self,
        app: &AppHandle,
        drain: F,
    ) -> Result<(), InstallFailure>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        let mut state = self.pending.try_lock().map_err(|_| {
            InstallFailure::Preparation("Another update operation is already running".into())
        })?;
        let pending = state
            .as_ref()
            .ok_or_else(|| InstallFailure::Preparation("No pending update".into()))?;
        let file = pending.downloaded.as_ref().ok_or_else(|| {
            InstallFailure::Preparation("Download the update before restarting".into())
        })?;
        let bytes = std::fs::read(file).map_err(|_| {
            InstallFailure::Preparation(
                "Downloaded update is unavailable; download it again".into(),
            )
        })?;
        validate_bytes(&pending.update, &bytes).map_err(InstallFailure::Preparation)?;
        // Distinguish reversible preparation/close cancellation from a platform
        // installer which may have modified files after every local scope ended.
        crate::update_install::after_drain(drain, || pending.update.install(&bytes)
            .map_err(|_| "Update installation failed after local services stopped. Application files may have changed. Quit Varin and open it again; do not retry this installation automatically.".to_owned()))
            .await.map_err(|error|match error {
                crate::update_install::Failure::Drain(message)=>InstallFailure::Drain(message),
                crate::update_install::Failure::Installation(message)=>InstallFailure::Installation(message),
            })?;
        if let Some(old) = state.take() {
            forget(old);
        }
        #[cfg(not(target_os = "windows"))]
        app.restart();
        #[cfg(target_os = "windows")]
        let _ = app;
        #[allow(unreachable_code)]
        Ok(())
    }
}
