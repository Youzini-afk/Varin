//! Immutable content primitives shared with the system kernel. Conversation objects have a
//! separate lifetime: the replaceable kernel catalog must never collect user assets.
use crate::catalog::RuntimeError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicUsize, Ordering}},
};
#[cfg(unix)]
use std::fs::File;

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

#[derive(Clone)]
pub(crate) struct ContentStore {
    root: PathBuf,
    publications: Arc<AtomicUsize>,
}
/// Acquired under Catalog ownership, then retained across body I/O and reference commit.
/// Collection defers while a publication is in flight; it never waits with Catalog locked.
pub(crate) struct ContentPublication(Arc<AtomicUsize>);
impl Drop for ContentPublication {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::Release); }
}
pub struct ContentChunk {
    pub content_ref:String,
    pub chunk_index:usize,
    pub chunk_count:usize,
    pub total_bytes:u64,
    pub bytes:Vec<u8>,
}
impl ContentStore {
    pub(crate) fn begin_publication(&self) -> ContentPublication {
        self.publications.fetch_add(1, Ordering::Acquire);
        ContentPublication(self.publications.clone())
    }
    pub(crate) fn load_chunk(&self, reference:&Value, index:usize)->Result<ContentChunk>{
        let reference:Reference=serde_json::from_value(reference.clone())?;
        let manifest:Manifest=serde_json::from_slice(&self.read_bytes(&reference.content_object)?)?;
        if manifest.version!=1{return Err(RuntimeError::Invalid("unsupported content manifest".into()));}
        let hash=manifest.chunks.get(index).ok_or_else(||RuntimeError::Invalid("content chunk index out of range".into()))?;
        let bytes=self.read_bytes(hash)?;
        Ok(ContentChunk{content_ref:reference.content_object,chunk_index:index,chunk_count:manifest.chunks.len(),total_bytes:manifest.bytes,bytes})
    }

    pub(crate) fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(root.join("objects"))?;
        fs::create_dir_all(root.join("staging"))?;
        sync_directory(&root)?;
        if let Some(parent) = root.parent() {
            sync_directory(parent)?;
        }
        Ok(Self { root, publications: Arc::new(AtomicUsize::new(0)) })
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
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Payload {
            content: Value,
            provider: Option<crate::types::ProviderOriginal>,
        }
        let payload: Payload = serde_json::from_value(self.load(&item.content)?)?;
        item.content = payload.content;
        item.provider = payload.provider;
        Ok(item)
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

    /// Called under the catalog's exclusive owner lock. Every retained content domain is a GC root;
    /// failures during mark abort sweep, and objects saved by a rolled-back commit are collectible.
    pub(crate) fn collect(&self, db: &Connection) -> Result<u64> {
        // Admission of a publication and collection are serialized by Catalog. An in-flight
        // writer can be waiting to commit its references: waiting here would deadlock it.
        if self.publications.load(Ordering::Acquire) != 0 { return Ok(0); }
        let mut live = HashSet::new();
        let contexts:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_checkpoints')",[],|row|row.get(0))?;
        let mut roots = "SELECT json_extract(body,'$.request') FROM model_steps
             UNION ALL SELECT json_extract(o.value,'$.item') FROM model_steps m, json_each(m.body,'$.original') o
             UNION ALL SELECT json_extract(body,'$.content') FROM history
             UNION ALL SELECT body FROM model_outputs
             UNION ALL SELECT body FROM input_history_content".to_string();
        if contexts {roots.push_str(" UNION ALL SELECT body FROM context_checkpoints");}
        roots.push_str(" UNION ALL SELECT recipe FROM context_jobs UNION ALL SELECT body FROM context_job_parts");
        let mut references=Vec::new();
        let mut stmt=db.prepare(&roots)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows { references.push(serde_json::from_str::<Reference>(&row?)?); }
        let mut operations=db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.kind')='policy_read_graph_v1'")?;
        for row in operations.query_map([],|r|r.get::<_,String>(0))? {
            let op:crate::types::Operation=serde_json::from_str(&row?)?;
            let intent=crate::catalog::policy::graph_intent(&op)?.ok_or_else(||RuntimeError::Invalid("graph intent missing".into()))?;
            let result=crate::catalog::policy::graph_result(&op,&intent)?;
            for receipt in result.receipts.values() { if let Some(output)=&receipt.output {references.push(Reference{content_object:output.content_ref.clone()});} }
        }
        let mut jobs=db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.kind')='policy_model_job_v1'")?;
        for row in jobs.query_map([],|r|r.get::<_,String>(0))? {
            let op:crate::types::Operation=serde_json::from_str(&row?)?;
            crate::catalog::policy_model::model_intent(&op)?.ok_or_else(||RuntimeError::Invalid("planning intent missing".into()))?;
            let result=crate::catalog::policy_model::model_result(&op)?;
            references.push(serde_json::from_value(result.request_ref)?);
            if let Some(original)=result.original_ref{references.push(serde_json::from_value(original)?);}
            if let Some(output)=result.receipt.and_then(|r|r.output){references.push(Reference{content_object:output.content_ref});}
        }
        for reference in references {
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

/// Internal representations are not migrated. Unknown formats and all original files remain intact.
pub(crate) fn initialize(db: &mut Connection, _content: &ContentStore) -> Result<()> {
    let version:i64=db.pragma_query_value(None,"user_version",|r|r.get(0))?;
    let format:i64=db.query_row("SELECT version FROM runtime_content_format WHERE id=1",[],|r|r.get(0))?;
    if version!=crate::catalog::FORMAT||format!=3 {return Err(RuntimeError::Invalid("unsupported content format; data was preserved".into()));}
    db.prepare("SELECT input_id,body FROM input_history_content")?;
    Ok(())
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
