//! Immutable content primitives shared with the system kernel. Conversation objects have a
//! separate lifetime: the replaceable kernel catalog must never collect native user assets.
use crate::catalog::RuntimeError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
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

pub(crate) struct ContentStore {
    root: PathBuf,
}
impl ContentStore {
    pub(crate) fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("objects"))?;
        fs::create_dir_all(root.join("staging"))?;
        sync_directory(&root)?;
        if let Some(parent) = root.parent() {
            sync_directory(parent)?;
        }
        Ok(Self { root })
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
        let bytes = serde_json::to_vec(value)?;
        let mut chunks = Vec::new();
        let (mut start, mut rolling) = (0, 0u64);
        for (i, byte) in bytes.iter().enumerate() {
            rolling = rolling
                .rotate_left(1)
                .wrapping_add((*byte as u64 + 1).wrapping_mul(0x9e3779b185ebca87));
            let size = i + 1 - start;
            if size >= 16 * 1024 && (rolling & 0xffff == 0 || size >= 256 * 1024) {
                chunks.push(self.put_bytes(&bytes[start..=i])?);
                start = i + 1;
                rolling = 0;
            }
        }
        if start < bytes.len() {
            chunks.push(self.put_bytes(&bytes[start..])?);
        }
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
    pub(crate) fn load(&self, reference: &Value) -> Result<Value> {
        let reference: Reference = serde_json::from_value(reference.clone())?;
        let manifest: Manifest =
            serde_json::from_slice(&self.read_bytes(&reference.content_object)?)?;
        if manifest.version != 1 {
            return Err(RuntimeError::Invalid("unsupported content manifest".into()));
        }
        let mut bytes = Vec::new();
        for hash in manifest.chunks {
            bytes.extend(self.read_bytes(&hash)?);
        }
        if bytes.len() as u64 != manifest.bytes {
            return Err(RuntimeError::Invalid(
                "content manifest length mismatch".into(),
            ));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    /// Called under the catalog's exclusive owner lock. Every retained request is a GC root;
    /// failures during mark abort sweep, and objects saved by a rolled-back commit are collectible.
    pub(crate) fn collect(&self, db: &Connection) -> Result<u64> {
        let mut live = HashSet::new();
        let mut stmt = db.prepare("SELECT json_extract(body,'$.request') FROM model_steps")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            let reference: Reference = serde_json::from_str(&row?)?;
            let manifest: Manifest =
                serde_json::from_slice(&self.read_bytes(&reference.content_object)?)?;
            if manifest.version != 1 {
                return Err(RuntimeError::Invalid("unsupported content manifest".into()));
            }
            live.insert(reference.content_object);
            let mut length = 0u64;
            for hash in manifest.chunks {
                length += self.read_bytes(&hash)?.len() as u64;
                live.insert(hash);
            }
            if length != manifest.bytes {
                return Err(RuntimeError::Invalid(
                    "content manifest length mismatch".into(),
                ));
            }
        }
        let mut removed = 0;
        for shard in fs::read_dir(self.root.join("objects"))? {
            let shard = shard?;
            if !shard.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(shard.path())? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    continue;
                }
                let hash = format!(
                    "sha256-{}{}",
                    shard.file_name().to_string_lossy(),
                    entry.file_name().to_string_lossy()
                );
                // Unknown files are not ours to delete.
                if object_path(&self.root, &hash).ok().as_ref() != Some(&entry.path()) {
                    continue;
                }
                if !live.contains(&hash) {
                    fs::remove_file(entry.path())?;
                    removed += 1;
                }
            }
            sync_directory(&shard.path())?;
        }
        // No save can be in flight while the Catalog owner invokes collection. Staging files
        // from a process crash are never authoritative; preserve anything outside our UUID names.
        for entry in fs::read_dir(self.root.join("staging"))? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
            {
                fs::remove_file(entry.path())?;
            }
        }
        sync_directory(&self.root.join("staging"))?;
        Ok(removed)
    }
}

/// One atomic conversion of the current native catalog representation. Original histories and
/// provider values are preserved. Interrupted conversions leave only unreferenced immutable objects.
pub(crate) fn initialize(db: &mut Connection, content: &ContentStore) -> Result<()> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_content_format')", [], |r| r.get(0))?;
    let catalog_version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if !exists && catalog_version == 2 {
        return Err(RuntimeError::Invalid(
            "content format marker missing".into(),
        ));
    }
    if exists {
        if catalog_version != 2 {
            return Err(RuntimeError::Format(catalog_version));
        }
        let version: i64 = db.query_row(
            "SELECT version FROM runtime_content_format WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if version != 1 {
            return Err(RuntimeError::Format(version));
        }
        return Ok(());
    }
    let converted = {
        let mut stmt = db.prepare("SELECT id,body FROM model_steps")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut converted = Vec::new();
        for row in rows {
            let (id, raw) = row?;
            let mut step: Value = serde_json::from_str(&raw)?;
            let request = step
                .get_mut("request")
                .ok_or_else(|| RuntimeError::Invalid("model step request missing".into()))?;
            *request = content.save(request)?;
            converted.push((id, serde_json::to_string(&step)?));
        }
        converted
    };
    let tx = db.transaction()?;
    for (id, body) in converted {
        tx.execute(
            "UPDATE model_steps SET body=?2 WHERE id=?1",
            params![id, body],
        )?;
    }
    tx.execute_batch("CREATE TABLE runtime_content_format(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL); INSERT INTO runtime_content_format VALUES(1,1); PRAGMA user_version=2;")?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
