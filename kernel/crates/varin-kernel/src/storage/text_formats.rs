//! Text interpretation is evidence attached to an original committed file operation.
//! The index is disposable. Original receipts and one small current format fact
//! per root/path live in the same Storage catalog; neither retains file bodies.
//! A live override never crosses a grant, Run, root, path or raw-content identity.
use super::*;
use crate::text::Format;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    workspace: String,
    execution_workspace: String,
    grant: String,
    run: Option<String>,
    epoch: String,
    host: String,
    root: String,
    canonical_root: PathBuf,
}
impl Source {
    fn new(grant: &Grant, root: &FileRoot) -> Self {
        Self {
            workspace: root.owning_workspace_id.clone(),
            execution_workspace: root.execution_workspace_id.clone(),
            grant: grant.grant_id.clone(),
            run: grant.run_id.clone(),
            epoch: grant.kernel_epoch.clone(),
            host: grant.host_id.clone(),
            root: root.root_id.clone(),
            canonical_root: root.canonical_root.clone(),
        }
    }
}

/// Immutable admission snapshot. Workers compare their actual raw hash before
/// consulting the format; an explicit per-read codec still takes precedence.
#[derive(Clone, Default)]
pub(crate) struct Snapshot(Arc<BTreeMap<String, (String, Format)>>);
impl Snapshot {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// This only disables an early NUL/binary filter. Actual interpretation still
    /// requires the complete raw-content hash through `format`.
    pub(crate) fn may_be_utf16(&self, path: &str) -> bool {
        self.0
            .get(path)
            .is_some_and(|(_, format)| matches!(format.encoding.as_str(), "utf-16le" | "utf-16be"))
    }
    pub(crate) fn format(&self, path: &str, raw_hash: &str) -> Option<&Format> {
        self.0
            .get(path)
            .filter(|(hash, _)| hash == raw_hash)
            .map(|(_, format)| format)
    }
}

/// Candidate-time metadata passed to the publication worker. Attaching formats
/// to the large result document happens beside body/diff work, never at COMMIT.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct WorkingSnapshot(BTreeMap<String, WorkingPath>);
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkingPath {
    base: Option<(String, Format)>,
    child: Option<(String, Format)>,
    #[serde(default)]
    choice_revision: Option<u64>,
}
impl WorkingSnapshot {
    pub(super) fn apply_choice_revisions(
        &self,
        snapshot: &mut BranchSnapshot,
        document: &Value,
    ) -> Result<(), KernelError> {
        for (path, selected) in &self.0 {
            if let (Some(revision), Some((_, format)), Some(actual)) = (
                selected.choice_revision,
                selected.child.as_ref(),
                document["textFormats"][path].get("child"),
            ) {
                if serde_json::to_value(format)? == *actual {
                    let policy = snapshot.policy.get_or_insert_with(|| json!({}));
                    if !policy["choiceRevisions"].is_object() {
                        policy["choiceRevisions"] = json!({});
                    }
                    policy["choiceRevisions"][path] = json!(revision);
                }
            }
        }
        Ok(())
    }
    pub(super) fn attach(
        &self,
        document: &mut Value,
        mut raw_hash: impl FnMut(&str, &str) -> Result<Option<String>, KernelError>,
    ) -> Result<(), KernelError> {
        let mut formats = document["textFormats"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (path, selected) in &self.0 {
            let mut pair = formats
                .get(path)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (key, state, format) in [
                ("base", "baseStates", &selected.base),
                ("child", "pathStates", &selected.child),
            ] {
                if let Some((hash, format)) = format {
                    let selected = match document[state][path]["objectHash"].as_str() {
                        Some(hash) if !super::file_content::is_range(hash) => Some(hash.to_owned()),
                        _ => raw_hash(if key == "base" { "baseRoot" } else { "root" }, path)?,
                    };
                    if selected.as_deref() == Some(hash.as_str()) {
                        pair.insert(key.into(), serde_json::to_value(format)?);
                    }
                }
            }
            if !pair.is_empty() {
                formats.insert(path.clone(), Value::Object(pair));
            }
        }
        if !formats.is_empty() {
            document["textFormats"] = Value::Object(formats);
        }
        Ok(())
    }
}

/// Public interpretation metadata owned by an immutable branch revision, not by
/// a private result document. No body/blob references are retained here.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BranchSnapshot {
    root: String,
    policy: Option<Value>,
    formats: BTreeMap<String, (String, Format)>,
}
impl BranchSnapshot {
    pub(super) fn inherit(
        &self,
        document: &mut Value,
        side: &str,
        mut state: impl FnMut(&str) -> Result<Option<String>, KernelError>,
    ) -> Result<(), KernelError> {
        for (path, (hash, format)) in &self.formats {
            if state(path)?.as_deref() == Some(hash) {
                if !document["textFormats"].is_object() {
                    document["textFormats"] = json!({});
                }
                if !document["textFormats"][path].is_object() {
                    document["textFormats"][path] = json!({});
                }
                document["textFormats"][path][side] = serde_json::to_value(format)?;
            }
        }
        Ok(())
    }
    pub(super) fn published(
        &self,
        root: &str,
        document: &Value,
        mut state: impl FnMut(&str) -> Result<Option<String>, KernelError>,
    ) -> Result<Self, KernelError> {
        let mut result = Self {
            root: root.into(),
            policy: self.policy.clone(),
            formats: BTreeMap::new(),
        };
        if let Some(paths) = document["textFormats"].as_object() {
            for (path, pair) in paths {
                if let (Some(format), Some(hash)) = (pair.get("child"), state(path)?) {
                    let format: Format = serde_json::from_value(format.clone())?;
                    result.policy.get_or_insert_with(|| json!({}));
                    let policy = result.policy.as_mut().unwrap();
                    if !policy["files"].is_object() {
                        policy["files"] = json!({});
                    }
                    policy["files"][path] = json!(format.encoding);
                    result.formats.insert(path.clone(), (hash, format));
                }
            }
        }
        Ok(result)
    }
}
/// Captured under the same native session boundary as namespace and dirty ranges.
#[derive(Clone)]
pub(super) struct CheckpointText {
    baseline: BranchSnapshot,
    original: BranchSnapshot,
    working: WorkingSnapshot,
    sequence: u64,
    receipts: Snapshot,
    receipt_revisions: BTreeMap<String, u64>,
    policy_is_relative: bool,
    pub(super) requested_policy: Option<Value>,
}
impl CheckpointText {
    pub(super) fn set_policy(&mut self, policy: crate::text::Policy) -> Result<(), KernelError> {
        let policy = Storage::normalize_text_policy(&serde_json::to_value(policy)?)?;
        if self.baseline.policy.is_none() {
            self.baseline.policy = Some(policy.clone());
            self.policy_is_relative = true;
        }
        self.requested_policy = Some(policy);
        Ok(())
    }
    pub(super) fn freeze_candidate(&self, candidate: &mut Value) -> Result<(), KernelError> {
        candidate["__textBaseline"] = serde_json::to_value(&self.original)?;
        candidate["__textPrevious"] = serde_json::to_value(&self.baseline)?;
        candidate["__textFormats"] = serde_json::to_value(&self.working)?;
        candidate["__textReceiptSequence"] = json!(self.sequence);
        Ok(())
    }
    pub(super) fn prepare(
        &self,
        storage: &Path,
        original: &str,
        installed: &[(Vec<String>, u32, super::workspace_files::InstalledFile)],
        selected: &str,
        cancel: &AtomicBool,
    ) -> Result<BranchSnapshot, KernelError> {
        let connection = Connection::open_with_flags(
            storage.join("catalog.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let reader = super::workspace_metadata::Reader {
            connection: &connection,
            cancel,
        };
        let mut overrides = BTreeMap::new();
        for (paths, mode, file) in installed {
            for path in paths {
                overrides.insert(path.clone(), file.state(*mode));
            }
        }
        let state = |path: &str| -> Result<PathState, KernelError> {
            overrides
                .get(path)
                .cloned()
                .map(Ok)
                .unwrap_or_else(|| reader.state(original, path))
        };
        let relative = |path: &str| -> Option<String> {
            if selected.is_empty() {
                Some(path.into())
            } else {
                path.strip_prefix(selected)
                    .and_then(|tail| tail.strip_prefix('/'))
                    .map(str::to_owned)
            }
        };
        let raw_hash = |object: &str, length: u64| -> Result<String, KernelError> {
            if !super::file_content::is_range(object) {
                return Ok(object.into());
            }
            let mut file = super::file_content::Reader::open(
                storage,
                object,
                length,
                Arc::new(AtomicBool::new(false)),
            )?;
            let mut hash = Sha256::new();
            let mut buffer = [0u8; 128 * 1024];
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            Ok(format!("sha256-{}", hex::encode(hash.finalize())))
        };
        let mut formats = BTreeMap::new();
        let mut verified_receipts = BTreeMap::new();
        for (path, (hash, format)) in &self.baseline.formats {
            let Some(relative) = relative(path) else {
                continue;
            };
            let PathState::RegularFile {
                object_hash,
                byte_length,
                ..
            } = state(path)?
            else {
                continue;
            };
            let matches = if object_hash == *hash {
                true
            } else {
                match reader.state(&self.baseline.root, path)? {
                    PathState::RegularFile {
                        object_hash: old,
                        byte_length: old_length,
                        ..
                    } if old == *hash => {
                        raw_hash(&old, old_length)? == raw_hash(&object_hash, byte_length)?
                    }
                    _ => false,
                }
            };
            if matches {
                formats.insert(relative, (object_hash, format.clone()));
            }
        }
        for (path, (raw, format)) in self.receipts.0.iter() {
            let Some(relative) = relative(path) else {
                continue;
            };
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let PathState::RegularFile {
                object_hash,
                byte_length,
                ..
            } = state(path)?
            else {
                continue;
            };
            if raw_hash(&object_hash, byte_length)? == *raw {
                verified_receipts.insert(
                    relative.clone(),
                    self.receipt_revisions.get(path).copied().unwrap_or(0),
                );
                formats.insert(relative, (object_hash, format.clone()));
            }
        }
        let mut policy = self.baseline.policy.clone();
        if !selected.is_empty() && !self.policy_is_relative {
            if let Some(policy) = &mut policy {
                for field in ["files", "choiceRevisions"] {
                    if let Some(values) = policy[field].as_object() {
                        let mut mapped = serde_json::Map::new();
                        let mut ancestor: Option<(usize, Value)> = None;
                        for (path, value) in values {
                            if field == "files"
                                && (path == "./"
                                    || (path.ends_with('/')
                                        && (selected == path.trim_end_matches('/')
                                            || selected.starts_with(path))))
                            {
                                let length = if path == "./" { 0 } else { path.len() };
                                if ancestor
                                    .as_ref()
                                    .is_none_or(|(previous, _)| length > *previous)
                                {
                                    ancestor = Some((length, value.clone()));
                                }
                            } else if let Some(path) = relative(path) {
                                mapped.insert(path, value.clone());
                            }
                        }
                        if let Some((_, value)) = ancestor {
                            mapped.insert("./".into(), value);
                        }
                        policy[field] = Value::Object(mapped);
                    }
                }
                if let Some(root) = policy["root"].as_str() {
                    policy["root"] = json!(format!("{}/{selected}", root.trim_end_matches('/')));
                }
            }
        }
        // Only a newer explicit choice for this captured source/path replaces
        // its baseline. Project defaults and other files remain frozen.
        if !self.policy_is_relative {
            if let (Some(policy), Some(requested)) = (&mut policy, &self.requested_policy) {
                if let Some(revisions) = requested["choiceRevisions"].as_object() {
                    for (path, value) in revisions {
                        let Some(revision) = value.as_u64() else {
                            continue;
                        };
                        if revision > policy["choiceRevisions"][path].as_u64().unwrap_or(0) {
                            if !policy["files"].is_object() {
                                policy["files"] = json!({});
                            }
                            if !policy["choiceRevisions"].is_object() {
                                policy["choiceRevisions"] = json!({});
                            }
                            if let Some(encoding) = requested["files"].get(path) {
                                policy["files"][path] = encoding.clone();
                            } else {
                                policy["files"].as_object_mut().unwrap().remove(path);
                            }
                            policy["choiceRevisions"][path] = json!(revision);
                            if verified_receipts.get(path) != Some(&revision) {
                                formats.remove(path);
                            }
                        }
                    }
                }
            }
        }
        // An uncaptured native source also carries current manual/reset versions
        // in its selected policy. Older same-byte receipts cannot reverse them.
        if let Some(policy) = &policy {
            formats.retain(|path, _| {
                verified_receipts.get(path).is_none_or(|revision| {
                    policy["choiceRevisions"][path].as_u64().unwrap_or(0) <= *revision
                })
            });
        }
        if !formats.is_empty() {
            let policy = policy.get_or_insert_with(|| json!({}));
            if !policy["files"].is_object() {
                policy["files"] = json!({});
            }
            for (path, (_, format)) in &formats {
                policy["files"][path] = json!(format.encoding);
                if let Some(revision) = verified_receipts.get(path) {
                    if !policy["choiceRevisions"].is_object() {
                        policy["choiceRevisions"] = json!({});
                    }
                    policy["choiceRevisions"][path] = json!(revision);
                }
            }
        }
        Ok(BranchSnapshot {
            root: String::new(),
            policy,
            formats,
        })
    }
}

/// The binding is already native-scope relative; only the child selection is
/// projected here. Related-source handoffs must use that source's own capture.
pub(crate) fn scope_text_policy(
    policy: &crate::text::Policy,
    selected: &str,
) -> Result<crate::text::Policy, KernelError> {
    let mut policy = policy.clone();
    if selected.is_empty() {
        return Ok(policy);
    }
    let relative = |path: &str| {
        path.strip_prefix(selected)
            .and_then(|tail| tail.strip_prefix('/'))
            .map(str::to_owned)
    };
    if let Some(files) = policy.files.take() {
        let mut mapped = BTreeMap::new();
        let mut ancestor: Option<(usize, String)> = None;
        for (path, encoding) in files {
            if path == "./"
                || (path.ends_with('/')
                    && (selected == path.trim_end_matches('/') || selected.starts_with(&path)))
            {
                let len = if path == "./" { 0 } else { path.len() };
                if ancestor.as_ref().is_none_or(|(old, _)| len > *old) {
                    ancestor = Some((len, encoding));
                }
            } else if let Some(path) = relative(&path) {
                mapped.insert(path, encoding);
            }
        }
        if let Some((_, encoding)) = ancestor {
            mapped.insert("./".into(), encoding);
        }
        policy.files = Some(mapped);
    }
    if let Some(revisions) = policy.choice_revisions.take() {
        policy.choice_revisions = Some(
            revisions
                .into_iter()
                .filter_map(|(path, revision)| Some((relative(&path)?, revision)))
                .collect(),
        );
    }
    if let Some(root) = &mut policy.root {
        *root = format!("{}/{selected}", root.trim_end_matches('/'));
    }
    Ok(policy)
}

fn branch_text_prefix(branch: &str) -> String {
    format!(
        "branch-text-format-v1:{}:",
        hex::encode(Sha256::digest(branch.as_bytes()))
    )
}
fn branch_text_key(branch: &str, revision: i64) -> String {
    format!("{}{revision}", branch_text_prefix(branch))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    source: Source,
    path: String,
    /// Assigned at the sole owner's commit boundary, never inferred from clocks.
    sequence: u64,
    source_hash: Option<String>,
    target_hash: String,
    before: Option<Format>,
    after: Format,
    branch: Option<String>,
    base_root: Option<String>,
    branch_path: String,
    first_branch_source: bool,
    checkpoint: Option<String>,
    first_checkpoint_source: bool,
    policy_root: Option<String>,
    source_mode: Option<String>,
    conversion: Option<Conversion>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Conversion {
    operation_id: String,
    source_encoding: String,
    target_encoding: String,
    choice_revision: u64,
}

const CURRENT_PREFIX: &str = "file-text-format-v1:";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CurrentFact {
    operation_id: String,
    evidence: Evidence,
}
fn current_key(evidence: &Evidence) -> Result<String, KernelError> {
    Ok(format!(
        "{CURRENT_PREFIX}{}",
        hash_json(&json!([root_key(&evidence.source), evidence.path]))?
    ))
}

type BranchKey = (String, String, String);
#[derive(Clone, Eq, Hash, PartialEq)]
struct BranchSource {
    workspace: String,
    execution_workspace: String,
    grant: String,
    run: Option<String>,
    epoch: String,
    host: String,
    branch: String,
}
impl BranchSource {
    fn new(source: &Source, branch: &str) -> Self {
        Self {
            workspace: source.workspace.clone(),
            execution_workspace: source.execution_workspace.clone(),
            grant: source.grant.clone(),
            run: source.run.clone(),
            epoch: source.epoch.clone(),
            host: source.host.clone(),
            branch: branch.into(),
        }
    }
}
type RecoveryKey = (String, String, String);
type ReceiptHistory = BTreeMap<u64, String>;
type RootKey = (String, String, String, String);
fn root_key(source: &Source) -> RootKey {
    (
        source.workspace.clone(),
        source.execution_workspace.clone(),
        source.host.clone(),
        source.root.clone(),
    )
}
#[derive(Default)]
struct BranchPath {
    first: Option<String>,
    operations: Vec<String>,
}
#[derive(Default)]
struct BranchFormats {
    paths: BTreeMap<String, ReceiptHistory>,
    snapshot: Snapshot,
}
#[derive(Default)]
pub(super) struct Projection {
    sequence: u64,
    receipts: HashMap<String, Evidence>,
    operation_keys: HashMap<String, ReceiptHistory>,
    retained_receipts: std::collections::HashSet<String>,
    sources: HashMap<Source, Snapshot>,
    branch_sources: HashMap<BranchSource, BranchFormats>,
    source_operations: HashMap<Source, BTreeMap<String, String>>,
    root_operations: HashMap<RootKey, BTreeMap<String, ReceiptHistory>>,
    current_facts: HashMap<String, CurrentFact>,
    current_roots: HashMap<RootKey, BTreeMap<String, String>>,
    branches: HashMap<BranchKey, BTreeMap<String, BranchPath>>,
    recoveries: HashMap<RecoveryKey, String>,
    fixed: std::cell::RefCell<HashMap<(String, i64), BranchSnapshot>>,
}
impl Projection {
    fn insert(&mut self, operation: &str, evidence: Evidence, retained: bool) {
        // Released operation IDs can be reused. Only the same commit is a
        // replay; metadata references include its original commit sequence.
        let key = format!("{}:{operation}", evidence.sequence);
        if retained {
            self.retained_receipts.insert(key.clone());
        }
        if self.receipts.contains_key(&key) {
            return;
        }
        self.sequence = self.sequence.max(evidence.sequence);
        // A more recent write to this physical/logical root invalidates an
        // older grant's interpretation even when ASCII bytes have the same hash.
        if let Some((prior_key, prior)) = self
            .root_operations
            .get(&root_key(&evidence.source))
            .and_then(|paths| paths.get(&evidence.path))
            .and_then(|history| history.last_key_value())
            .and_then(|(_, id)| {
                self.receipts
                    .get(id)
                    .map(|prior| (id.clone(), prior.clone()))
            })
        {
            self.deactivate_source(&prior, &prior_key);
        }
        self.root_operations
            .entry(root_key(&evidence.source))
            .or_default()
            .entry(evidence.path.clone())
            .or_default()
            .insert(evidence.sequence, key.clone());
        self.activate_source(&evidence, &key);
        if let (Some(branch), Some(base_root)) = (&evidence.branch, &evidence.base_root) {
            let formats = self
                .branch_sources
                .entry(BranchSource::new(&evidence.source, branch))
                .or_default();
            formats
                .paths
                .entry(evidence.branch_path.clone())
                .or_default()
                .insert(evidence.sequence, key.clone());
            Arc::make_mut(&mut formats.snapshot.0).insert(
                evidence.branch_path.clone(),
                (evidence.target_hash.clone(), evidence.after.clone()),
            );
            let path = self
                .branches
                .entry((
                    evidence.source.workspace.clone(),
                    branch.clone(),
                    base_root.clone(),
                ))
                .or_default()
                .entry(evidence.branch_path.clone())
                .or_default();
            if evidence.first_branch_source && path.first.is_none() {
                path.first = Some(key.clone());
            }
            path.operations.push(key.clone());
        }
        if evidence.first_checkpoint_source {
            if let Some(checkpoint) = &evidence.checkpoint {
                self.recoveries
                    .entry((
                        evidence.source.workspace.clone(),
                        checkpoint.clone(),
                        evidence.path.clone(),
                    ))
                    .or_insert_with(|| key.clone());
            }
        }
        self.operation_keys
            .entry(operation.into())
            .or_default()
            .insert(evidence.sequence, key.clone());
        self.receipts.insert(key, evidence);
    }
    fn activate_source(&mut self, evidence: &Evidence, key: &str) {
        self.source_operations
            .entry(evidence.source.clone())
            .or_default()
            .insert(evidence.path.clone(), key.into());
        Arc::make_mut(&mut self.sources.entry(evidence.source.clone()).or_default().0).insert(
            evidence.path.clone(),
            (evidence.target_hash.clone(), evidence.after.clone()),
        );
    }
    fn deactivate_source(&mut self, evidence: &Evidence, key: &str) {
        let Some(paths) = self.source_operations.get_mut(&evidence.source) else {
            return;
        };
        if paths.get(&evidence.path).map(String::as_str) != Some(key) {
            return;
        }
        paths.remove(&evidence.path);
        if paths.is_empty() {
            self.source_operations.remove(&evidence.source);
        }
        if let Some(snapshot) = self.sources.get_mut(&evidence.source) {
            Arc::make_mut(&mut snapshot.0).remove(&evidence.path);
            if snapshot.0.is_empty() {
                self.sources.remove(&evidence.source);
            }
        }
    }

    /// Remove only this receipt's projections. Current format facts keep their
    /// own evidence after release, until another write or source cleanup replaces it.
    fn remove_receipt(&mut self, key: &str) {
        let Some(evidence) = self.receipts.remove(key) else {
            return;
        };
        self.retained_receipts.remove(key);
        let operation = key.split_once(':').expect("commit receipt identity").1;
        if let Some(history) = self.operation_keys.get_mut(operation) {
            history.remove(&evidence.sequence);
            if history.is_empty() {
                self.operation_keys.remove(operation);
            }
        }
        self.deactivate_source(&evidence, key);
        let root = root_key(&evidence.source);
        let mut successor = None;
        if let Some(paths) = self.root_operations.get_mut(&root) {
            if let Some(history) = paths.get_mut(&evidence.path) {
                let latest = history
                    .last_key_value()
                    .is_some_and(|(_, value)| value == key);
                history.remove(&evidence.sequence);
                if latest {
                    successor = history.last_key_value().map(|(_, id)| id.clone());
                }
                if history.is_empty() {
                    paths.remove(&evidence.path);
                }
            }
            if paths.is_empty() {
                self.root_operations.remove(&root);
            }
        }
        if let Some(successor) =
            successor.and_then(|id| self.receipts.get(&id).cloned().map(|value| (id, value)))
        {
            self.activate_source(&successor.1, &successor.0);
        }
        if let (Some(branch), Some(base_root)) = (&evidence.branch, &evidence.base_root) {
            let branch_key = (
                evidence.source.workspace.clone(),
                branch.clone(),
                base_root.clone(),
            );
            let scope = BranchSource::new(&evidence.source, branch);
            if let Some(paths) = self.branches.get_mut(&branch_key) {
                if let Some(history) = paths.get_mut(&evidence.branch_path) {
                    history.operations.retain(|id| id != key);
                    if history.first.as_deref() == Some(key) {
                        history.first = None;
                    }
                    if history.operations.is_empty() {
                        paths.remove(&evidence.branch_path);
                    }
                }
                if paths.is_empty() {
                    self.branches.remove(&branch_key);
                }
            }
            if let Some(formats) = self.branch_sources.get_mut(&scope) {
                if let Some(history) = formats.paths.get_mut(&evidence.branch_path) {
                    let latest = history.last_key_value().is_some_and(|(_, id)| id == key);
                    history.remove(&evidence.sequence);
                    if latest {
                        let snapshot = Arc::make_mut(&mut formats.snapshot.0);
                        if let Some(receipt) = history
                            .last_key_value()
                            .and_then(|(_, id)| self.receipts.get(id))
                        {
                            snapshot.insert(
                                evidence.branch_path.clone(),
                                (receipt.target_hash.clone(), receipt.after.clone()),
                            );
                        } else {
                            snapshot.remove(&evidence.branch_path);
                        }
                    }
                    if history.is_empty() {
                        formats.paths.remove(&evidence.branch_path);
                    }
                }
                if formats.paths.is_empty() {
                    self.branch_sources.remove(&scope);
                }
            }
        }
        if let Some(checkpoint) = evidence.checkpoint {
            let recovery = (evidence.source.workspace, checkpoint, evidence.path);
            if self.recoveries.get(&recovery).map(String::as_str) == Some(key) {
                self.recoveries.remove(&recovery);
            }
        }
    }
    fn retain_current_fact(&mut self, operation: &str, evidence: Evidence) {
        let sequence = evidence.sequence;
        let key = current_key(&evidence).expect("validated text format identity");
        self.current_roots
            .entry(root_key(&evidence.source))
            .or_default()
            .insert(evidence.path.clone(), key.clone());
        let prior = self.current_facts.insert(
            key,
            CurrentFact {
                operation_id: operation.into(),
                evidence,
            },
        );
        if let Some(prior) = prior.filter(|prior| prior.evidence.sequence != sequence) {
            let prior_key = format!("{}:{}", prior.evidence.sequence, prior.operation_id);
            if !self.retained_receipts.contains(&prior_key) {
                self.remove_receipt(&prior_key);
            }
        }
    }
    pub(super) fn release(&mut self, operation: &str) {
        let Some(key) = self
            .operation_keys
            .get(operation)
            .and_then(|history| history.last_key_value())
            .map(|(_, key)| key.clone())
        else {
            return;
        };
        self.retained_receipts.remove(&key);
        let current = self
            .receipts
            .get(&key)
            .and_then(|evidence| current_key(evidence).ok())
            .and_then(|current| self.current_facts.get(&current))
            .is_some_and(|fact| format!("{}:{}", fact.evidence.sequence, fact.operation_id) == key);
        if !current {
            self.remove_receipt(&key);
        }
    }
}

impl Storage {
    pub(crate) fn text_format_receipts(
        &self,
        grant: &Grant,
        root_id: &str,
    ) -> Result<Snapshot, KernelError> {
        let root = self.admitted_file_root(root_id, grant)?;
        Ok(self
            .text_formats
            .sources
            .get(&Source::new(grant, &root))
            .cloned()
            .unwrap_or_default())
    }

    pub(crate) fn text_format_receipts_for_branch(&self, grant: &Grant, branch: &str) -> Snapshot {
        let Some(workspace) = &grant.owning_workspace else {
            return Snapshot::default();
        };
        let key = BranchSource {
            workspace: workspace.clone(),
            execution_workspace: grant
                .execution_workspace
                .clone()
                .unwrap_or_else(|| workspace.clone()),
            grant: grant.grant_id.clone(),
            run: grant.run_id.clone(),
            epoch: grant.kernel_epoch.clone(),
            host: grant.host_id.clone(),
            branch: branch.into(),
        };
        self.text_formats
            .branch_sources
            .get(&key)
            .map(|formats| formats.snapshot.clone())
            .unwrap_or_default()
    }

    /// A new Run may consume the interpretation frozen with this exact
    /// published result, never a materialized copy's later receipt. Raw ranges
    /// remain exact object references; they are not aliases of content digests.
    pub(crate) fn text_format_receipts_for_fixed(
        &self,
        grant: &Grant,
        branch: &str,
        revision: i64,
        root: &str,
    ) -> Result<Snapshot, KernelError> {
        let workspace: Option<String> = self
            .conn
            .query_row(
                "SELECT workspace_id FROM branches WHERE branch_id=?1",
                [branch],
                |row| row.get(0),
            )
            .optional()?;
        let Some(workspace) = workspace else {
            return Ok(Snapshot::default());
        };
        if grant.owning_workspace.as_deref() != Some(workspace.as_str())
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "Fixed text interpretation belongs to another workspace".into(),
            ));
        }
        let actual: Option<String> = self
            .conn
            .query_row(
                "SELECT root_hash FROM revisions WHERE branch_id=?1 AND revision=?2",
                params![branch, revision],
                |row| row.get(0),
            )
            .optional()?;
        if actual.as_deref() != Some(root) {
            return Ok(Snapshot::default());
        }
        let selected = self.branch_text_snapshot(branch, revision, root)?;
        Ok(Snapshot(Arc::new(selected.formats)))
    }

    pub(super) fn checkpoint_text_snapshot(
        &self,
        grant: &Grant,
        branch: &str,
        head: &BranchRow,
    ) -> Result<CheckpointText, KernelError> {
        let root: String = self.conn.query_row(
            "SELECT root_hash FROM revisions WHERE branch_id=?1 AND revision=?2",
            params![branch, head.head_revision],
            |row| row.get(0),
        )?;
        let sequence = self.text_receipt_sequence();
        let working = self.working_text_snapshot(
            &head.workspace_id,
            branch,
            &head.base_root,
            Some(sequence),
            grant,
        );
        let mut receipts = BTreeMap::new();
        let mut receipt_revisions = BTreeMap::new();
        if let Some(paths) = self.text_formats.branches.get(&(
            head.workspace_id.clone(),
            branch.into(),
            head.base_root.clone(),
        )) {
            for (path, history) in paths {
                if let Some(receipt) = history
                    .operations
                    .iter()
                    .rev()
                    .filter_map(|key| self.text_formats.receipts.get(key))
                    .find(|receipt| {
                        receipt.sequence <= sequence
                            && receipt.source_mode.as_deref() == Some("native_workspace")
                    })
                {
                    receipts.insert(
                        path.clone(),
                        (receipt.target_hash.clone(), receipt.after.clone()),
                    );
                    receipt_revisions.insert(
                        path.clone(),
                        receipt
                            .conversion
                            .as_ref()
                            .map(|choice| choice.choice_revision)
                            .unwrap_or(0),
                    );
                }
            }
        }
        Ok(CheckpointText {
            baseline: self.branch_text_snapshot(branch, head.head_revision, &root)?,
            original: self.branch_text_snapshot(branch, 0, &head.base_root)?,
            working,
            sequence,
            receipts: Snapshot(Arc::new(receipts)),
            receipt_revisions,
            policy_is_relative: false,
            requested_policy: None,
        })
    }
    pub(super) fn commit_checkpoint_text_snapshot(
        &self,
        branch: &str,
        root: &str,
        snapshot: &BranchSnapshot,
    ) -> Result<(), KernelError> {
        let mut snapshot = snapshot.clone();
        snapshot.root = root.into();
        self.persist_branch_text_snapshot(branch, 0, &snapshot)
    }
    pub(super) fn normalize_text_policy(value: &Value) -> Result<Value, KernelError> {
        let policy: crate::text::Policy = serde_json::from_value(value.clone())?;
        let mut value = serde_json::to_value(policy)?;
        value
            .as_object_mut()
            .expect("policy object")
            .retain(|_, value| !value.is_null());
        Ok(value)
    }
    pub(super) fn branch_text_snapshot(
        &self,
        branch: &str,
        revision: i64,
        root: &str,
    ) -> Result<BranchSnapshot, KernelError> {
        let key = (branch.to_owned(), revision);
        if let Some(snapshot) = self.text_formats.fixed.borrow().get(&key) {
            return Ok(if snapshot.root == root {
                snapshot.clone()
            } else {
                BranchSnapshot::default()
            });
        }
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM metadata WHERE key=?1",
                [branch_text_key(branch, revision)],
                |row| row.get(0),
            )
            .optional()?;
        let snapshot: BranchSnapshot = value
            .map(|value| serde_json::from_str(&value))
            .transpose()?
            .unwrap_or_default();
        if snapshot.root != root {
            return Ok(BranchSnapshot::default());
        }
        self.text_formats
            .fixed
            .borrow_mut()
            .insert(key, snapshot.clone());
        Ok(snapshot)
    }
    pub(super) fn persist_branch_text_snapshot(
        &self,
        branch: &str,
        revision: i64,
        snapshot: &BranchSnapshot,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO metadata(key,value) VALUES(?1,?2)",
            params![
                branch_text_key(branch, revision),
                serde_json::to_string(snapshot)?
            ],
        )?;
        // Clearing is safe even if the containing transaction rolls back.
        self.text_formats
            .fixed
            .borrow_mut()
            .remove(&(branch.into(), revision));
        Ok(())
    }
    pub(super) fn release_branch_text_snapshots(&self, branch: &str) -> Result<(), KernelError> {
        let prefix = branch_text_prefix(branch);
        self.conn.execute(
            "DELETE FROM metadata WHERE key>=?1 AND key<?2",
            params![prefix, format!("{prefix}~")],
        )?;
        self.clear_fixed_text_snapshots();
        Ok(())
    }
    pub(super) fn branch_text_policy(
        &self,
        branch: &str,
        revision: i64,
        root: &str,
        scopes: Option<&[String]>,
    ) -> Result<Option<Value>, KernelError> {
        let mut policy = self.branch_text_snapshot(branch, revision, root)?.policy;
        if let (Some(policy), Some(scopes)) = (&mut policy, scopes) {
            for field in ["files", "choiceRevisions"] {
                if let Some(files) = policy.get_mut(field).and_then(Value::as_object_mut) {
                    files.retain(|path, _| {
                        if path == "./" {
                            return true;
                        }
                        let directory = path.ends_with('/');
                        let path = path.trim_end_matches('/');
                        crate::authority::path_allowed_scopes(scopes, path)
                            || (directory
                                && crate::authority::path_metadata_allowed_scopes(scopes, path))
                    });
                }
            }
        }
        Ok(policy)
    }
    /// Called only after the original branch source/root and content ownership
    /// have been admitted. A naked root hash never selects another branch's policy.
    pub(super) fn capture_branch_text_snapshot(
        &self,
        branch: &str,
        root: &str,
        source: Option<&str>,
        explicit: Option<&Value>,
    ) -> Result<(), KernelError> {
        let mut snapshot = if let Some(reference) = source {
            let selected: Option<(String, i64, String)> =
                if let Some(pin) = reference.strip_prefix("pin:") {
                    self.conn
                        .query_row(
                            "SELECT branch_id,revision,root_hash FROM pins WHERE pin_id=?1",
                            [pin],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .optional()?
                } else if let Some((branch, revision)) = reference.rsplit_once('@') {
                    let revision = revision.parse::<i64>().map_err(|_| {
                        KernelError::Operation("Invalid text source revision".into())
                    })?;
                    let selected = self
                        .conn
                        .query_row(
                            "SELECT root_hash FROM revisions WHERE branch_id=?1 AND revision=?2",
                            params![branch, revision],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?;
                    selected.map(|root| (branch.into(), revision, root))
                } else {
                    None
                };
            match selected {
                Some((branch, revision, root)) => {
                    self.branch_text_snapshot(&branch, revision, &root)?
                }
                None => BranchSnapshot::default(),
            }
        } else {
            BranchSnapshot::default()
        };
        let mut retained = BTreeMap::new();
        for (path, (hash, format)) in snapshot.formats {
            if self
                .root_get(root, &path)?
                .and_then(|state| state.object_hash().map(str::to_owned))
                .as_deref()
                == Some(&hash)
            {
                retained.insert(path, (hash, format));
            }
        }
        snapshot.formats = retained;
        if let Some(policy) = explicit {
            snapshot.policy = Some(Self::normalize_text_policy(policy)?);
        }
        snapshot.root = root.into();
        if snapshot.policy.is_some() || !snapshot.formats.is_empty() {
            self.persist_branch_text_snapshot(branch, 0, &snapshot)?;
        }
        Ok(())
    }

    /// Metadata candidates only. Callers must independently read the current raw
    /// version and compare rawHash before changing a project preference.
    pub(super) fn file_text_conversions(
        &self,
        params: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        require_capability(grant, "file.text.conversions")?;
        let root_id = params["rootId"]
            .as_str()
            .ok_or_else(|| KernelError::Operation("rootId is required".into()))?;
        let root = self.admitted_file_root(root_id, grant)?;
        if params["workspaceId"].as_str() != Some(root.owning_workspace_id.as_str()) {
            return Err(KernelError::Authorization(
                "Text conversion query workspace differs from its root".into(),
            ));
        }
        let source = Source::new(grant, &root);
        let Some(paths) = self.text_formats.current_roots.get(&root_key(&source)) else {
            return Ok(json!({"conversions":[],"nextCursor":null}));
        };
        let cursor = params["cursor"].as_str().unwrap_or("");
        let size = params["pageSize"].as_u64().unwrap_or(128).clamp(1, 512) as usize;
        let mut conversions = Vec::new();
        let mut next_cursor = None;
        let mut last_path = None;
        let mut examined = 0;
        let requested = params["path"]
            .as_str()
            .map(|path| {
                super::file_resources::normalized_relative_path(path, false).map(|(path, _)| path)
            })
            .transpose()?;
        let selected: Box<dyn Iterator<Item = (&String, &String)> + '_> = match &requested {
            Some(path) => Box::new(paths.get_key_value(path).into_iter()),
            None => Box::new(paths.range((
                std::ops::Bound::Excluded(cursor.to_owned()),
                std::ops::Bound::Unbounded,
            ))),
        };
        for (path, operation) in selected {
            if examined == size {
                next_cursor = last_path;
                break;
            }
            examined += 1;
            last_path = Some(path.clone());
            if !path_allowed(grant, path)
                || super::file_resources::normalized_relative_path(path, false).is_err()
            {
                continue;
            }
            let fact = &self.text_formats.current_facts[operation];
            let operation = &fact.operation_id;
            let receipt = &fact.evidence;
            let Some(conversion) = &receipt.conversion else {
                continue;
            };
            // Logical native roots retain branch/scope identity across mount
            // generations; physical roots must retain the canonical directory.
            let same_root = if let Some((branch, _, _)) = self.native_file_roots.get(root_id) {
                receipt.branch.as_deref() == Some(branch.as_str())
            } else {
                receipt.source.canonical_root == root.canonical_root
            };
            if !same_root {
                continue;
            }
            conversions.push(json!({"operationId":operation,"conversionOperationId":conversion.operation_id,
                "path":path,"rawHash":receipt.target_hash,"sourceEncoding":conversion.source_encoding,"targetEncoding":conversion.target_encoding,
                "choiceRevision":conversion.choice_revision,"runId":receipt.source.run,"policyRoot":receipt.policy_root,
                "canonicalRoot":root.canonical_root,"originalCanonicalRoot":receipt.source.canonical_root,"sourceMode":receipt.source_mode}));
        }
        Ok(json!({"conversions":conversions,"nextCursor":next_cursor}))
    }

    pub(super) fn clear_fixed_text_snapshots(&self) {
        self.text_formats.fixed.borrow_mut().clear();
    }

    pub(super) fn text_format_keys_for_branch(&self, branch: &str) -> Vec<String> {
        self.text_formats
            .current_facts
            .iter()
            .filter(|(_, fact)| fact.evidence.branch.as_deref() == Some(branch))
            .map(|(key, _)| key.clone())
            .collect()
    }
    pub(super) fn text_format_keys_for_directory(
        &self,
        workspace: &str,
        directory: &Path,
    ) -> Vec<String> {
        self.text_formats
            .current_facts
            .iter()
            .filter(|(_, fact)| {
                fact.evidence.source.workspace == workspace
                    && fact.evidence.source.canonical_root.starts_with(directory)
            })
            .map(|(key, _)| key.clone())
            .collect()
    }
    /// Called inside the original namespace/view cleanup transaction.
    pub(super) fn delete_text_format_facts(&self, keys: &[String]) -> Result<(), KernelError> {
        for key in keys {
            self.conn
                .execute("DELETE FROM metadata WHERE key=?1", [key])?;
        }
        Ok(())
    }
    /// Publish projection removal only after the original cleanup COMMIT.
    pub(super) fn forget_text_format_facts(&mut self, keys: &[String]) {
        for key in keys {
            if let Some(fact) = self.text_formats.current_facts.remove(key) {
                if let Some(paths) = self
                    .text_formats
                    .current_roots
                    .get_mut(&root_key(&fact.evidence.source))
                {
                    paths.remove(&fact.evidence.path);
                    if paths.is_empty() {
                        self.text_formats
                            .current_roots
                            .remove(&root_key(&fact.evidence.source));
                    }
                }
                let receipt = format!("{}:{}", fact.evidence.sequence, fact.operation_id);
                if !self.text_formats.retained_receipts.contains(&receipt) {
                    self.text_formats.remove_receipt(&receipt);
                }
            }
        }
    }

    pub(super) fn freeze_candidate_text_formats(
        &self,
        candidate: &mut Value,
    ) -> Result<(), KernelError> {
        let field = |name: &str| {
            candidate[name].as_str().ok_or_else(|| {
                KernelError::Storage(format!("Text format candidate omitted {name}"))
            })
        };
        let owner = self.load_grant(field("ownerGrantId")?)?;
        let selected = self.working_text_snapshot(
            field("workspaceId")?,
            field("branchId")?,
            field("baseRoot")?,
            Some(self.text_receipt_sequence()),
            &owner,
        );
        let branch = self.branch(field("branchId")?)?;
        let previous_root: String = self.conn.query_row(
            "SELECT root_hash FROM revisions WHERE branch_id=?1 AND revision=?2",
            params![field("branchId")?, branch.head_revision],
            |row| row.get(0),
        )?;
        let baseline = self.branch_text_snapshot(field("branchId")?, 0, &branch.base_root)?;
        let previous =
            self.branch_text_snapshot(field("branchId")?, branch.head_revision, &previous_root)?;
        candidate["__textBaseline"] = serde_json::to_value(baseline)?;
        candidate["__textPrevious"] = serde_json::to_value(previous)?;
        candidate["__textFormats"] = serde_json::to_value(selected)?;
        candidate["__textReceiptSequence"] = json!(self.text_receipt_sequence());
        Ok(())
    }

    pub(super) fn text_receipt_sequence(&self) -> u64 {
        self.text_formats.sequence
    }

    pub(super) fn admit_text_receipt(&self, intent: &mut Value) -> Result<(), KernelError> {
        if intent.get("__textFormat").is_none() {
            return Ok(());
        }
        let field = |name: &str| {
            intent[name]
                .as_str()
                .ok_or_else(|| KernelError::Storage(format!("Text intent omitted {name}")))
        };
        let grant = self.load_grant(field("__nativeGrantId")?)?;
        let root = self.admitted_file_root(field("rootId")?, &grant)?;
        if field("workspaceId")? != root.owning_workspace_id
            || field("__nativeEpoch")? != grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Text receipt source differs from its original grant".into(),
            ));
        }
        let source = Source::new(&grant, &root);
        let branch = intent["__textBranchId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                self.native_file_roots
                    .get(&root.root_id)
                    .map(|(branch, _, _)| branch.clone())
            });
        let base_root = branch
            .as_deref()
            .map(|branch| {
                let selected = self.branch(branch)?;
                if selected.workspace_id != source.workspace {
                    return Err(KernelError::Authorization(
                        "Text receipt branch belongs to another workspace".into(),
                    ));
                }
                Ok(selected.base_root)
            })
            .transpose()?;
        let path = field("path")?;
        let branch_path = intent["__textBranchPath"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                match self
                    .native_file_roots
                    .get(&root.root_id)
                    .map(|(_, _, scope)| scope.as_str())
                    .filter(|scope| !scope.is_empty())
                {
                    Some(scope) => format!("{scope}/{path}"),
                    None => path.to_owned(),
                }
            });
        intent["__textAdmission"] = json!({"source":source,"branch":branch,"baseRoot":base_root,"branchPath":branch_path,"policyRoot":intent["__textPolicyRoot"],"sourceMode":intent["__textSourceMode"]});
        Ok(())
    }

    pub(super) fn load_text_format_receipts(&mut self) -> Result<(), KernelError> {
        let mut statement = self.conn.prepare("SELECT o.operation_id,o.result_json FROM operations o JOIN operation_owners w ON w.operation_id=o.operation_id WHERE o.kind='file.apply' AND o.state='committed' AND json_type(o.result_json,'$.__textReceipt')='object' AND json_extract(o.result_json,'$.__textReceipt.source.workspace')=w.workspace_id")?;
        let mut receipts = Vec::new();
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (id, body) = row?;
            let value: Value = serde_json::from_str(&body)?;
            if value["status"] != "applied" {
                continue;
            }
            let evidence: Evidence = serde_json::from_value(value["__textReceipt"].clone())?;
            let state: Value =
                serde_json::from_str(value["stateJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("Text receipt has no original file state".into())
                })?)?;
            if state["objectHash"].as_str() != Some(&evidence.target_hash)
                || value["__nativeGrantId"].as_str() != Some(&evidence.source.grant)
                || value["__nativeEpoch"].as_str() != Some(&evidence.source.epoch)
                || value["__textFormat"] != serde_json::to_value(&evidence.after)?
            {
                return Err(KernelError::Storage(
                    "Text receipt differs from its original file outcome".into(),
                ));
            }
            receipts.push((id, evidence, true));
        }
        drop(statement);
        let mut statement = self
            .conn
            .prepare("SELECT key,value FROM metadata WHERE key GLOB 'file-text-format-v1:*'")?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (key, body) = row?;
            let fact: CurrentFact = serde_json::from_str(&body)?;
            if key != current_key(&fact.evidence)? {
                return Err(KernelError::Storage(
                    "Current text format identity is corrupt".into(),
                ));
            }
            receipts.push((fact.operation_id.clone(), fact.evidence.clone(), false));
            self.text_formats
                .retain_current_fact(&fact.operation_id, fact.evidence);
        }
        drop(statement);
        receipts.sort_by_key(|(_, evidence, _)| evidence.sequence);
        for (id, evidence, retained) in receipts {
            self.text_formats.insert(&id, evidence, retained);
        }
        // A retained candidate is itself evidence of a commit watermark even
        // after the corresponding file receipt was explicitly released.
        let watermark: Option<i64> = self.conn.query_row("SELECT max(json_extract(result_json,'$.__textReceiptSequence')) FROM operations WHERE kind='working.result.prepare' AND state='committed'", [], |row| row.get(0))?;
        self.text_formats.sequence = self
            .text_formats
            .sequence
            .max(watermark.and_then(|n| u64::try_from(n).ok()).unwrap_or(0));
        Ok(())
    }

    /// Prepare evidence while the original intent is available. It is committed
    /// in that operation's receipt, and installed in the index only after COMMIT.
    pub(super) fn text_receipt_evidence(
        &self,
        operation: &str,
        intent: &Value,
        result: &Value,
    ) -> Result<Option<Value>, KernelError> {
        if result["status"] != "applied" || intent.get("__textFormat").is_none() {
            return Ok(None);
        }
        let field = |name: &str| {
            intent[name]
                .as_str()
                .ok_or_else(|| KernelError::Storage(format!("Text intent omitted {name}")))
        };
        // The admission belongs to the original intent. Finishing a dispatched
        // effect does not re-admit a root that may now be closing or revoked.
        let Some(admission) = intent.get("__textAdmission") else {
            return Ok(None);
        };
        let source: Source = serde_json::from_value(admission["source"].clone())?;
        let path = field("path")?.to_owned();
        let expected: Value = serde_json::from_str(field("expectedJson")?)?;
        let state: Value = serde_json::from_str(
            result["stateJson"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Text outcome omitted file state".into()))?,
        )?;
        let Some(target_hash) = state["objectHash"].as_str() else {
            return Ok(None);
        };
        let branch = admission["branch"].as_str().map(str::to_owned);
        let base_root = admission["baseRoot"].as_str().map(str::to_owned);
        let branch_path = admission["branchPath"].as_str().unwrap_or(&path).to_owned();
        let first_branch_source = match (&branch, &base_root) {
            (Some(branch), Some(base_root)) => !self
                .text_formats
                .branches
                .get(&(source.workspace.clone(), branch.clone(), base_root.clone()))
                .and_then(|paths| paths.get(&branch_path))
                .is_some_and(|history| {
                    history
                        .operations
                        .iter()
                        .filter_map(|id| self.text_formats.receipts.get(id))
                        .any(|receipt| receipt.source == source)
                }),
            _ => false,
        };
        let checkpoint = intent["__recoveryTurn"]["checkpointId"]
            .as_str()
            .map(str::to_owned);
        let first_checkpoint_source = match &checkpoint {
            Some(checkpoint) => self.conn.query_row("SELECT mutation_id=?4 AND after_json IS NULL FROM recovery_changes WHERE workspace_id=?1 AND checkpoint_id=?2 AND path=?3", params![source.workspace, checkpoint, path, operation], |row| row.get::<_, bool>(0)).optional()?.unwrap_or(false),
            None => false,
        };
        let before: Option<Format> = intent
            .get("__textSourceFormat")
            .filter(|value| !value.is_null())
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()?;
        let after: Format = serde_json::from_value(intent["__textFormat"].clone())?;
        let source_hash = expected["objectHash"].as_str().map(str::to_owned);
        let policy_root = admission["policyRoot"].as_str().map(str::to_owned);
        let source_mode = admission["sourceMode"].as_str().map(str::to_owned);
        let conversion = if let Some(choice) = intent.get("__textConversion") {
            if choice["rawHash"].as_str() != Some(target_hash)
                || choice["targetEncoding"].as_str() != Some(after.encoding.as_str())
                || choice["sourceEncoding"].as_str()
                    != before.as_ref().map(|format| format.encoding.as_str())
            {
                return Err(KernelError::Storage(
                    "Text conversion choice differs from the committed bytes or codec".into(),
                ));
            }
            Some(Conversion {
                operation_id: operation.into(),
                source_encoding: choice["sourceEncoding"].as_str().unwrap().into(),
                target_encoding: after.encoding.clone(),
                choice_revision: choice["choiceRevision"].as_u64().unwrap_or(0),
            })
        } else {
            // A later edit may retain an explicit choice only through an exact
            // before/after raw-state chain in the same original source scope.
            self.text_formats
                .source_operations
                .get(&source)
                .and_then(|paths| paths.get(&path))
                .and_then(|id| self.text_formats.receipts.get(id))
                .filter(|prior| {
                    source_hash.as_deref() == Some(prior.target_hash.as_str())
                        && prior.after.encoding == after.encoding
                        && prior.policy_root == policy_root
                        && prior.source_mode == source_mode
                })
                .and_then(|prior| prior.conversion.clone())
        };
        Ok(Some(serde_json::to_value(Evidence {
            source,
            path,
            sequence: self
                .text_formats
                .sequence
                .checked_add(1)
                .ok_or_else(|| KernelError::Storage("Text receipt sequence overflow".into()))?,
            source_hash,
            target_hash: target_hash.into(),
            before,
            after,
            branch,
            base_root,
            branch_path,
            first_branch_source,
            checkpoint,
            first_checkpoint_source,
            policy_root,
            source_mode,
            conversion,
        })?))
    }
    pub(super) fn persist_current_text_format(
        &self,
        operation: &str,
        result: &Value,
    ) -> Result<(), KernelError> {
        if let Some(value) = result.get("__textReceipt") {
            let evidence: Evidence = serde_json::from_value(value.clone())?;
            let key = current_key(&evidence)?;
            let fact = CurrentFact {
                operation_id: operation.into(),
                evidence,
            };
            self.conn.execute("INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,serde_json::to_string(&fact)?])?;
        }
        Ok(())
    }
    pub(super) fn index_text_receipt(&mut self, operation: &str, result: &Value) {
        // Already serialized/validated before the transaction was committed.
        if let Some(value) = result.get("__textReceipt") {
            let evidence: Evidence =
                serde_json::from_value(value.clone()).expect("validated text receipt evidence");
            self.text_formats
                .retain_current_fact(operation, evidence.clone());
            self.text_formats.insert(operation, evidence, true);
        }
    }

    /// Select receipt metadata at the original candidate's watermark. Raw hash
    /// filtering and result serialization remain on the publication worker.
    pub(super) fn working_text_snapshot(
        &self,
        workspace: &str,
        branch: &str,
        base_root: &str,
        sequence: Option<u64>,
        owner: &Grant,
    ) -> WorkingSnapshot {
        let Some(sequence) = sequence else {
            return WorkingSnapshot::default();
        };
        let Some(paths) =
            self.text_formats
                .branches
                .get(&(workspace.into(), branch.into(), base_root.into()))
        else {
            return WorkingSnapshot::default();
        };
        let mut selected = BTreeMap::new();
        for (path, history) in paths {
            let belongs = |receipt: &&Evidence| {
                receipt.sequence <= sequence
                    && (receipt.source_mode.as_deref() == Some("native_workspace")
                        || (receipt.source.run == owner.run_id
                            && receipt.source.host == owner.host_id
                            && owner
                                .execution_workspace
                                .as_deref()
                                .or(owner.owning_workspace.as_deref())
                                == Some(receipt.source.execution_workspace.as_str())))
            };
            let base = history
                .operations
                .iter()
                .filter_map(|id| self.text_formats.receipts.get(id))
                .filter(belongs)
                .find(|receipt| receipt.first_branch_source)
                .and_then(|receipt| Some((receipt.source_hash.clone()?, receipt.before.clone()?)));
            let receipt = history
                .operations
                .iter()
                .rev()
                .filter_map(|id| self.text_formats.receipts.get(id))
                .find(belongs);
            let child = receipt.map(|receipt| (receipt.target_hash.clone(), receipt.after.clone()));
            let choice_revision = receipt.and_then(|receipt| {
                receipt
                    .conversion
                    .as_ref()
                    .map(|choice| choice.choice_revision)
            });
            if base.is_some() || child.is_some() {
                selected.insert(
                    path.clone(),
                    WorkingPath {
                        base,
                        child,
                        choice_revision,
                    },
                );
            }
        }
        WorkingSnapshot(selected)
    }

    /// A restore uses exact point metadata for its target and the current
    /// admitted root's hash-matched fact for its safety image. Neither is part
    /// of RecoveryState equality or a guessed hash-global interpretation.
    pub(super) fn restore_text_metadata(
        &self,
        grant: &Grant,
        root: &str,
        path: &str,
        safety: &Value,
        target: &Value,
        target_format: Option<&Value>,
        mode: varin_runtime::SourceMode,
    ) -> Result<Value, KernelError> {
        let root = self.admitted_file_root(root, grant)?;
        let source = Source::new(grant, &root);
        let current = self
            .text_formats
            .current_roots
            .get(&root_key(&source))
            .and_then(|paths| paths.get(path))
            .and_then(|key| self.text_formats.current_facts.get(key))
            .map(|fact| &fact.evidence)
            .filter(|fact| {
                (fact.source.canonical_root == root.canonical_root || root.native.is_some())
                    && safety["objectHash"].as_str() == Some(fact.target_hash.as_str())
            });
        let mut metadata = json!({"changed":false});
        if let Some(current) = current {
            metadata["safety"] = serde_json::to_value(&current.after)?;
        }
        let Some(target_format) = target_format else {
            return Ok(metadata);
        };
        let target_format: Format = serde_json::from_value(target_format.clone())?;
        let Some(hash) = target["objectHash"].as_str() else {
            return Ok(metadata);
        };
        metadata["target"] = serde_json::to_value(&target_format)?;
        metadata["changed"] = json!(current.is_none_or(|current| current.after.encoding
            != target_format.encoding
            || current.after.bom != target_format.bom
            || current.after.line_ending != target_format.line_ending
            || current.after.default_line_ending != target_format.default_line_ending));
        let mut intent = json!({"__textFormat":target_format,"__nativeGrantId":grant.grant_id,"__nativeEpoch":grant.kernel_epoch,"__textSourceMode":mode});
        if let Some(current) = current {
            intent["__textSourceFormat"] = serde_json::to_value(&current.after)?;
            if let Some(branch) = &current.branch {
                intent["__textBranchId"] = json!(branch);
            }
            if let Some(policy_root) = &current.policy_root {
                intent["__textPolicyRoot"] = json!(policy_root);
            }
            if current.after.encoding != target_format.encoding {
                intent["__textConversion"] = json!({"sourceEncoding":current.after.encoding,"targetEncoding":target_format.encoding,"rawHash":hash,"choiceRevision":current.conversion.as_ref().map(|choice|choice.choice_revision).unwrap_or(0)});
            }
        }
        metadata["intent"] = intent;
        Ok(metadata)
    }

    pub(super) fn enrich_recovery_text_formats(
        &self,
        change: &mut Value,
    ) -> Result<(), KernelError> {
        let (Some(workspace), Some(checkpoint), Some(path), Some(operation)) = (
            change["workspaceId"].as_str(),
            change["checkpointId"].as_str(),
            change["path"].as_str(),
            change["mutationId"].as_str(),
        ) else {
            return Ok(());
        };
        let before = self
            .text_formats
            .recoveries
            .get(&(workspace.into(), checkpoint.into(), path.into()))
            .and_then(|id| self.text_formats.receipts.get(id))
            .filter(|first| {
                first
                    .source_hash
                    .as_deref()
                    .is_some_and(|hash| change["before"]["objectHash"].as_str() == Some(hash))
            })
            .and_then(|first| first.before.as_ref())
            .map(serde_json::to_value)
            .transpose()?;
        let after = self
            .text_formats
            .operation_keys
            .get(operation)
            .and_then(|history| history.last_key_value().map(|(_, key)| key))
            .and_then(|key| self.text_formats.receipts.get(key))
            .filter(|last| {
                last.source.workspace == workspace
                    && last.path == path
                    && last.checkpoint.as_deref() == Some(checkpoint)
                    && change["after"]["objectHash"].as_str() == Some(&last.target_hash)
            })
            .map(|last| serde_json::to_value(&last.after))
            .transpose()?;
        if let Some(format) = before {
            change["beforeFormat"] = format;
        }
        if let Some(format) = after {
            change["afterFormat"] = format;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::file_mutations::{FileWriteArgs, TextMutation, read_version};
    use varin_runtime::catalog::journal::JournalAnchor;

    struct Fixture {
        storage: Storage,
        directory: PathBuf,
        root: String,
        grant: Grant,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("text-receipts-{}", Uuid::new_v4()));
            fs::create_dir_all(directory.join("files")).unwrap();
            let mut storage = Storage::open(&directory.join("store"), "host").unwrap();
            storage.issue_grant(&json!({"grantId":"actor","hostGeneration":"generation","owningWorkspace":"workspace",
                "executionWorkspace":"workspace","threadId":"thread","runId":"run","pathScopes":[""],
                "capabilities":["storage.read","storage.write","recovery"]}),"host","generation",&storage.root.to_string_lossy().to_string(),"epoch").unwrap();
            let grant = storage.load_grant("actor").unwrap();
            let root = storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":directory.join("files")}), &grant).unwrap()["rootId"].as_str().unwrap().to_owned();
            Self {
                storage,
                directory,
                root,
                grant,
            }
        }
        fn invoke(&mut self, method: &str, value: Value) -> Value {
            self.invoke_as("actor", method, value)
        }
        fn invoke_as(&mut self, actor: &str, method: &str, value: Value) -> Value {
            let (grant, params) = self
                .storage
                .authorize(Some(actor), "epoch", "host", "generation", method, &value)
                .unwrap();
            self.storage
                .dispatch(method, &params, Some(actor), &grant)
                .unwrap()
        }
        fn compute_read(
            &mut self,
            actor: &str,
            branch: &str,
            revision: i64,
            encoding: Option<&str>,
        ) -> Value {
            self.compute_source(
                actor,
                json!({"branchId":branch,"revision":revision}),
                encoding,
            )
        }
        fn compute_source(&mut self, actor: &str, source: Value, encoding: Option<&str>) -> Value {
            let job = Uuid::new_v4().to_string();
            let mut params = json!({"workspaceId":"workspace","jobId":job,"operation":"read","lane":"foreground",
                "paths":["a.txt"],"files":[{"path":"a.txt"}],"textEncoding":{"files":{"a.txt":"gbk"}}});
            for (key, value) in source.as_object().unwrap() {
                params[key] = value.clone();
            }
            if let Some(encoding) = encoding {
                params["encoding"] = json!(encoding);
            }
            let mut page = self.invoke_as(actor, "compute.start", params);
            let mut records = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                records.extend(page["records"].as_array().unwrap().iter().cloned());
                if !matches!(page["status"].as_str().unwrap(), "queued" | "running")
                    && page["nextCursor"] == page["endCursor"]
                {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "fixed computation did not settle: {page}"
                );
                std::thread::sleep(std::time::Duration::from_millis(2));
                page = self.invoke_as(
                    actor,
                    "compute.read",
                    json!({"workspaceId":"workspace","jobId":job,"cursor":page["nextCursor"]}),
                );
            }
            assert_eq!(page["status"], "ready", "{page}");
            self.invoke_as(
                actor,
                "compute.release",
                json!({"workspaceId":"workspace","jobId":job}),
            );
            records
                .into_iter()
                .find(|record| record["kind"] == "text")
                .expect("fixed source produced text")
        }
        fn upload(&mut self, bytes: &[u8]) -> Value {
            let id = Uuid::new_v4().to_string();
            let params = json!({"workspaceId":"workspace","operationId":id,"streamId":id,"byteLength":bytes.len()});
            self.storage.begin_blob_stream(&params, "actor").unwrap();
            self.storage
                .stream_blob_bytes(&id, 0, bytes, "actor")
                .unwrap();
            self.storage.finish_blob_stream(&params, "actor").unwrap()
        }
        fn branch(&mut self, name: &str, bytes: &[u8]) {
            let blob = self.upload(bytes);
            let id = format!("create-{name}");
            self.invoke("branch.create.begin", json!({"operationId":id,"builderId":id,"workspaceId":"workspace","branchId":name,"draftBasePaths":[],"captureScopes":[]}));
            self.invoke("branch.create.append", json!({"builderId":id,"sequence":0,"entries":[{"path":"a.txt","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":bytes.len(),"mode":420},"ownerId":blob["ownerId"]}]}));
            self.invoke(
                "branch.create.finish",
                json!({"operationId":id,"builderId":id}),
            );
        }
        fn publish(&mut self, branch: &str, publication: &str) -> Value {
            let observed = self.storage.branch(branch).unwrap();
            let operation = format!("result-prepare:{publication}");
            self.invoke("branch.write.begin",json!({"operationId":operation,"builderId":operation,"branchId":branch,"expectedWriteRevision":observed.write_revision}));
            self.invoke("working.result.prepare",json!({"operationId":operation,"publicationId":publication,"builderId":operation,"expectedRoot":observed.head_root}));
            self.invoke("working.result.publish",json!({"operationId":publication,"workspaceId":"workspace","branchId":branch,"candidateOperationId":operation}))
        }
        fn mutation(
            &mut self,
            id: &str,
            content: &str,
            source: &str,
            target: &str,
            branch: Option<&str>,
            journal: bool,
        ) -> (TextMutation, Value) {
            let resource = self
                .storage
                .resolve_file_resource(&self.root, "a.txt", &self.grant, false)
                .unwrap();
            let state = self.storage.capture_file_state(&resource).unwrap();
            let bytes = fs::read(self.directory.join("files/a.txt")).unwrap();
            let format = crate::text::decode(&bytes, Some(source), None).unwrap().1;
            let mutation = TextMutation::Write(FileWriteArgs {
                path: "a.txt".into(),
                read_version: read_version(&self.root, "a.txt", &state).unwrap(),
                content: content.into(),
                mode: None,
                source_format: Some(format),
                target_format: Some(crate::text::TargetFormat {
                    encoding: Some(target.into()),
                    bom: None,
                    line_ending: None,
                }),
            });
            let anchor = JournalAnchor {
                execution_id: "run:input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                run_id: "run".into(),
                entry_id: "input".into(),
                epoch: 1,
            };
            let task = self
                .storage
                .prepare_text_mutation(
                    "workspace",
                    &self.root,
                    id,
                    &mutation,
                    &self.grant,
                    if journal { Some(&anchor) } else { None },
                    varin_runtime::SourceMode::LiveRoot,
                    None,
                    Arc::new(AtomicBool::new(false)),
                )
                .unwrap()
                .with_text_branch(branch.map(str::to_owned))
                .with_text_policy(Some(crate::text::Policy {
                    root: Some(self.directory.join("files").to_string_lossy().into_owned()),
                    choice_revisions: Some(BTreeMap::from([("a.txt".into(), 7)])),
                    ..Default::default()
                }));
            let result = task.run_local(&mut self.storage, &mut false).unwrap();
            assert_eq!(result["status"], "applied");
            (mutation, result)
        }
        fn reopen(&mut self) {
            let mut replacement =
                Storage::open(&self.directory.join("replacement"), "host").unwrap();
            std::mem::swap(&mut replacement, &mut self.storage);
            drop(replacement);
            self.storage = Storage::open(&self.directory.join("store"), "host").unwrap();
            self.grant = self.storage.load_grant("actor").unwrap();
            let root = self.storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":self.directory.join("files")}), &self.grant).unwrap();
            assert_eq!(root["rootId"], self.root);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn generic_file_codecs_survive_real_writes_and_read_version_binding() {
        let mut f=Fixture::new();
        for (index,encoding,text) in [(0,"gb18030","中文𠀀🙂\r\n"),(1,"shift_jis","日本語\r\n"),(2,"gb2312-strict","中文・―\r\n"),(3,"iso-2022-jp","日本語\r\n")] {
            let format=crate::text::Format {encoding:encoding.into(),bom:false,line_ending:"crlf".into(),default_line_ending:"crlf".into(),source:"explicit".into()};
            let bytes=crate::text::encode(text,&format).unwrap();fs::write(f.directory.join("files/a.txt"),&bytes).unwrap();
            let content=format!("{text}next\r\n");
            let (_,receipt)=f.mutation(&format!("codec-{index}"),&content,encoding,encoding,None,false);
            let saved=fs::read(f.directory.join("files/a.txt")).unwrap();
            assert_eq!(crate::text::decode(&saved,Some(encoding),None).unwrap().0,content);
            let version=crate::storage::file_mutations::text_read_version("raw-version",encoding);
            let args=FileWriteArgs {path:"a.txt".into(),read_version:version,content:content.clone(),mode:None,source_format:Some(format),target_format:None};
            assert_eq!(TextMutation::Write(args).read_encoding(),Some(encoding));
            assert_eq!(receipt["status"],"applied");
        }
    }

    #[test]
    fn committed_receipts_are_source_hash_scoped_and_survive_reopen_without_replaying_choices() {
        let mut f = Fixture::new();
        let bytes = encoding_rs::GBK.encode("中文").0.into_owned();
        fs::write(f.directory.join("files/a.txt"), &bytes).unwrap();
        let (first, first_receipt) = f.mutation("first", "text", "gbk", "utf-8", None, true);
        let first_hash = first_receipt["state"]["objectHash"]
            .as_str()
            .unwrap()
            .to_owned();
        let admitted = f.storage.text_format_receipts(&f.grant, &f.root).unwrap();
        assert_eq!(
            admitted.format("a.txt", &first_hash).unwrap().encoding,
            "utf-8"
        );
        assert!(admitted.format("a.txt", "wrong-hash").is_none());
        assert!(admitted.format("other.txt", &first_hash).is_none());
        let mut other = f.grant.clone();
        other.run_id = Some("other-run".into());
        assert!(
            f.storage
                .text_format_receipts(&other, &f.root)
                .unwrap()
                .is_empty()
        );
        other = f.grant.clone();
        other.grant_id = "other-grant".into();
        assert!(
            f.storage
                .text_format_receipts(&other, &f.root)
                .unwrap()
                .is_empty()
        );
        let (_, second) = f.mutation("second", "text", "utf-8", "gbk", None, true);
        assert_eq!(
            first_receipt["state"]["objectHash"], second["state"]["objectHash"],
            "ASCII format-only choice keeps the same bytes"
        );
        assert_eq!(
            f.storage
                .text_format_receipts(&f.grant, &f.root)
                .unwrap()
                .format("a.txt", &first_hash)
                .unwrap()
                .encoding,
            "gbk"
        );
        // An already admitted read keeps the interpretation selected at admission.
        assert_eq!(
            admitted.format("a.txt", &first_hash).unwrap().encoding,
            "utf-8"
        );
        let anchor = JournalAnchor {
            execution_id: "run:input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            run_id: "run".into(),
            entry_id: "input".into(),
            epoch: 1,
        };
        let replay = f
            .storage
            .file_mutate(
                "workspace",
                &f.root,
                "first",
                &first,
                &f.grant,
                Some(&anchor),
                varin_runtime::SourceMode::LiveRoot,
                true,
                &mut false,
                None,
            )
            .unwrap();
        assert_eq!(replay["format"]["encoding"], "utf-8");
        assert_eq!(
            f.storage
                .text_format_receipts(&f.grant, &f.root)
                .unwrap()
                .format("a.txt", &first_hash)
                .unwrap()
                .encoding,
            "gbk"
        );
        f.reopen();
        assert_eq!(
            f.storage
                .text_format_receipts(&f.grant, &f.root)
                .unwrap()
                .format("a.txt", &first_hash)
                .unwrap()
                .encoding,
            "gbk"
        );
        assert_eq!(
            f.storage
                .operation_release(&json!({"workspaceId":"workspace","operationId":"second"}))
                .unwrap()["released"],
            true
        );
        assert!(
            f.storage
                .operation_get(&json!({"operationId":"second"}))
                .unwrap()
                .is_null()
        );
        f.reopen();
        assert_eq!(
            f.storage
                .text_format_receipts(&f.grant, &f.root)
                .unwrap()
                .format("a.txt", &first_hash)
                .unwrap()
                .encoding,
            "gbk",
            "releasing the latest receipt must never revive an older same-hash codec"
        );
        let changes = f.storage.recovery_change_list(&json!({"workspaceId":"workspace","conversation":{"kind":"thread","threadId":"thread","branchId":"main"}}),"actor").unwrap();
        assert_eq!(
            changes["changes"][0]["beforeFormat"]["encoding"], "gbk",
            "first raw before-image, not the later UTF-8 intermediate"
        );
        assert_eq!(changes["changes"][0]["afterFormat"]["encoding"], "gbk");
        fs::create_dir_all(f.directory.join("other")).unwrap();
        let other_root = f.storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":f.directory.join("other")}),&f.grant).unwrap();
        assert!(
            f.storage
                .text_format_receipts(&f.grant, other_root["rootId"].as_str().unwrap())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            f.storage
                .operation_release(&json!({"workspaceId":"workspace","operationId":"first"}))
                .unwrap()["released"],
            true
        );
        let changes = f.storage.recovery_change_list(&json!({"workspaceId":"workspace","conversation":{"kind":"thread","threadId":"thread","branchId":"main"}}),"actor").unwrap();
        assert!(
            changes["changes"][0].get("beforeFormat").is_none(),
            "released first evidence must not be replaced with an intermediate source format"
        );
    }

    #[test]
    fn released_current_formats_do_not_accumulate_superseded_receipts() {
        let mut f = Fixture::new();
        fs::write(f.directory.join("files/a.txt"), b"original").unwrap();
        for index in 0..8 {
            let id = format!("save-{index}");
            f.mutation(&id, &format!("text {index}"), "gbk", "gbk", None, false);
            f.storage
                .operation_release(&json!({"workspaceId":"workspace","operationId":id}))
                .unwrap();
            assert_eq!(f.storage.text_formats.current_facts.len(), 1);
            assert_eq!(
                f.storage.text_formats.receipts.len(),
                1,
                "only the current format remains after releasing successive writes"
            );
            assert!(f.storage.text_formats.retained_receipts.is_empty());
            if index == 3 {
                f.reopen();
            }
        }
        f.reopen();
        assert_eq!(f.storage.text_formats.receipts.len(), 1);
        let directory = fs::canonicalize(f.directory.join("files")).unwrap();
        let keys = f
            .storage
            .text_format_keys_for_directory("workspace", &directory);
        f.storage.delete_text_format_facts(&keys).unwrap();
        f.storage.forget_text_format_facts(&keys);
        let formats = &f.storage.text_formats;
        assert!(formats.receipts.is_empty());
        assert!(formats.operation_keys.is_empty());
        assert!(formats.root_operations.is_empty());
        assert!(formats.source_operations.is_empty());
        assert!(formats.sources.is_empty());
        assert!(formats.current_roots.is_empty());
    }

    #[test]
    fn conversion_candidates_survive_restart_and_continue_only_an_exact_same_source_chain() {
        let mut f = Fixture::new();
        fs::write(
            f.directory.join("files/a.txt"),
            encoding_rs::GBK.encode("中文").0,
        )
        .unwrap();
        f.mutation("conversion", "text", "gbk", "utf-8", None, false);
        let (_, latest) = f.mutation("continuing-edit", "next", "utf-8", "utf-8", None, false);
        let params = json!({"workspaceId":"workspace","rootId":f.root,"pageSize":1});
        let before = f.invoke("file.text.conversions", params.clone());
        assert_eq!(before["conversions"].as_array().unwrap().len(), 1);
        let candidate = &before["conversions"][0];
        assert_eq!(candidate["conversionOperationId"], "conversion");
        assert_eq!(candidate["operationId"], "continuing-edit");
        assert_eq!(candidate["rawHash"], latest["state"]["objectHash"]);
        assert_eq!(candidate["targetEncoding"], "utf-8");
        assert_eq!(candidate["choiceRevision"], 7);
        assert_eq!(
            candidate["policyRoot"],
            f.directory.join("files").to_string_lossy().as_ref()
        );
        assert_eq!(candidate["sourceMode"], "live_root");
        let mut exact = params.clone();
        exact["path"] = json!("a.txt");
        exact["cursor"] = json!("z.txt");
        assert_eq!(
            f.invoke("file.text.conversions", exact.clone()),
            before,
            "exact path lookup ignores pagination cursor"
        );
        exact["path"] = json!("missing.txt");
        assert!(
            f.invoke("file.text.conversions", exact)["conversions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        f.reopen();
        assert_eq!(f.invoke("file.text.conversions", params.clone()), before);
        let facts: i64 = f
            .storage
            .conn
            .query_row(
                "SELECT count(*) FROM metadata WHERE key GLOB 'file-text-format-v1:*'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            facts, 1,
            "one current fact per root/path, not a second history ledger"
        );
        f.storage.issue_grant(&json!({"grantId":"next-reader","hostGeneration":"generation","owningWorkspace":"workspace",
            "executionWorkspace":"workspace","threadId":"thread","runId":"next-run","pathScopes":["a.txt"],
            "capabilities":["storage.read"]}),"host","generation",&f.storage.root.to_string_lossy().to_string(),"epoch").unwrap();
        let (grant, authorized) = f
            .storage
            .authorize(
                Some("next-reader"),
                "epoch",
                "host",
                "generation",
                "file.text.conversions",
                &params,
            )
            .unwrap();
        assert_eq!(
            f.storage
                .dispatch(
                    "file.text.conversions",
                    &authorized,
                    Some("next-reader"),
                    &grant
                )
                .unwrap(),
            before
        );
        let mut wrong = params.clone();
        wrong["workspaceId"] = json!("unrelated");
        assert!(f.storage.file_text_conversions(&wrong, &grant).is_err());
        let mut restricted = grant.clone();
        restricted.path_scopes = vec!["other.txt".into()];
        assert!(
            f.storage
                .file_text_conversions(&params, &restricted)
                .unwrap()["conversions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        // The metadata query is not a claim about the current filesystem. The
        // caller must raw-hash check; a later witnessed external gap also ends
        // propagation of the original explicit encoding choice.
        fs::write(f.directory.join("files/a.txt"), "external").unwrap();
        assert_eq!(f.invoke("file.text.conversions", params.clone()), before);
        f.mutation(
            "after-external-change",
            "changed",
            "utf-8",
            "utf-8",
            None,
            false,
        );
        assert!(
            f.invoke("file.text.conversions", params)["conversions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn released_operation_id_reuse_selects_the_new_commit_even_with_identical_ascii_bytes() {
        let mut f = Fixture::new();
        fs::write(f.directory.join("files/a.txt"), "text").unwrap();
        let (_, first) = f.mutation("reused", "text", "gbk", "utf-8", None, false);
        assert_eq!(
            f.storage
                .operation_release(&json!({"workspaceId":"workspace","operationId":"reused"}))
                .unwrap()["released"],
            true
        );
        f.mutation("reused", "text", "utf-8", "gbk", None, false);
        let hash = first["state"]["objectHash"].as_str().unwrap();
        assert_eq!(
            f.storage
                .text_format_receipts(&f.grant, &f.root)
                .unwrap()
                .format("a.txt", hash)
                .unwrap()
                .encoding,
            "gbk"
        );
        f.reopen();
        assert_eq!(
            f.storage
                .text_format_receipts(&f.grant, &f.root)
                .unwrap()
                .format("a.txt", hash)
                .unwrap()
                .encoding,
            "gbk"
        );
    }

    #[test]
    fn branch_policy_read_and_fork_preserve_absent_and_populated_optional_fields() {
        let mut f = Fixture::new();
        for (index, policy) in [
            None,
            Some(json!({})),
            Some(json!({"root":"/original"})),
            Some(json!({"defaultEncoding":"gbk"})),
            Some(json!({"files":{"a.txt":"gbk"}})),
            Some(json!({"root":"/original","defaultEncoding":"utf-8",
                "files":{"a.txt":"gbk"},"choiceRevisions":{"a.txt":9}})),
        ]
        .into_iter()
        .enumerate()
        {
            let branch = format!("policy-{index}");
            let operation = format!("branch-create:{branch}");
            let mut create = json!({"operationId":operation,"builderId":operation,
                "workspaceId":"workspace","branchId":branch,"draftBasePaths":[],"captureScopes":[]});
            if let Some(policy) = &policy {
                create["textEncoding"] = policy.clone();
            }
            f.invoke("branch.create.begin", create);
            f.invoke(
                "branch.create.finish",
                json!({"operationId":operation,"builderId":operation}),
            );
            let selected = f.invoke(
                "branch.read",
                json!({"branchId":branch,"revision":0,"includeEntries":false}),
            );
            assert_eq!(selected.get("textEncoding"), policy.as_ref(), "{selected}");
            // Reuse the actual read projection exactly as the Host prepares
            // the child's source-provenance object and branch.fork request.
            let projected = selected
                .get("textEncoding")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let provenance = json!({"consistency":"fixed-root","root":selected["root"],"textEncoding":projected});
            let uploaded = f.upload(&serde_json::to_vec(&provenance).unwrap());
            let pin = f.invoke(
                "branch.pin",
                json!({"operationId":format!("pin:{branch}"),
                "branchId":branch,"revision":0,"pinId":format!("selected:{branch}")}),
            );
            let child = format!("child:{branch}");
            f.invoke(
                "branch.fork",
                json!({"operationId":format!("branch-fork:{child}"),
                "workspaceId":"workspace","sourceBranchId":branch,"sourcePinId":pin["pinId"],
                "branchId":child,"draftBasePaths":[],"captureScopes":[],"textEncoding":projected,
                "sourceProvenance":{"objectHash":uploaded["hash"],"ownerId":uploaded["ownerId"]}}),
            );
            let forked = f.invoke(
                "branch.read",
                json!({"branchId":child,"revision":0,"includeEntries":false}),
            );
            assert_eq!(forked["root"], selected["root"]);
            assert_eq!(forked["textEncoding"], projected, "{forked}");
        }
    }

    #[test]
    fn unchanged_range_backed_result_keeps_its_exact_interpretation_for_a_new_run() {
        let mut f = Fixture::new();
        let bytes = b"text";
        fs::write(f.directory.join("files/a.txt"), bytes).unwrap();
        let raw = f.upload(bytes);
        let version = super::super::file_content::Version {
            format: 1,
            byte_length: bytes.len() as u64,
            ranges: vec![super::super::file_content::Range {
                offset: 0,
                length: bytes.len() as u64,
                object_hash: raw["hash"].as_str().unwrap().into(),
                object_offset: 0,
                object_length: bytes.len() as u64,
            }],
        };
        let descriptor = serde_json::to_vec(&version).unwrap();
        let reference = format!("ranges-sha256-{}", hex::encode(Sha256::digest(&descriptor)));
        assert_ne!(
            reference.strip_prefix("ranges-"),
            raw["hash"].as_str(),
            "range references hash descriptors, not raw content"
        );
        let upload = json!({"workspaceId":"workspace","operationId":"range","streamId":"range","byteLength":descriptor.len(),"expectedHash":reference});
        f.storage.begin_blob_stream(&upload, "actor").unwrap();
        f.storage
            .stream_blob_bytes("range", 0, &descriptor, "actor")
            .unwrap();
        let ranged = f.storage.finish_blob_stream(&upload, "actor").unwrap();
        f.invoke("branch.create.begin",json!({"operationId":"ascii-create","builderId":"ascii-create","workspaceId":"workspace","branchId":"ascii","draftBasePaths":[],"captureScopes":[],"textEncoding":{"files":{"a.txt":"gbk","private.txt":"shift_jis","dir/":"gbk"}}}));
        f.invoke("branch.create.append",json!({"builderId":"ascii-create","sequence":0,"entries":[{"path":"a.txt","state":{"kind":"regular-file","objectHash":ranged["hash"],"byteLength":bytes.len(),"mode":420},"ownerId":ranged["ownerId"]}]}));
        f.invoke(
            "branch.create.finish",
            json!({"operationId":"ascii-create","builderId":"ascii-create"}),
        );
        f.mutation("format-only", "text", "gbk", "utf-8", Some("ascii"), false);
        let branch = f.storage.branch("ascii").unwrap();
        f.invoke("branch.write.begin",json!({"operationId":"result-prepare:ascii-result","builderId":"result-prepare:ascii-result","branchId":"ascii","expectedWriteRevision":branch.write_revision}));
        f.invoke("working.result.prepare",json!({"operationId":"result-prepare:ascii-result","publicationId":"ascii-result","builderId":"result-prepare:ascii-result","expectedRoot":branch.head_root}));
        let published=f.invoke("working.result.publish",json!({"operationId":"ascii-result","workspaceId":"workspace","branchId":"ascii","candidateOperationId":"result-prepare:ascii-result"}));
        let result = f.invoke(
            "working.result.get",
            json!({"workspaceId":"workspace","recordId":published["recordId"]}),
        );
        assert_eq!(result["record"]["changedPaths"], json!([]));
        assert_eq!(
            result["record"]["textFormats"]["a.txt"]["base"]["encoding"],
            "gbk"
        );
        assert_eq!(
            result["record"]["textFormats"]["a.txt"]["child"]["encoding"],
            "utf-8"
        );
        f.storage.issue_grant(&json!({"grantId":"future","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"future-run","pathScopes":[""],"capabilities":["storage.read"]}),"host","generation",&f.storage.root.to_string_lossy().to_string(),"epoch").unwrap();
        // The full result stays private to the producing Run. The immutable
        // branch's small interpretation projection has branch-read authority.
        f.storage
            .conn
            .execute(
                "UPDATE domain_records SET run_id='run' WHERE record_id=?1",
                [published["recordId"].as_str().unwrap()],
            )
            .unwrap();
        let (grant, params) = f
            .storage
            .authorize(
                Some("future"),
                "epoch",
                "host",
                "generation",
                "working.result.get",
                &json!({"workspaceId":"workspace","recordId":published["recordId"]}),
            )
            .unwrap();
        assert!(
            f.storage
                .dispatch("working.result.get", &params, Some("future"), &grant)
                .is_err(),
            "private result body is not made public"
        );
        assert_eq!(
            f.invoke_as(
                "future",
                "branch.read",
                json!({"branchId":"ascii","revision":0,"includeEntries":false})
            )["textEncoding"]["files"]["a.txt"],
            "gbk"
        );
        assert_eq!(
            f.invoke_as(
                "future",
                "branch.read",
                json!({"branchId":"ascii","revision":1,"includeEntries":false})
            )["textEncoding"]["files"]["a.txt"],
            "utf-8"
        );
        let implicit = f.compute_read("future", "ascii", 1, None);
        assert_eq!(implicit["data"]["text"], "text");
        assert_eq!(implicit["data"]["format"]["encoding"], "utf-8");
        let explicit = f.compute_read("future", "ascii", 1, Some("gbk"));
        assert_eq!(explicit["data"]["format"]["encoding"], "gbk");
        f.storage.issue_grant(&json!({"grantId":"scoped","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"future-run","pathScopes":["a.txt"],"capabilities":["storage.read"]}),"host","generation",&f.storage.root.to_string_lossy().to_string(),"epoch").unwrap();
        let scoped = f.invoke_as(
            "scoped",
            "branch.read",
            json!({"branchId":"ascii","revision":1,"includeEntries":false}),
        );
        assert_eq!(scoped["textEncoding"]["files"], json!({"a.txt":"utf-8"}));
        let pin = f.invoke(
            "branch.pin",
            json!({"operationId":"ascii-pin","branchId":"ascii","revision":1,"pinId":"ascii-selected"}),
        );
        f.invoke("branch.fork",json!({"operationId":"fork-result","workspaceId":"workspace","sourceBranchId":"ascii","sourcePinId":pin["pinId"],"branchId":"ascii-child","draftBasePaths":[],"captureScopes":[]}));
        assert_eq!(
            f.invoke_as(
                "future",
                "branch.read",
                json!({"branchId":"ascii-child","revision":0,"includeEntries":false})
            )["textEncoding"]["files"]["a.txt"],
            "utf-8"
        );
        assert_eq!(
            f.compute_read("future", "ascii-child", 0, None)["data"]["format"]["encoding"],
            "utf-8"
        );
        let future = f.storage.load_grant("future").unwrap();
        let snapshot = f
            .storage
            .text_format_receipts_for_fixed(&future, "ascii", 1, &branch.head_root)
            .unwrap();
        assert_eq!(
            snapshot.format("a.txt", &reference).unwrap().encoding,
            "utf-8"
        );
        assert!(
            snapshot
                .format("a.txt", raw["hash"].as_str().unwrap())
                .is_none(),
            "tree snapshot keys remain exact object references"
        );
        assert!(
            f.storage
                .text_format_receipts_for_fixed(&future, "ascii", 0, &branch.head_root)
                .unwrap()
                .is_empty(),
            "identical raw root does not turn original revision into a converted result"
        );
        assert!(
            f.storage
                .text_format_receipts_for_fixed(&future, "ascii", 1, "wrong-root")
                .unwrap()
                .is_empty()
        );
        f.mutation("later-format", "text", "utf-8", "gbk", Some("ascii"), false);
        assert_eq!(
            f.storage
                .operation_release(&json!({"workspaceId":"workspace","operationId":"format-only"}))
                .unwrap()["released"],
            true
        );
        f.reopen();
        let future = f.storage.load_grant("future").unwrap();
        assert_eq!(
            f.storage
                .text_format_receipts_for_fixed(&future, "ascii", 1, &branch.head_root)
                .unwrap()
                .format("a.txt", &reference)
                .unwrap()
                .encoding,
            "utf-8"
        );
    }

    #[test]
    fn ascii_format_only_restore_and_undo_replace_current_fact_across_restart() {
        let mut f = Fixture::new();
        fs::write(f.directory.join("files/a.txt"), b"text").unwrap();
        f.mutation("convert-ascii", "text", "gbk", "utf-8", None, true);
        let source = json!({"rootId":f.root,"textEncoding":{"files":{"a.txt":"utf-8"}}});
        assert_eq!(
            f.compute_source("actor", source.clone(), None)["data"]["format"]["encoding"],
            "utf-8"
        );
        let anchor = JournalAnchor {
            execution_id: "run:input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            run_id: "run".into(),
            entry_id: "input".into(),
            epoch: 1,
        };
        let restored = f
            .storage
            .restore_recorded_files(
                "workspace",
                &f.root,
                "thread",
                "restore-ascii",
                &super::super::recovery_points::FileRestoreArgs {
                    point: Some("current:before".into()),
                    undo: None,
                    paths: None,
                    overwrite_paths: None,
                    blocked_paths: None,
                },
                Some(&anchor),
                varin_runtime::SourceMode::LiveRoot,
                &f.grant,
                &mut false,
            )
            .unwrap();
        assert_eq!(restored["status"], "applied", "{restored}");
        assert_eq!(fs::read(f.directory.join("files/a.txt")).unwrap(), b"text");
        assert_eq!(
            f.compute_source("actor", source.clone(), None)["data"]["format"]["encoding"],
            "gbk"
        );
        let candidate = f.invoke(
            "file.text.conversions",
            json!({"workspaceId":"workspace","rootId":f.root,"path":"a.txt"}),
        );
        assert_eq!(candidate["conversions"][0]["sourceEncoding"], "utf-8");
        assert_eq!(candidate["conversions"][0]["targetEncoding"], "gbk");
        assert_eq!(candidate["conversions"][0]["choiceRevision"], 7);
        f.reopen();
        assert_eq!(
            f.compute_source("actor", source.clone(), None)["data"]["format"]["encoding"],
            "gbk"
        );
        let undone = f
            .storage
            .restore_recorded_files(
                "workspace",
                &f.root,
                "thread",
                "undo-ascii",
                &super::super::recovery_points::FileRestoreArgs {
                    point: None,
                    undo: Some("restore-ascii".into()),
                    paths: None,
                    overwrite_paths: None,
                    blocked_paths: None,
                },
                Some(&anchor),
                varin_runtime::SourceMode::LiveRoot,
                &f.grant,
                &mut false,
            )
            .unwrap();
        assert_eq!(undone["status"], "applied", "{undone}");
        assert_eq!(
            f.compute_source("actor", json!({"rootId":f.root}), None)["data"]["format"]["encoding"],
            "utf-8"
        );
        f.reopen();
        assert_eq!(
            f.compute_source("actor", json!({"rootId":f.root}), None)["data"]["format"]["encoding"],
            "utf-8"
        );
    }

    #[test]
    fn checkpoint_fork_freezes_format_before_later_same_hash_publication() {
        use super::super::workspace_session::{Session, StoragePort};
        let mut f = Fixture::new();
        fs::write(f.directory.join("files/a.txt"), b"text").unwrap();
        f.branch("checkpoint-source", b"text");
        f.branch("uncaptured-source", b"text");
        f.mutation(
            "checkpoint-first",
            "text",
            "gbk",
            "utf-8",
            Some("checkpoint-source"),
            false,
        );
        f.publish("checkpoint-source", "checkpoint-first-result");
        let resource = f
            .storage
            .resolve_file_resource(&f.root, "a.txt", &f.grant, false)
            .unwrap();
        let state = f.storage.capture_file_state(&resource).unwrap();
        let mutation = TextMutation::Write(FileWriteArgs {
            path: "a.txt".into(),
            read_version: read_version(&f.root, "a.txt", &state).unwrap(),
            content: "text".into(),
            mode: None,
            source_format: Some(crate::text::decode(b"text", Some("utf-8"), None).unwrap().1),
            target_format: Some(crate::text::TargetFormat {
                encoding: Some("gbk".into()),
                bom: None,
                line_ending: None,
            }),
        });
        let later = f
            .storage
            .prepare_text_mutation(
                "workspace",
                &f.root,
                "checkpoint-later",
                &mutation,
                &f.grant,
                None,
                varin_runtime::SourceMode::LiveRoot,
                None,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
            .with_text_branch(Some("checkpoint-source".into()));
        let replacement = Storage::open(&f.directory.join("replacement"), "host").unwrap();
        let owner = Arc::new(std::sync::Mutex::new(std::mem::replace(
            &mut f.storage,
            replacement,
        )));
        let shared = owner.clone();
        let port = StoragePort::new(move |command| {
            let mut storage = shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            command(Some(&mut storage));
            Ok(())
        });
        let session =
            Session::open(port.clone(), "checkpoint-source".into(), f.grant.clone()).unwrap();
        // A real dirty native generation changes object identity to a range
        // descriptor even though the logical bytes happen to remain ASCII.
        let node = session.lookup("a.txt").unwrap();
        session.write(&node, Some(1), b"ex").unwrap();
        let checkpoint = session.checkpoint().unwrap();
        let reset_manual = session
            .checkpoint()
            .unwrap()
            .with_text_policy(Some(crate::text::Policy {
                files: Some(BTreeMap::new()),
                choice_revisions: Some(BTreeMap::from([("a.txt".into(), 9)])),
                ..Default::default()
            }))
            .unwrap();
        let newer_manual = session
            .checkpoint()
            .unwrap()
            .with_text_policy(Some(crate::text::Policy {
                files: Some(BTreeMap::from([("a.txt".into(), "gbk".into())])),
                choice_revisions: Some(BTreeMap::from([("a.txt".into(), 8)])),
                ..Default::default()
            }))
            .unwrap();
        let equal_manual = session
            .checkpoint()
            .unwrap()
            .with_text_policy(Some(crate::text::Policy {
                files: Some(BTreeMap::from([("a.txt".into(), "gbk".into())])),
                choice_revisions: Some(BTreeMap::from([("a.txt".into(), 7)])),
                ..Default::default()
            }))
            .unwrap();
        assert_eq!(
            later
                .run(port.clone())
                .unwrap_or_else(|failure| panic!("{}", failure.error))["status"],
            "applied"
        );
        let later_boundary = session.checkpoint().unwrap();
        later_boundary
            .prepare_result(
                "checkpoint-later-result",
                f.grant.clone(),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        {
            let mut storage = owner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let value = json!({"operationId":"checkpoint-later-result","workspaceId":"workspace","branchId":"checkpoint-source","candidateOperationId":"result-prepare:checkpoint-later-result"});
            let (grant, params) = storage
                .authorize(
                    Some("actor"),
                    "epoch",
                    "host",
                    "generation",
                    "working.result.publish",
                    &value,
                )
                .unwrap();
            storage
                .dispatch("working.result.publish", &params, Some("actor"), &grant)
                .unwrap();
        }
        later_boundary.release().unwrap();
        let fork = checkpoint
            .fork(
                "checkpoint-fixed",
                "checkpoint-fork",
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(
            checkpoint
                .fork(
                    "checkpoint-fixed",
                    "checkpoint-fork",
                    &AtomicBool::new(false)
                )
                .unwrap(),
            fork,
            "original checkpoint replay is unchanged"
        );
        reset_manual
            .fork(
                "checkpoint-reset",
                "checkpoint-reset-fork",
                &AtomicBool::new(false),
            )
            .unwrap();
        reset_manual.release().unwrap();
        // A format-only native mutation needs no OS mount byte write, but does
        // run the real native root/session metadata and committed receipt owners.
        let uncaptured =
            Session::open(port.clone(), "uncaptured-source".into(), f.grant.clone()).unwrap();
        let native_root = owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .register_native_file_root(
                "uncaptured-source",
                &uncaptured.identity().to_string(),
                fs::canonicalize(f.directory.join("files")).unwrap(),
                "",
                &f.grant,
            )
            .unwrap();
        let admitted = owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .admitted_file_root(&native_root, &f.grant)
            .unwrap();
        let observed = super::super::capture_resources::observe_effect(
            &admitted,
            "a.txt",
            &f.grant,
            &AtomicBool::new(false),
        )
        .unwrap();
        let mutation = TextMutation::Write(FileWriteArgs {
            path: "a.txt".into(),
            read_version: read_version(&native_root, "a.txt", &observed).unwrap(),
            content: "text".into(),
            mode: None,
            source_format: Some(crate::text::decode(b"text", Some("gbk"), None).unwrap().1),
            target_format: Some(crate::text::TargetFormat {
                encoding: Some("utf-8".into()),
                bom: None,
                line_ending: None,
            }),
        });
        let native_task = owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .prepare_text_mutation(
                "workspace",
                &native_root,
                "uncaptured-conversion",
                &mutation,
                &f.grant,
                None,
                varin_runtime::SourceMode::NativeWorkspace,
                None,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
            .with_text_branch(Some("uncaptured-source".into()))
            .with_text_policy(Some(crate::text::Policy {
                choice_revisions: Some(BTreeMap::from([("a.txt".into(), 8)])),
                ..Default::default()
            }));
        assert_eq!(
            native_task
                .run(port.clone())
                .unwrap_or_else(|failure| panic!("{}", failure.error))["status"],
            "applied"
        );
        let fallback = uncaptured
            .checkpoint()
            .unwrap()
            .with_text_policy(Some(crate::text::Policy {
                files: Some(BTreeMap::from([("a.txt".into(), "gbk".into())])),
                choice_revisions: Some(BTreeMap::from([("a.txt".into(), 9)])),
                ..Default::default()
            }))
            .unwrap();
        fallback
            .fork(
                "checkpoint-fallback",
                "checkpoint-fallback-fork",
                &AtomicBool::new(false),
            )
            .unwrap();
        fallback.release().unwrap();
        uncaptured.close().unwrap();
        drop(uncaptured);
        drop(admitted);
        drop(native_task);
        newer_manual
            .fork(
                "checkpoint-manual",
                "checkpoint-manual-fork",
                &AtomicBool::new(false),
            )
            .unwrap();
        equal_manual
            .fork(
                "checkpoint-equal",
                "checkpoint-equal-fork",
                &AtomicBool::new(false),
            )
            .unwrap();
        newer_manual.release().unwrap();
        equal_manual.release().unwrap();
        checkpoint.release().unwrap();
        session.close().unwrap();
        drop(node);
        drop(session);
        drop(port);
        let mut storage = Arc::try_unwrap(owner)
            .ok()
            .expect("session released Storage port")
            .into_inner()
            .unwrap();
        std::mem::swap(&mut f.storage, &mut storage);
        drop(storage);
        f.storage.issue_grant(&json!({"grantId":"future","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"future-run","pathScopes":[""],"capabilities":["storage.read"]}),"host","generation",&f.storage.root.to_string_lossy().to_string(),"epoch").unwrap();
        let selected = f.invoke_as(
            "future",
            "branch.read",
            json!({"branchId":"checkpoint-fixed","revision":0,"paths":["a.txt"]}),
        );
        assert!(
            selected["entries"][0]["state"]["objectHash"]
                .as_str()
                .unwrap()
                .starts_with("ranges-sha256-"),
            "{selected}"
        );
        assert_eq!(selected["textEncoding"]["files"]["a.txt"], "utf-8");
        let reset = f.invoke_as(
            "future",
            "branch.read",
            json!({"branchId":"checkpoint-reset","revision":0,"includeEntries":false}),
        );
        assert!(
            reset["textEncoding"]["files"].get("a.txt").is_none(),
            "{reset}"
        );
        assert_eq!(reset["textEncoding"]["choiceRevisions"]["a.txt"], 9);
        let fallback = f.invoke_as(
            "future",
            "branch.read",
            json!({"branchId":"checkpoint-fallback","revision":0,"includeEntries":false}),
        );
        assert_eq!(fallback["textEncoding"]["files"]["a.txt"], "gbk");
        assert_eq!(fallback["textEncoding"]["choiceRevisions"]["a.txt"], 9);
        assert_eq!(
            f.compute_read("future", "checkpoint-fallback", 0, None)["data"]["format"]["encoding"],
            "gbk"
        );
        let manual = f.invoke_as(
            "future",
            "branch.read",
            json!({"branchId":"checkpoint-manual","revision":0,"includeEntries":false}),
        );
        assert_eq!(manual["textEncoding"]["files"]["a.txt"], "gbk");
        assert_eq!(manual["textEncoding"]["choiceRevisions"]["a.txt"], 8);
        assert_eq!(
            f.invoke_as(
                "future",
                "branch.read",
                json!({"branchId":"checkpoint-equal","revision":0,"includeEntries":false})
            )["textEncoding"]["files"]["a.txt"],
            "utf-8"
        );
        assert_eq!(
            f.invoke_as(
                "future",
                "branch.read",
                json!({"branchId":"checkpoint-source","revision":2,"includeEntries":false})
            )["textEncoding"]["files"]["a.txt"],
            "gbk"
        );
        assert_eq!(
            f.compute_read("future", "checkpoint-fixed", 0, None)["data"]["format"]["encoding"],
            "utf-8"
        );
        assert_eq!(
            f.compute_read("future", "checkpoint-fixed", 0, Some("gbk"))["data"]["format"]["encoding"],
            "gbk"
        );
        f.reopen();
        assert_eq!(
            f.compute_read("future", "checkpoint-fixed", 0, None)["data"]["format"]["encoding"],
            "utf-8"
        );
    }

    #[test]
    fn working_result_freezes_original_branch_formats_at_candidate_not_later_same_hash_write() {
        let mut f = Fixture::new();
        let original = encoding_rs::GBK.encode("中文").0.into_owned();
        fs::write(f.directory.join("files/a.txt"), &original).unwrap();
        f.branch("branch", &original);
        f.branch("unrelated", &original);
        f.mutation("first", "text", "gbk", "utf-8", Some("branch"), false);
        let bytes = fs::read(f.directory.join("files/a.txt")).unwrap();
        let blob = f.upload(&bytes);
        let branch = f.storage.branch("branch").unwrap();
        f.invoke("branch.write.begin",json!({"operationId":"result-prepare:publish","builderId":"result-prepare:publish","branchId":"branch","expectedWriteRevision":branch.write_revision}));
        f.invoke("branch.write.append",json!({"builderId":"result-prepare:publish","sequence":0,"changes":[{"path":"a.txt","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":bytes.len(),"mode":420},"ownerId":blob["ownerId"]}]}));
        // Another Run edits a different physical copy of the same baseline.
        // Its same-hash codec choice is not this result's source provenance.
        fs::create_dir_all(f.directory.join("other-copy")).unwrap();
        fs::write(f.directory.join("other-copy/a.txt"), &bytes).unwrap();
        f.storage.issue_grant(&json!({"grantId":"other-copy","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace",
            "threadId":"thread","runId":"other-run","pathScopes":[""],"capabilities":["storage.read","storage.write"]}),"host","generation",&f.storage.root.to_string_lossy().to_string(),"epoch").unwrap();
        let original_grant = f.grant.clone();
        let original_root = f.root.clone();
        f.grant = f.storage.load_grant("other-copy").unwrap();
        f.root=f.storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":f.directory.join("other-copy")}),&f.grant).unwrap()["rootId"].as_str().unwrap().into();
        f.mutation(
            "other-copy-write",
            "text",
            "utf-8",
            "gbk",
            Some("branch"),
            false,
        );
        f.grant = original_grant;
        f.root = original_root;
        f.invoke("working.result.prepare",json!({"operationId":"result-prepare:publish","publicationId":"publish","builderId":"result-prepare:publish","expectedRoot":branch.head_root}));
        f.mutation("later", "text", "utf-8", "gbk", Some("branch"), false);
        f.mutation(
            "unrelated",
            "text",
            "gbk",
            "utf-8",
            Some("unrelated"),
            false,
        );
        let branch_formats = f
            .storage
            .text_format_receipts_for_branch(&f.grant, "branch");
        assert_eq!(
            branch_formats
                .format("a.txt", blob["hash"].as_str().unwrap())
                .unwrap()
                .encoding,
            "gbk"
        );
        let mut other = f.grant.clone();
        other.run_id = Some("other".into());
        assert!(
            f.storage
                .text_format_receipts_for_branch(&other, "branch")
                .is_empty()
        );
        assert_eq!(
            f.storage
                .operation_release(&json!({"workspaceId":"workspace","operationId":"first"}))
                .unwrap()["released"],
            true
        );
        f.reopen();
        let publish = json!({"operationId":"publish","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:publish"});
        let published = f.invoke("working.result.publish", publish.clone());
        let get = json!({"workspaceId":"workspace","recordId":published["recordId"]});
        let result = f.invoke("working.result.get", get.clone());
        assert_eq!(
            result["record"]["textFormats"]["a.txt"]["base"]["encoding"],
            "gbk"
        );
        assert_eq!(
            result["record"]["textFormats"]["a.txt"]["child"]["encoding"],
            "utf-8"
        );
        assert_eq!(f.invoke("working.result.publish", publish), published);
        f.reopen();
        assert_eq!(f.invoke("working.result.get", get), result);
        f.invoke("branch.delete",json!({"operationId":"delete-unrelated","workspaceId":"workspace","branchId":"unrelated"}));
        f.invoke(
            "branch.delete",
            json!({"operationId":"delete-branch","workspaceId":"workspace","branchId":"branch"}),
        );
        let facts: i64 = f
            .storage
            .conn
            .query_row(
                "SELECT count(*) FROM metadata WHERE key GLOB 'file-text-format-v1:*'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            facts, 0,
            "branch cleanup releases its current text-format facts without retaining old operations or bodies"
        );
        f.reopen();
        let query = json!({"workspaceId":"workspace","rootId":f.root});
        assert!(
            f.invoke("file.text.conversions", query)["conversions"]
                .as_array()
                .unwrap()
                .is_empty(),
            "historical operations must not recreate a cleaned current-fact projection"
        );
    }
}
