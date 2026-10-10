//! Immutable content primitives shared with the system kernel. Conversation objects have a
//! separate lifetime: the replaceable kernel catalog must never collect user assets.
use crate::catalog::RuntimeError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::fs::File;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

type Result<T> = std::result::Result<T, RuntimeError>;

/// The same object identity/layout as kernel file content, with strict traversal rejection.
pub fn object_path(root: &Path, hash: &str) -> std::io::Result<PathBuf> {
    let hex = hash
        .strip_prefix("sha256-")
        .filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "malformed content hash")
        })?;
    Ok(root.join("objects").join(&hex[..2]).join(&hex[2..]))
}
fn identity(bytes: &[u8]) -> String {
    format!("sha256-{}", hex::encode(Sha256::digest(bytes)))
}
fn content_chunks(bytes: &[u8]) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let (mut start, mut rolling) = (0, 0u64);
    for (index, byte) in bytes.iter().enumerate() {
        rolling = rolling
            .rotate_left(1)
            .wrapping_add((*byte as u64 + 1).wrapping_mul(0x9e3779b185ebca87));
        let size = index + 1 - start;
        if size >= 16 * 1024 && (rolling & 0xffff == 0 || size >= 256 * 1024) {
            chunks.push(&bytes[start..=index]);
            start = index + 1;
            rolling = 0;
        }
    }
    if start < bytes.len() {
        chunks.push(&bytes[start..]);
    }
    chunks
}
fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    bytes: u64,
    chunks: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    content_object: String,
}

#[derive(Clone)]
pub(crate) struct ContentStore {
    root: PathBuf,
    coordination: Arc<ContentCoordination>,
}
#[derive(Default)]
struct PublicationState {
    active: usize,
    sequence: u64,
    collector: Option<Arc<AtomicBool>>,
}
#[derive(Default)]
struct ContentCoordination {
    // Never held during content I/O or while waiting for the I/O gate.
    state: Mutex<PublicationState>,
    io: RwLock<()>,
    #[cfg(test)]
    write_hook: Mutex<Option<Arc<dyn Fn(&Path) + Send + Sync>>>,
}
/// Registered under Catalog ownership, retained across worker I/O and reference commit.
/// Registration never waits for sweep; its sequence invalidates any older mark.
pub(crate) struct ContentPublication(Arc<ContentCoordination>);
impl Drop for ContentPublication {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active -= 1;
    }
}
#[path = "content_collection.rs"]
pub(crate) mod collection;
pub use collection::{ContentCollection, ContentCollectionAdmission};
pub struct ContentChunk {
    pub content_ref: String,
    pub chunk_index: usize,
    pub chunk_count: usize,
    pub total_bytes: u64,
    pub bytes: Vec<u8>,
}
impl ContentStore {
    #[cfg(test)]
    pub(crate) fn set_write_hook(&self, hook: Option<Arc<dyn Fn(&Path) + Send + Sync>>) {
        *self.coordination.write_hook.lock().unwrap() = hook;
    }
    pub(crate) fn begin_publication(&self) -> ContentPublication {
        let mut state = self
            .coordination
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        state.sequence = state
            .sequence
            .checked_add(1)
            .expect("content publication sequence exhausted");
        state.active += 1;
        ContentPublication(self.coordination.clone())
    }
    /// Synchronous fixture conveniences must never wait for a collector while holding Catalog.
    /// Real execution captures an owned preparation/read and performs I/O after unlocking Catalog.
    pub(crate) fn begin_synchronous(&self) -> Result<ContentPublication> {
        let mut state = self
            .coordination
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.collector.is_some() {
            return Err(RuntimeError::Conflict(
                "synchronous content access during collection; use the prepared worker API".into(),
            ));
        }
        state.sequence = state
            .sequence
            .checked_add(1)
            .expect("content publication sequence exhausted");
        state.active += 1;
        Ok(ContentPublication(self.coordination.clone()))
    }
    pub(crate) fn cancel_collection(&self) {
        let state = self
            .coordination
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(cancel) = &state.collector {
            cancel.store(true, Ordering::Release);
        }
    }
    pub(crate) fn load_chunk(&self, reference: &Value, index: usize) -> Result<ContentChunk> {
        let _publication = self.begin_publication();
        let _io = self
            .coordination
            .io
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let reference: Reference = serde_json::from_value(reference.clone())?;
        let manifest: Manifest =
            serde_json::from_slice(&self.read_bytes(&reference.content_object)?)?;
        if manifest.version != 1 {
            return Err(RuntimeError::Invalid("unsupported content manifest".into()));
        }
        let hash = manifest
            .chunks
            .get(index)
            .ok_or_else(|| RuntimeError::Invalid("content chunk index out of range".into()))?;
        let bytes = self.read_bytes(hash)?;
        Ok(ContentChunk {
            content_ref: reference.content_object,
            chunk_index: index,
            chunk_count: manifest.chunks.len(),
            total_bytes: manifest.bytes,
            bytes,
        })
    }

    pub(crate) fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("objects"))?;
        fs::create_dir_all(root.join("staging"))?;
        sync_directory(&root)?;
        if let Some(parent) = root.parent() {
            sync_directory(parent)?;
        }
        Ok(Self {
            root,
            coordination: Arc::new(ContentCoordination::default()),
        })
    }
    fn put_bytes(&self, bytes: &[u8]) -> Result<String> {
        let hash = identity(bytes);
        let target = object_path(&self.root, &hash)?;
        if target.exists() {
            self.read_bytes(&hash)?;
            return Ok(hash);
        }
        let shard = target.parent().expect("object shard");
        fs::create_dir_all(shard)?;
        sync_directory(&self.root.join("objects"))?;
        let staging = self
            .root
            .join("staging")
            .join(uuid::Uuid::new_v4().to_string());
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            #[cfg(test)]
            {
                let hook = self.coordination.write_hook.lock().unwrap().clone();
                if let Some(hook) = hook {
                    hook(&staging);
                }
            }
            // A hard link installs without replacing an existing immutable object. Both paths
            // are inside one filesystem; unlike rename this never clobbers concurrent content.
            match fs::hard_link(&staging, &target) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.read_bytes(&hash)?;
                }
                Err(e) => return Err(e.into()),
            }
            sync_directory(shard)?;
            fs::remove_file(&staging)?;
            sync_directory(&self.root.join("staging"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&staging);
        }
        result?;
        Ok(hash)
    }
    fn read_bytes(&self, hash: &str) -> Result<Vec<u8>> {
        let bytes = fs::read(object_path(&self.root, hash)?)?;
        if identity(&bytes) != hash {
            return Err(RuntimeError::Invalid(format!(
                "corrupt content object {hash}"
            )));
        }
        Ok(bytes)
    }
    /// Content-defined chunks preserve unchanged history across newly appended request snapshots.
    /// Serialization still visits the full provider request; only changed chunks need durable writes.
    pub(crate) fn save(&self, value: &Value) -> Result<Value> {
        let _publication = self.begin_publication();
        let _io = self
            .coordination
            .io
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let bytes = serde_json::to_vec(value)?;
        let chunks = content_chunks(&bytes)
            .into_iter()
            .map(|chunk| self.put_bytes(chunk))
            .collect::<Result<Vec<_>>>()?;
        let manifest = Manifest {
            version: 1,
            bytes: bytes.len() as u64,
            chunks,
        };
        let hash = self.put_bytes(&serde_json::to_vec(&manifest)?)?;
        Ok(serde_json::to_value(Reference {
            content_object: hash,
        })?)
    }
    /// Derive the same identity without filesystem I/O. Large values are fingerprinted on workers.
    pub(crate) fn reference(value: &Value) -> Result<Value> {
        let bytes = serde_json::to_vec(value)?;
        let manifest = Manifest {
            version: 1,
            bytes: bytes.len() as u64,
            chunks: content_chunks(&bytes).into_iter().map(identity).collect(),
        };
        Ok(serde_json::to_value(Reference {
            content_object: identity(&serde_json::to_vec(&manifest)?),
        })?)
    }
    pub(crate) fn load(&self, reference: &Value) -> Result<Value> {
        self.load_cancellable(reference, &||false)
    }
    pub(crate) fn load_cancellable(&self, reference: &Value, cancelled: &dyn Fn()->bool) -> Result<Value> {
        if cancelled() { return Err(RuntimeError::DispatchCancelled); }
        let _publication = self.begin_publication();
        let _io = self
            .coordination
            .io
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let reference: Reference = serde_json::from_value(reference.clone())?;
        let manifest: Manifest =
            serde_json::from_slice(&self.read_bytes(&reference.content_object)?)?;
        if manifest.version != 1 {
            return Err(RuntimeError::Invalid("unsupported content manifest".into()));
        }
        let mut bytes = Vec::new();
        for hash in manifest.chunks {
            if cancelled() { return Err(RuntimeError::DispatchCancelled); }
            bytes.extend(self.read_bytes(&hash)?);
        }
        if bytes.len() as u64 != manifest.bytes {
            return Err(RuntimeError::Invalid(
                "content manifest length mismatch".into(),
            ));
        }
        if cancelled() { return Err(RuntimeError::DispatchCancelled); }
        let value = serde_json::from_slice(&bytes)?;
        if cancelled() { return Err(RuntimeError::DispatchCancelled); }
        Ok(value)
    }
    pub(crate) fn save_history(
        &self,
        content: &Value,
        provider: &Option<crate::types::ProviderOriginal>,
    ) -> Result<Value> {
        self.save(&serde_json::json!({"content": content, "provider": provider}))
    }
    pub(crate) fn hydrate_history(
        &self,
        mut item: crate::types::HistoryItem,
    ) -> Result<crate::types::HistoryItem> {
        let (content, provider) = self.load_history_payload(&item.content)?;
        item.content = content;
        item.provider = provider;
        Ok(item)
    }
    pub(crate) fn load_history_payload(&self, reference: &Value) -> Result<(Value, Option<crate::types::ProviderOriginal>)> {
        self.load_history_payload_cancellable(reference, &||false)
    }
    pub(crate) fn load_history_payload_cancellable(&self, reference: &Value, cancelled: &dyn Fn()->bool) -> Result<(Value, Option<crate::types::ProviderOriginal>)> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Payload { content: Value, provider: Option<crate::types::ProviderOriginal> }
        let payload: Payload = serde_json::from_value(self.load_cancellable(reference, cancelled)?)?;
        Ok((payload.content, payload.provider))
    }
    pub(crate) fn save_originals(
        &self,
        originals: &[crate::types::ProviderOriginal],
    ) -> Result<Vec<crate::types::ProviderOriginal>> {
        originals
            .iter()
            .cloned()
            .map(|mut original| {
                original.item = self.save(&original.item)?;
                Ok(original)
            })
            .collect()
    }
    pub(crate) fn hydrate_originals(
        &self,
        originals: &mut [crate::types::ProviderOriginal],
    ) -> Result<()> {
        for original in originals {
            original.item = self.load(&original.item)?;
        }
        Ok(())
    }
}

/// Internal representations are not migrated. Unknown formats and all original files remain intact.
pub(crate) fn initialize(db: &Connection, _content: &ContentStore) -> Result<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let format: i64 = db.query_row(
        "SELECT version FROM runtime_content_format WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    if version != crate::catalog::FORMAT || format != 3 {
        return Err(RuntimeError::Invalid(
            "unsupported content format; data was preserved".into(),
        ));
    }
    db.prepare("SELECT input_id,body FROM input_history_content")?;
    Ok(())
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
