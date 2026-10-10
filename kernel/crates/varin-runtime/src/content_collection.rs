//! One ephemeral ContentStore maintenance pass. Catalog only admits the owned handle.
use super::*;
use crate::{
    ContentCollectionPhase as Phase, ContentCollectionReport, ContentCollectionStatus as Status,
};
use rusqlite::OpenFlags;
use std::{collections::HashSet, fs::File, sync::TryLockError};

/// No queue and no persistent operation: a busy store explicitly defers this request.
pub enum ContentCollectionAdmission {
    Ready(ContentCollection),
    Deferred(ContentCollectionReport),
}
impl ContentCollectionAdmission {
    /// Execute only after releasing Catalog. Deferred admissions perform no work.
    pub fn run(self) -> ContentCollectionReport {
        match self {
            Self::Ready(collection) => collection.run(),
            Self::Deferred(report) => report,
        }
    }
}

struct CollectionRoots {
    references: Vec<Reference>,
    requests: Vec<Value>,
    graphs: Vec<Value>,
    dispatches: Vec<Value>,
}
struct CollectorLease {
    coordination: Arc<ContentCoordination>,
    sequence: u64,
    cancellation: Arc<AtomicBool>,
}
impl Drop for CollectorLease {
    fn drop(&mut self) {
        self.coordination
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .collector = None;
    }
}
/// Owns the actual OS runtime.owner lock until this pass can no longer touch content.
/// Dropping an unstarted job or unwinding releases both collection admission and the owner lease.
pub struct ContentCollection {
    content: ContentStore,
    database: PathBuf,
    lease: CollectorLease,
    _owner: Arc<File>,
    #[cfg(test)]
    hook: Option<Arc<dyn Fn(CollectionPoint) + Send + Sync>>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CollectionPoint {
    Roots,
    Verify,
    BeforeSweep,
    Sweep,
    ObjectRemoved,
    Staging,
}

fn report(status: Status, reason: Option<&str>) -> ContentCollectionReport {
    ContentCollectionReport {
        status,
        phase: Phase::Admission,
        removed_objects: 0,
        removed_bytes: 0,
        removed_staging_files: 0,
        reason: reason.map(str::to_owned),
    }
}
impl ContentStore {
    pub(crate) fn prepare_collection(
        &self,
        database: PathBuf,
        owner: Arc<File>,
        cancellation: Arc<AtomicBool>,
    ) -> ContentCollectionAdmission {
        let mut state = self
            .coordination
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let reason = if state.collector.is_some() {
            Some("collector_active")
        } else if state.active != 0 {
            Some("publication_active")
        } else {
            None
        };
        if let Some(reason) = reason {
            return ContentCollectionAdmission::Deferred(report(Status::Deferred, Some(reason)));
        }
        state.collector = Some(cancellation.clone());
        ContentCollectionAdmission::Ready(ContentCollection {
            content: self.clone(),
            database,
            lease: CollectorLease {
                coordination: self.coordination.clone(),
                sequence: state.sequence,
                cancellation,
            },
            _owner: owner,
            #[cfg(test)]
            hook: None,
        })
    }
}

enum Stopped {
    Cancelled,
    PublicationChanged,
    Failed(RuntimeError),
}
impl<E: Into<RuntimeError>> From<E> for Stopped {
    fn from(error: E) -> Self {
        Self::Failed(error.into())
    }
}
type WorkResult<T> = std::result::Result<T, Stopped>;

impl ContentCollection {
    fn check(&self) -> WorkResult<()> {
        if self.lease.cancellation.load(Ordering::Acquire) {
            return Err(Stopped::Cancelled);
        }
        let state = self
            .lease
            .coordination
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.sequence != self.lease.sequence || state.active != 0 {
            return Err(Stopped::PublicationChanged);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn with_hook(mut self, hook: Arc<dyn Fn(CollectionPoint) + Send + Sync>) -> Self {
        self.hook = Some(hook);
        self
    }
    #[cfg(test)]
    fn at(&self, point: CollectionPoint) {
        if let Some(hook) = &self.hook {
            hook(point);
        }
    }
    pub fn run(self) -> ContentCollectionReport {
        let mut result = report(Status::Completed, None);
        let execution =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.execute(&mut result)));
        match execution {
            Ok(Err(stopped)) => match stopped {
                Stopped::Cancelled => result.status = Status::Cancelled,
                Stopped::PublicationChanged => {
                    result.status = Status::Deferred;
                    result.reason = Some("publication_changed".into());
                }
                Stopped::Failed(error) => {
                    result.status = Status::Failed;
                    result.reason = Some(error.to_string());
                }
            },
            Ok(Ok(())) => (),
            Err(_) => {
                result.status = Status::Failed;
                result.reason = Some("content collection worker panicked".into());
            }
        }
        result
    }
    fn execute(&self, result: &mut ContentCollectionReport) -> WorkResult<()> {
        self.check()?;
        result.phase = Phase::Roots;
        self.check()?;
        let references = {
            let mut db = Connection::open_with_flags(
                &self.database,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            // SQLite itself observes cancellation/invalidation inside a long UNION or metadata scan.
            let coordination = self.lease.coordination.clone();
            let cancel = self.lease.cancellation.clone();
            let sequence = self.lease.sequence;
            db.progress_handler(
                1000,
                Some(move || {
                    cancel.load(Ordering::Acquire)
                        || coordination
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .sequence
                            != sequence
                }),
            )?;
            let tx = db.transaction()?;
            let roots = self.roots(&tx);
            // Prefer the precise stop reason over SQLITE_INTERRUPT from the progress callback.
            self.check()?;
            let roots = roots?;
            tx.commit()?;
            roots
        }; // The same-database WAL read snapshot ends before any file verification or sweep.
        result.phase = Phase::Verify;
        let CollectionRoots {
            mut references,
            requests,
            graphs,
            mut dispatches,
        } = references;
        // These bodies are read only after the SQLite snapshot has closed. Follow only typed
        // owner references, never arbitrary user text that happens to resemble a content ref.
        for request in requests {
            self.check()?;
            let body = self.load_body(&request)?;
            if let Some(reference) = body
                .pointer("/view/binding/child_dispatch")
                .filter(|v| !v.is_null())
            {
                dispatches.push(reference.clone());
            }
        }
        for graph in graphs {
            self.check()?;
            let body = self.load_body(&graph)?;
            if let Some(nodes) = body.get("nodes").and_then(Value::as_array) {
                for node in nodes {
                    if let Some(reference) = node.get("child_dispatch").filter(|v| !v.is_null()) {
                        dispatches.push(reference.clone());
                    }
                }
            }
        }
        let mut seen_dispatches = HashSet::new();
        for dispatch in dispatches {
            self.check()?;
            let reference: Reference = serde_json::from_value(dispatch.clone())?;
            if !seen_dispatches.insert(reference.content_object.clone()) {
                continue;
            }
            let frozen: crate::catalog::dispatch::FrozenChildDispatch =
                serde_json::from_value(self.load_body(&dispatch)?)?;
            references.push(reference);
            references.push(serde_json::from_value(frozen.catalog_ref)?);
            references.push(serde_json::from_value(frozen.tools_ref)?);
            references.push(serde_json::from_value(frozen.extension_bindings_ref)?);
            if let Some(reference) = frozen.mcp_binding_ref {
                references.push(serde_json::from_value(reference)?);
            }
        }
        let mut live = HashSet::new();
        let mut verified = HashSet::new();
        for reference in references {
            self.check()?;
            if !verified.insert(reference.content_object.clone()) {
                continue;
            }
            let manifest: Manifest =
                serde_json::from_slice(&self.content.read_bytes(&reference.content_object)?)?;
            if manifest.version != 1 {
                return Err(RuntimeError::Invalid("unsupported content manifest".into()).into());
            }
            #[cfg(test)]
            self.at(CollectionPoint::Verify);
            self.check()?;
            live.insert(reference.content_object);
            let mut length = 0u64;
            for hash in manifest.chunks {
                self.check()?;
                length = length
                    .checked_add(self.content.read_bytes(&hash)?.len() as u64)
                    .ok_or_else(|| {
                        RuntimeError::Invalid("content manifest length overflow".into())
                    })?;
                live.insert(hash);
            }
            if length != manifest.bytes {
                return Err(
                    RuntimeError::Invalid("content manifest length mismatch".into()).into(),
                );
            }
        }
        self.check()?;
        #[cfg(test)]
        self.at(CollectionPoint::BeforeSweep);
        self.check()?;
        // A foreground body already holding the shared gate registered its publication first.
        // Never wait behind it: discard this pass instead of delaying foreground I/O.
        let _io = match self.lease.coordination.io.try_write() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                self.check()?;
                return Err(Stopped::PublicationChanged);
            }
            // The gate protects physical I/O, not mutable logical state. A failed prior pass
            // can leave extra orphans, but cannot invalidate a new mark of the actual roots.
            Err(TryLockError::Poisoned(error)) => error.into_inner(),
        };
        self.check()?;
        result.phase = Phase::Sweep;
        #[cfg(test)]
        self.at(CollectionPoint::Sweep);
        self.sweep(&live, result)?;
        result.phase = Phase::Staging;
        #[cfg(test)]
        self.at(CollectionPoint::Staging);
        self.staging(result)?;
        Ok(())
    }
    fn load_body(&self, value: &Value) -> WorkResult<Value> {
        self.check()?;
        let reference: Reference = serde_json::from_value(value.clone())?;
        let manifest: Manifest =
            serde_json::from_slice(&self.content.read_bytes(&reference.content_object)?)?;
        if manifest.version != 1 {
            return Err(RuntimeError::Invalid("unsupported content manifest".into()).into());
        }
        let mut bytes = Vec::new();
        for hash in manifest.chunks {
            self.check()?;
            bytes.extend(self.content.read_bytes(&hash)?);
        }
        if bytes.len() as u64 != manifest.bytes {
            return Err(RuntimeError::Invalid("content manifest length mismatch".into()).into());
        }
        self.check()?;
        Ok(serde_json::from_slice(&bytes)?)
    }
    fn roots(&self, db: &Connection) -> WorkResult<CollectionRoots> {
        let mut roots = "SELECT json_extract(body,'$.request') FROM model_steps
             UNION ALL SELECT json_extract(o.value,'$.item') FROM model_steps m, json_each(m.body,'$.original') o
             UNION ALL SELECT json_extract(body,'$.content') FROM history
             UNION ALL SELECT body FROM model_outputs
             UNION ALL SELECT body FROM input_history_content
             UNION ALL SELECT intent FROM commands".to_string();
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.objective_ref') FROM goals UNION ALL SELECT json_extract(body,'$.start_intent') FROM goals UNION ALL SELECT json_extract(body,'$.reason_ref') FROM goals WHERE json_extract(body,'$.reason_ref') IS NOT NULL");
        roots.push_str(" UNION ALL SELECT body FROM context_checkpoints UNION ALL SELECT body FROM memory_states");
        roots.push_str(" UNION ALL SELECT recipe FROM context_jobs UNION ALL SELECT body FROM context_job_parts");
        roots.push_str(" UNION ALL SELECT json_extract(data,'$.composition') FROM events WHERE kind='run.tools_activated'");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.selection.tools_ref') FROM run_launches
            UNION ALL SELECT json_extract(body,'$.selection.base_tools_ref') FROM run_launches
            UNION ALL SELECT json_extract(body,'$.selection.extension_bindings_ref') FROM run_launches
            UNION ALL SELECT json_extract(body,'$.selection.mcp_binding_ref') FROM run_launches WHERE json_extract(body,'$.selection.mcp_binding_ref') IS NOT NULL
            UNION ALL SELECT json_extract(p.value,'$.body') FROM run_launches l,json_each(l.body,'$.selection.policy_models') p");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.instruction_ref') FROM followups WHERE json_extract(body,'$.instruction_ref') IS NOT NULL");
        roots.push_str(" UNION ALL SELECT json_extract(m.value,'$.body') FROM policy_selections p,json_each(p.body,'$.models') m");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.result.value.answer_ref') FROM operations WHERE json_extract(body,'$.executor')='ask_user' AND json_extract(body,'$.result.value.answer_ref') IS NOT NULL");
        roots.push_str(" UNION ALL SELECT state_ref FROM policy_checkpoints UNION ALL SELECT pending_state_ref FROM policy_checkpoints WHERE pending_state_ref IS NOT NULL UNION ALL SELECT action_ref FROM policy_checkpoints WHERE action_ref IS NOT NULL UNION ALL SELECT continuation_ref FROM policy_checkpoints WHERE continuation_ref IS NOT NULL");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.arguments_ref') FROM tool_calls
            UNION ALL SELECT json_extract(body,'$.intent.call.arguments_ref') FROM operations WHERE json_extract(body,'$.intent.kind')='tool'");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.result.value.permission.call_ref') FROM operations WHERE json_extract(body,'$.result.value.permission.call_ref') IS NOT NULL
            UNION ALL SELECT json_extract(body,'$.result.value.permission.scope_ref') FROM operations WHERE json_extract(body,'$.result.value.permission.scope_ref') IS NOT NULL
            UNION ALL SELECT json_extract(data,'$.result.value.permission.call_ref') FROM events WHERE kind='permission.opened'
            UNION ALL SELECT json_extract(data,'$.result.value.permission.scope_ref') FROM events WHERE kind='permission.opened'");
        roots.push_str(
            " UNION ALL SELECT json_extract(body,'$.input_ref') FROM delegated_executions
            UNION ALL SELECT json_extract(body,'$.configuration_ref') FROM delegated_executions
            UNION ALL SELECT json_extract(body,'$.launch.tools_ref') FROM delegated_executions
            UNION ALL SELECT json_extract(body,'$.launch.base_tools_ref') FROM delegated_executions
            UNION ALL SELECT json_extract(body,'$.launch.extension_bindings_ref') FROM delegated_executions
            UNION ALL SELECT json_extract(body,'$.launch.mcp_binding_ref') FROM delegated_executions WHERE json_extract(body,'$.launch.mcp_binding_ref') IS NOT NULL
            UNION ALL SELECT json_extract(p.value,'$.body') FROM delegated_executions c,json_each(c.body,'$.launch.policy_models') p
            UNION ALL SELECT json_extract(body,'$.source.provenance_ref') FROM delegated_executions WHERE json_extract(body,'$.source.kind')='ready' UNION ALL SELECT json_extract(body,'$.source_basis.provenance_ref') FROM delegated_executions WHERE json_extract(body,'$.source_basis') IS NOT NULL",
        );
        roots.push_str(&format!(" UNION ALL SELECT json_extract(body,'$.intent.body_ref') FROM operations WHERE json_extract(body,'$.intent.kind') IN ({})", crate::catalog::policy_body::ACTION_KINDS));
        roots.push_str("
            UNION ALL SELECT json_extract(receipt,'$.completion.content_ref') FROM policy_graph_nodes WHERE json_extract(receipt,'$.completion.kind')='result'
            UNION ALL SELECT json_extract(receipt,'$.completion.reason_ref') FROM policy_graph_nodes WHERE json_extract(receipt,'$.completion.kind')='not_dispatched'
            UNION ALL SELECT json_extract(call,'$.arguments_ref') FROM policy_graph_nodes");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.result.reference') FROM operations WHERE json_extract(body,'$.result.kind')='content'
            UNION ALL SELECT json_extract(body,'$.external_receipt.result_ref') FROM operations WHERE json_extract(body,'$.external_receipt') IS NOT NULL
            UNION ALL SELECT json_extract(data,'$.result.reference') FROM events WHERE json_extract(data,'$.result.kind')='content'
            UNION ALL SELECT json_extract(data,'$.external_receipt.result_ref') FROM events WHERE json_extract(data,'$.external_receipt') IS NOT NULL
            UNION ALL SELECT json_extract(receipt,'$.completion.content_ref') FROM tool_calls WHERE json_extract(receipt,'$.completion.kind')='result'
            UNION ALL SELECT json_extract(receipt,'$.completion.reason_ref') FROM tool_calls WHERE json_extract(receipt,'$.completion.kind')='not_dispatched'");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.call_completion.content_ref') FROM operations WHERE json_extract(body,'$.call_completion.kind')='result'
            UNION ALL SELECT json_extract(body,'$.call_completion.reason_ref') FROM operations WHERE json_extract(body,'$.call_completion.kind')='not_dispatched'
            UNION ALL SELECT json_extract(data,'$.call_completion.content_ref') FROM events WHERE json_extract(data,'$.call_completion.kind')='result'
            UNION ALL SELECT json_extract(data,'$.call_completion.reason_ref') FROM events WHERE json_extract(data,'$.call_completion.kind')='not_dispatched'");
        roots.push_str(" UNION ALL SELECT json_extract(body,'$.selection.child_dispatch_ref') FROM run_launches WHERE json_extract(body,'$.selection.child_dispatch_ref') IS NOT NULL

            UNION ALL SELECT json_extract(body,'$.launch.child_dispatch_ref') FROM delegated_executions WHERE json_extract(body,'$.launch.child_dispatch_ref') IS NOT NULL
            UNION ALL SELECT json_extract(body,'$.selected_profile_ref') FROM child_tasks
            UNION ALL SELECT json_extract(body,'$.child_dispatch_ref') FROM model_selections WHERE json_extract(body,'$.child_dispatch_ref') IS NOT NULL");
        let mut references = Vec::new();
        let mut stmt = db.prepare(&roots)?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            self.check()?;
            references.push(serde_json::from_str::<Reference>(&row?)?);
            #[cfg(test)]
            self.at(CollectionPoint::Roots);
        }
        let mut jobs=db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.intent.kind')='policy_model_job_v1'")?;
        for row in jobs.query_map([], |r| r.get::<_, String>(0))? {
            self.check()?;
            let op: crate::types::OperationMetadata = serde_json::from_str(&row?)?;
            crate::catalog::policy_model::model_metadata(&op)?
                .ok_or_else(|| RuntimeError::Invalid("planning intent missing".into()))?;
            let result = crate::catalog::policy_model::model_result(&op)?;
            references.push(serde_json::from_value(result.request_ref)?);
            if let Some(original) = result.original_ref {
                references.push(serde_json::from_value(original)?);
            }
            if let Some(output) = result.receipt.and_then(|r| r.output) {
                references.push(Reference {
                    content_object: output.content_ref,
                });
            }
        }
        let capture = |sql: &str| -> WorkResult<Vec<Value>> {
            let mut statement = db.prepare(sql)?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            let mut values = Vec::new();
            for row in rows {
                self.check()?;
                values.push(serde_json::from_str(&row?)?);
            }
            Ok(values)
        };
        let requests = capture("SELECT json_extract(body,'$.request') FROM model_steps")?;
        let graphs = capture("SELECT json_extract(body,'$.intent.body_ref') FROM operations WHERE json_extract(body,'$.intent.kind')='policy_tool_graph_v1'")?;
        let dispatches = capture("SELECT json_extract(body,'$.dispatch_context_ref') FROM run_launches WHERE json_extract(body,'$.dispatch_context_ref') IS NOT NULL UNION ALL SELECT json_extract(body,'$.dispatch_context_ref') FROM child_tasks")?;
        Ok(CollectionRoots {
            references,
            requests,
            graphs,
            dispatches,
        })
    }
    fn sweep(
        &self,
        live: &HashSet<String>,
        result: &mut ContentCollectionReport,
    ) -> WorkResult<()> {
        for shard in fs::read_dir(self.content.root.join("objects"))? {
            self.check()?;
            let shard = shard?;
            if !shard.file_type()?.is_dir() {
                continue;
            }
            let mut changed = false;
            let removal = (|| -> WorkResult<()> {
                for entry in fs::read_dir(shard.path())? {
                    self.check()?;
                    let entry = entry?;
                    if !entry.file_type()?.is_file() {
                        continue;
                    }
                    let hash = format!(
                        "sha256-{}{}",
                        shard.file_name().to_string_lossy(),
                        entry.file_name().to_string_lossy()
                    );
                    // Unknown files are never garbage owned by this store.
                    if object_path(&self.content.root, &hash).ok().as_ref() != Some(&entry.path())
                        || live.contains(&hash)
                    {
                        continue;
                    }
                    let bytes = entry.metadata()?.len();
                    self.check()?;
                    fs::remove_file(entry.path())?;
                    changed = true;
                    result.removed_objects += 1;
                    result.removed_bytes += bytes;
                    #[cfg(test)]
                    self.at(CollectionPoint::ObjectRemoved);
                }
                Ok(())
            })();
            // Even an interrupted pass flushes the actual completed unlinks before releasing the gate.
            if changed {
                sync_directory(&shard.path())?;
            }
            removal?;
        }
        self.check()
    }
    fn staging(&self, result: &mut ContentCollectionReport) -> WorkResult<()> {
        let path = self.content.root.join("staging");
        let mut changed = false;
        let removal = (|| -> WorkResult<()> {
            for entry in fs::read_dir(&path)? {
                self.check()?;
                let entry = entry?;
                if entry.file_type()?.is_file()
                    && uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok()
                {
                    self.check()?;
                    fs::remove_file(entry.path())?;
                    changed = true;
                    result.removed_staging_files += 1;
                }
            }
            self.check()
        })();
        if changed {
            sync_directory(&path)?;
        }
        removal
    }
}
