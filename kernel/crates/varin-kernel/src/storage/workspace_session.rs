//! The native filesystem session shared by OS callbacks. Metadata is admitted by
//! the existing Storage owner; range I/O never takes the control thread or wire.
use super::workspace_files::{FileSnapshot, PrivateFile};
use super::workspace_metadata::{Attributes, Head, Metadata};
use super::*;
use std::sync::{Mutex, RwLock};

pub(crate) type Command = Box<dyn FnOnce(Option<&mut Storage>) + Send>;

/// In-process port, deliberately not an extension or model-callable executor.
#[derive(Clone)]
pub(crate) struct StoragePort(Arc<dyn Fn(Command) -> Result<(), KernelError> + Send + Sync>);
impl StoragePort {
    pub(crate) fn new(
        send: impl Fn(Command) -> Result<(), KernelError> + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(send))
    }
    pub(crate) fn call<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        (self.0)(Box::new(move |storage| {
            let result = storage
                .ok_or_else(|| KernelError::Storage("workspace Storage owner is closed".into()))
                .and_then(work);
            let _ = sender.send(result);
        }))?;
        receiver
            .recv()
            .map_err(|_| KernelError::Storage("workspace Storage owner disconnected".into()))?
    }
}

fn failure(code: &str, message: &str) -> KernelError {
    KernelError::Execution(varin_runtime::execution::ExecutionError::new(code, message))
}
fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, KernelError> {
    value
        .lock()
        .map_err(|_| KernelError::Storage("workspace session lock poisoned".into()))
}
fn path(value: &str) -> Result<String, KernelError> {
    if value.is_empty() {
        Ok(String::new())
    } else {
        Ok(Storage::validate_path(value)?.join("/"))
    }
}
fn parent(value: &str) -> &str {
    value.rsplit_once('/').map_or("", |(parent, _)| parent)
}

struct NodeState {
    /// None means unlink/replaced. Open handles continue to refer to this inode.
    path: Option<String>,
    observed: Value,
    clean_generation: u64,
    metadata: Metadata,
    metadata_generation: u64,
    clean_metadata_generation: u64,
}
#[derive(Default)]
struct ContentSlot {
    open: std::sync::Weak<PrivateFile>,
    dirty: Option<Arc<PrivateFile>>,
}
pub(crate) struct Node {
    pub(crate) id: u64,
    session: Uuid,
    state: Mutex<NodeState>,
    content: Mutex<ContentSlot>,
    /// Serialize durable publications, not normal range writes.
    publication: Mutex<()>,
}
impl Node {
    pub(crate) fn attributes(&self) -> Result<Attributes, KernelError> {
        Ok(lock(&self.state)?.metadata.attributes.clone())
    }
    pub(crate) fn state(&self) -> Result<PathState, KernelError> {
        let selected = lock(&self.state)?;
        let mut state: PathState = serde_json::from_value(selected.observed["state"].clone())?;
        match &mut state {
            PathState::RegularFile { mode, .. } => *mode = selected.metadata.attributes.mode,
            PathState::Directory { mode } | PathState::Symlink { mode, .. } => {
                *mode = Some(selected.metadata.attributes.mode)
            }
            _ => {}
        }
        drop(selected);
        if let (PathState::RegularFile { byte_length, .. }, Some(content)) =
            (&mut state, self.file()?)
        {
            *byte_length = content.snapshot()?.byte_length();
        }
        Ok(state)
    }
    fn file(&self) -> Result<Option<Arc<PrivateFile>>, KernelError> {
        Ok(lock(&self.content)?.open.upgrade())
    }
    pub(crate) fn linked(&self) -> Result<bool, KernelError> {
        Ok(lock(&self.state)?.path.is_some())
    }
    pub(crate) fn path(&self) -> Result<Option<String>, KernelError> {
        Ok(lock(&self.state)?.path.clone())
    }
}

struct Namespace {
    paths: BTreeMap<String, Arc<Node>>,
    dirty: BTreeMap<u64, Arc<Node>>,
    next_id: u64,
}

pub(crate) struct Session {
    id: Uuid,
    port: StoragePort,
    branch: String,
    workspace: String,
    grant: Grant,
    root: PathBuf,
    revoked: Arc<AtomicBool>,
    closed: AtomicBool,
    /// Namespace mutations use the exclusive boundary. A flush owns only its
    /// file publication lock during sealing, and joins the shared boundary for
    /// its short metadata commit. Checkpoints never acquire publication locks.
    boundary: RwLock<()>,
    namespace: Mutex<Namespace>,
}

/// Owns a frozen namespace and only the dirty file range maps at its boundary.
/// Parent writes continue while a worker hashes/installs these individual files.
pub(crate) struct Checkpoint {
    port: StoragePort,
    source_branch: String,
    workspace: String,
    grant: Grant,
    root: PathBuf,
    pin: String,
    metadata_pin: String,
    metadata_head: Head,
    metadata: Vec<(String, Metadata)>,
    files: Vec<(String, u32, FileSnapshot)>,
    released: bool,
}

impl Session {
    pub(crate) fn capacity(&self) -> Result<(u64, u64), KernelError> {
        self.active()?;
        Ok((
            fs2::total_space(&self.root)?,
            fs2::available_space(&self.root)?,
        ))
    }
    pub(crate) fn open(
        port: StoragePort,
        branch: String,
        grant: Grant,
    ) -> Result<Arc<Self>, KernelError> {
        let connection = port.clone();
        port.call(move |storage| {
            storage.admit_workspace_session(&branch, "", &grant, true)?;
            if let Some(existing) = storage
                .workspace_sessions
                .get(&branch)
                .and_then(std::sync::Weak::upgrade)
            {
                if existing.active().is_ok() {
                    if existing.grant.grant_id == grant.grant_id
                        && existing.grant.kernel_epoch == grant.kernel_epoch
                    {
                        return Ok(existing);
                    }
                    return Err(failure(
                        "workspace_owner_required",
                        "Reuse the active workspace through its original filesystem owner",
                    ));
                }
            }
            let workspace = storage.branch(&branch)?.workspace_id;
            let observed = storage.branch_path_inspect(&json!({"branchId":branch,"path":""}))?;
            let metadata = storage.read_workspace_metadata(
                &branch,
                "",
                &serde_json::from_value(observed["state"].clone())?,
                &grant,
            )?;
            let id = Uuid::new_v4();
            let root_node = Arc::new(Node {
                id: 1,
                session: id,
                state: Mutex::new(NodeState {
                    path: Some(String::new()),
                    observed,
                    clean_generation: 0,
                    metadata,
                    metadata_generation: 0,
                    clean_metadata_generation: 0,
                }),
                content: Mutex::new(ContentSlot::default()),
                publication: Mutex::new(()),
            });
            let revoked = Arc::new(AtomicBool::new(false));
            let revocations = storage
                .workspace_revocations
                .entry(grant.grant_id.clone())
                .or_default();
            revocations.retain(|weak| weak.strong_count() > 0);
            revocations.push(Arc::downgrade(&revoked));
            let session = Arc::new(Self {
                id,
                port: connection,
                branch: branch.clone(),
                workspace,
                grant,
                root: storage.root.clone(),
                revoked,
                closed: AtomicBool::new(false),
                boundary: RwLock::new(()),
                namespace: Mutex::new(Namespace {
                    paths: BTreeMap::from([(String::new(), root_node)]),
                    dirty: BTreeMap::new(),
                    next_id: 2,
                }),
            });
            // FUSE always reserves inode 1 for the root. Admission and reuse
            // happen on Storage, so two callers cannot invent parallel caches.
            storage
                .workspace_sessions
                .insert(branch, Arc::downgrade(&session));
            Ok(session)
        })
    }
    fn active(&self) -> Result<(), KernelError> {
        if self.revoked.load(Ordering::Acquire) || self.closed.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    fn owns(&self, node: &Node) -> Result<(), KernelError> {
        self.active()?;
        if node.session != self.id {
            return Err(KernelError::Authorization(
                "native file handle belongs to another workspace session".into(),
            ));
        }
        Ok(())
    }
    pub(crate) fn check_open(&self) -> Result<(), KernelError> {
        self.active()
    }
    fn observe(&self, path: &str, write: bool) -> Result<Value, KernelError> {
        self.active()?;
        let (branch, path, actor) = (self.branch.clone(), path.to_owned(), self.grant.clone());
        self.port.call(move |storage| {
            storage.admit_workspace_session(&branch, &path, &actor, write)?;
            storage.branch_path_inspect(&json!({"branchId":branch,"path":path}))
        })
    }
    fn load(&self, namespace: &mut Namespace, path: &str) -> Result<Arc<Node>, KernelError> {
        if let Some(node) = namespace.paths.get(path) {
            return Ok(node.clone());
        }
        let (branch, selected, actor) = (self.branch.clone(), path.to_owned(), self.grant.clone());
        let (observed, metadata) = self.port.call(move |s| {
            s.admit_workspace_session(&branch, &selected, &actor, false)?;
            let observed = s.branch_path_inspect(&json!({"branchId":branch,"path":selected}))?;
            let state = serde_json::from_value(observed["state"].clone())?;
            let metadata = s.read_workspace_metadata(&branch, &selected, &state, &actor)?;
            Ok((observed, metadata))
        })?;
        let state: PathState = serde_json::from_value(observed["state"].clone())?;
        if matches!(state, PathState::Missing) {
            return Err(failure(
                "namespace_missing",
                "File or directory does not exist",
            ));
        }
        if matches!(state, PathState::Unsupported) {
            return Err(failure(
                "namespace_unsupported",
                "Source entry cannot be represented by this filesystem",
            ));
        }
        let node = Arc::new(Node {
            id: namespace.next_id,
            session: self.id,
            state: Mutex::new(NodeState {
                path: Some(path.into()),
                observed,
                clean_generation: 0,
                metadata,
                metadata_generation: 0,
                clean_metadata_generation: 0,
            }),
            content: Mutex::new(ContentSlot::default()),
            publication: Mutex::new(()),
        });
        namespace.next_id = namespace.next_id.checked_add(1).ok_or_else(|| {
            failure(
                "namespace_identity_exhausted",
                "Native file identity space exhausted",
            )
        })?;
        namespace.paths.insert(path.into(), node.clone());
        Ok(node)
    }
    /// Caller holds a shared namespace boundary. Metadata lookup/stat never
    /// opens a body: only an actual native open or byte operation retains it.
    fn content_locked(&self, node: &Node) -> Result<Arc<PrivateFile>, KernelError> {
        let mut content = lock(&node.content)?;
        if let Some(file) = content.open.upgrade() {
            return Ok(file);
        }
        let mut state = lock(&node.state)?;
        let selected = state.path.clone().ok_or_else(|| {
            failure(
                "namespace_missing",
                "Unlinked file has no remaining native byte handle",
            )
        })?;
        if state.observed["state"]["kind"] != "regular-file" {
            return Err(failure("namespace_not_file", "Entry is not a regular file"));
        }
        let expected = state.observed.clone();
        let (branch, actor, revoked) = (
            self.branch.clone(),
            self.grant.clone(),
            self.revoked.clone(),
        );
        let (file, observed) = self
            .port
            .call(move |s| s.open_private_file(&branch, &selected, &actor, revoked))?;
        if observed["state"] != expected["state"] || observed["node"] != expected["node"] {
            return Err(failure(
                "namespace_conflict",
                "File changed while admitting its byte handle",
            ));
        }
        file.open_base()?;
        state.clean_generation = 0;
        content.open = Arc::downgrade(&file);
        Ok(file)
    }
    pub(crate) fn open_file(&self, node: &Node) -> Result<Arc<PrivateFile>, KernelError> {
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
        self.content_locked(node)
    }
    pub(crate) fn lookup(&self, requested: &str) -> Result<Arc<Node>, KernelError> {
        let requested = path(requested)?;
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.active()?;
        self.load(&mut *lock(&self.namespace)?, &requested)
    }
    pub(crate) fn read(
        &self,
        node: &Node,
        offset: u64,
        bytes: &mut [u8],
    ) -> Result<usize, KernelError> {
        self.open_file(node)?.read(offset, bytes)
    }
    fn changed(&self, node: &Arc<Node>, file: Arc<PrivateFile>) -> Result<(), KernelError> {
        let mut state = lock(&node.state)?;
        state.metadata.attributes.touch();
        state.metadata_generation = state.metadata_generation.wrapping_add(1);
        let linked = state.path.is_some();
        drop(state);
        if linked {
            lock(&node.content)?.dirty = Some(file);
            lock(&self.namespace)?.dirty.insert(node.id, node.clone());
        }
        Ok(())
    }
    fn touch_parent(&self, namespace: &mut Namespace, selected: &str) -> Result<(), KernelError> {
        let node = self.load(namespace, parent(selected))?;
        let mut state = lock(&node.state)?;
        state.metadata.attributes.touch();
        state.metadata_generation = state.metadata_generation.wrapping_add(1);
        drop(state);
        namespace.dirty.insert(node.id, node);
        Ok(())
    }
    pub(crate) fn write(
        &self,
        node: &Arc<Node>,
        offset: Option<u64>,
        bytes: &[u8],
    ) -> Result<(u64, usize), KernelError> {
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
        let file = self.content_locked(node)?;
        let result = file.write(offset, bytes)?;
        if result.1 != 0 {
            self.changed(node, file)?;
        }
        Ok(result)
    }
    pub(crate) fn truncate(&self, node: &Arc<Node>, length: u64) -> Result<(), KernelError> {
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
        let file = self.content_locked(node)?;
        file.truncate(length)?;
        self.changed(node, file)?;
        Ok(())
    }
    /// No hashing or body I/O while holding the Storage control owner. The inode
    /// publication lock keeps two flushes from publishing generations backwards.
    pub(crate) fn flush(&self, node: &Node) -> Result<(), KernelError> {
        self.flush_inner(node)
    }
    fn flush_inner(&self, node: &Node) -> Result<(), KernelError> {
        self.owns(node)?;
        let _publication = lock(&node.publication)?;
        let Some(content) = node.file()? else {
            return self.flush_metadata(node);
        };
        let snapshot = content.snapshot()?;
        let generation = snapshot.generation();
        {
            let state = lock(&node.state)?;
            if generation == state.clean_generation || state.path.is_none() {
                drop(state);
                return self.flush_metadata(node);
            }
        }
        let sealed = snapshot.seal(&self.root.join("staging"), &self.revoked)?;
        let retention = self
            .port
            .call(move |storage| Ok((storage.retain_private_file(&sealed), sealed)))?;
        let installed = retention
            .1
            .install(&self.root, retention.0, &self.revoked)?;
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        let mut state = lock(&node.state)?;
        let Some(path) = state.path.clone() else {
            return Ok(());
        };
        let expected = state.observed.clone();
        let metadata = state.metadata.clone();
        let metadata_generation = state.metadata_generation;
        let mode = metadata.attributes.mode;
        let (branch, actor, operation) = (
            self.branch.clone(),
            self.grant.clone(),
            format!("workspace-flush:{}", Uuid::new_v4()),
        );
        let publishing = content.clone();
        let (publication, updated) = self.port.call(move |storage| {
            let publication = storage.publish_private_file_metadata(
                &operation,
                &branch,
                &path,
                &expected,
                mode,
                &publishing,
                &installed,
                &actor,
                Some(&metadata),
            )?;
            let updated = storage.branch_path_inspect(&json!({"branchId":branch,"path":path}))?;
            Ok((publication, updated))
        })?;
        if !publication.committed() {
            return Err(failure(
                "namespace_conflict",
                "File changed outside its admitted workspace handle",
            ));
        }
        state.observed = updated;
        state.clean_generation = generation;
        state.clean_metadata_generation = metadata_generation;
        drop(state);
        {
            let mut namespace = lock(&self.namespace)?;
            let mut slot = lock(&node.content)?;
            let state = lock(&node.state)?;
            if content.snapshot()?.generation() == generation
                && state.metadata_generation == state.clean_metadata_generation
            {
                namespace.dirty.remove(&node.id);
                slot.dirty = None;
            }
        }
        drop(_boundary);
        publication.finish();
        Ok(())
    }
    fn flush_metadata(&self, node: &Node) -> Result<(), KernelError> {
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
        let mut state = lock(&node.state)?;
        if state.metadata_generation == state.clean_metadata_generation || state.path.is_none() {
            return Ok(());
        }
        let (branch, path, actor, metadata) = (
            self.branch.clone(),
            state.path.clone().unwrap(),
            self.grant.clone(),
            state.metadata.clone(),
        );
        self.port.call(move |s| {
            s.admit_workspace_session(&branch, &path, &actor, true)?;
            s.filesystem_transaction(|s| {
                s.save_workspace_metadata(&branch, &path, &metadata, &actor)
            })
        })?;
        state.clean_metadata_generation = state.metadata_generation;
        Ok(())
    }
    /// Metadata changes are durable at their native callback boundary. They do
    /// not hash the body, and a concurrent older flush reads these latest attrs
    /// only after sealing, so chmod/utimes cannot be overwritten by that flush.
    pub(crate) fn set_attributes(
        &self,
        node: &Arc<Node>,
        update: impl FnOnce(&mut Attributes) -> Result<(), KernelError>,
    ) -> Result<(), KernelError> {
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
        let mut state = lock(&node.state)?;
        let mut metadata = state.metadata.clone();
        let previous_change = metadata.attributes.changed;
        update(&mut metadata.attributes)?;
        metadata.attributes.validate()?;
        if metadata.attributes.changed == previous_change {
            metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
        }
        if metadata.attributes.file_id != metadata.binding.file_id {
            return Err(KernelError::Authorization(
                "Metadata update cannot replace its file identity".into(),
            ));
        }
        if let Some(path) = state.path.clone() {
            let (branch, actor, expected, selected) = (
                self.branch.clone(),
                self.grant.clone(),
                state.observed.clone(),
                metadata.clone(),
            );
            let observed=self.port.call(move |s|{
                s.admit_workspace_session(&branch,&path,&actor,true)?;
                s.filesystem_transaction(|s|{
                    let mut next:PathState=serde_json::from_value(expected["state"].clone())?;
                    match &mut next {
                        PathState::RegularFile{mode,..}=>*mode=selected.attributes.mode,
                        PathState::Directory{mode}|PathState::Symlink{mode,..}=>*mode=Some(selected.attributes.mode),
                        _=>{},
                    }
                    if !path.is_empty() && serde_json::to_value(&next)?!=expected["state"] {
                        let mut input=json!({"operationId":format!("workspace-attributes:{}",Uuid::new_v4()),"branchId":branch,"changes":[{"path":path,"expectedNode":expected["node"],"expectedState":expected["state"],"state":next}]});
                        // Chmod preserves directory children. Cached ancestor
                        // hashes can legitimately change after any child write.
                        if next.is_directory(){input["changes"][0].as_object_mut().unwrap().remove("expectedNode");}
                        if s.branch_path_apply(&input,&actor.grant_id)?["status"]!="committed"{return Err(failure("namespace_conflict","File changed while setting attributes"));}
                    }
                    s.save_workspace_metadata(&branch,&path,&selected,&actor)?;
                    s.branch_path_inspect(&json!({"branchId":branch,"path":path}))
                })
            })?;
            state.observed = observed;
        }
        state.metadata = metadata;
        state.metadata_generation = state.metadata_generation.wrapping_add(1);
        state.clean_metadata_generation = state.metadata_generation;
        Ok(())
    }
    pub(crate) fn flush_all(&self) -> Result<(), KernelError> {
        self.active()?;
        let nodes = lock(&self.namespace)?
            .dirty
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for node in nodes {
            self.flush(&node)?;
        }
        Ok(())
    }
    pub(crate) fn create(
        &self,
        requested: &str,
        state: PathState,
    ) -> Result<Arc<Node>, KernelError> {
        self.create_with_attributes(requested, state, |_| Ok(()))
    }
    pub(crate) fn create_with_attributes(
        &self,
        requested: &str,
        mut state: PathState,
        configure: impl FnOnce(&mut Attributes) -> Result<(), KernelError>,
    ) -> Result<Arc<Node>, KernelError> {
        let mut metadata = Storage::new_workspace_metadata(&state);
        configure(&mut metadata.attributes)?;
        metadata.attributes.validate()?;
        if metadata.attributes.file_id != metadata.binding.file_id {
            return Err(KernelError::Authorization(
                "Creation cannot replace its file identity".into(),
            ));
        }
        match &mut state {
            PathState::Directory { mode } | PathState::Symlink { mode, .. } => {
                *mode = Some(metadata.attributes.mode)
            }
            _ => {
                return Err(failure(
                    "namespace_not_directory",
                    "Use native file creation for a regular file",
                ))
            }
        }
        let requested = path(requested)?;
        if requested.is_empty() {
            return Err(failure("namespace_exists", "Workspace root already exists"));
        }
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        let mut namespace = lock(&self.namespace)?;
        if !self
            .load(&mut namespace, parent(&requested))?
            .state()?
            .is_directory()
        {
            return Err(failure(
                "namespace_not_directory",
                "Parent is not a directory",
            ));
        }
        let before = self.observe(&requested, true)?;
        if before["state"]["kind"] != "missing" {
            return Err(failure(
                "namespace_exists",
                "File or directory already exists",
            ));
        }
        let (branch, actor, selected) =
            (self.branch.clone(), self.grant.clone(), requested.clone());
        let operation = format!("workspace-create:{}", Uuid::new_v4());
        self.port.call(move |storage| {
            storage.admit_workspace_session(&branch, &selected, &actor, true)?;
            let input = json!({"operationId":operation,"workspaceId":actor.owning_workspace,"branchId":branch,"changes":[{"path":selected,"expectedState":before["state"],"state":state}]});
            let result = super::operations::idempotent(storage, "workspace.namespace.create", &input, |s| {
                let result=s.branch_path_apply(&input, &actor.grant_id)?;
                if result["status"]=="committed"{s.save_workspace_metadata(&branch,&selected,&metadata,&actor)?;}
                Ok(result)
            })?;
            if result["status"] != "committed" { return Err(failure("namespace_conflict", "Create target changed")); }
            Ok(())
        })?;
        let node = self.load(&mut namespace, &requested)?;
        self.touch_parent(&mut namespace, &requested)?;
        Ok(node)
    }
    pub(crate) fn create_file(&self, requested: &str, mode: u32) -> Result<Arc<Node>, KernelError> {
        self.create_file_with_attributes(requested, mode, |_| Ok(()))
    }
    pub(crate) fn create_file_with_attributes(
        &self,
        requested: &str,
        mode: u32,
        configure: impl FnOnce(&mut Attributes) -> Result<(), KernelError>,
    ) -> Result<Arc<Node>, KernelError> {
        // The empty object is shared like any other content object. Installing
        // it uses a worker before the namespace transaction, never a tree copy.
        let requested = path(requested)?;
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.active()?;
        let mut namespace = lock(&self.namespace)?;
        if requested.is_empty() {
            return Err(failure("namespace_exists", "Workspace root already exists"));
        }
        if !self
            .load(&mut namespace, parent(&requested))?
            .state()?
            .is_directory()
        {
            return Err(failure(
                "namespace_not_directory",
                "Parent is not a directory",
            ));
        }
        let (branch, selected, actor, revoked) = (
            self.branch.clone(),
            requested.clone(),
            self.grant.clone(),
            self.revoked.clone(),
        );
        let (content, observed) = self.port.call(move |storage| {
            storage.admit_workspace_session(&branch, &selected, &actor, true)?;
            let result = storage.open_private_file(&branch, &selected, &actor, revoked)?;
            if result.1["state"]["kind"] != "missing" {
                return Err(failure("namespace_exists", "File already exists"));
            }
            Ok(result)
        })?;
        let sealed = content
            .snapshot()?
            .seal(&self.root.join("staging"), &self.revoked)?;
        let (retention, sealed) = self
            .port
            .call(move |s| Ok((s.retain_private_file(&sealed), sealed)))?;
        let installed = sealed.install(&self.root, retention, &self.revoked)?;
        let mut metadata = Storage::new_workspace_metadata(&installed.state(mode));
        configure(&mut metadata.attributes)?;
        metadata.attributes.validate()?;
        if metadata.attributes.file_id != metadata.binding.file_id {
            return Err(KernelError::Authorization(
                "Creation cannot replace its file identity".into(),
            ));
        }
        let (branch, selected, actor, file, expected) = (
            self.branch.clone(),
            requested.clone(),
            self.grant.clone(),
            content.clone(),
            observed.clone(),
        );
        let receipt = self
            .port
            .call(move |s| {
                s.publish_private_file_metadata(
                    &format!("workspace-create:{}", Uuid::new_v4()),
                    &branch,
                    &selected,
                    &expected,
                    metadata.attributes.mode,
                    &file,
                    &installed,
                    &actor,
                    Some(&metadata),
                )
            })?
            .finish();
        if receipt["status"] != "committed" {
            return Err(failure("namespace_conflict", "Create target changed"));
        }
        let node = self.load(&mut namespace, &requested)?;
        lock(&node.content)?.open = Arc::downgrade(&content);
        self.touch_parent(&mut namespace, &requested)?;
        Ok(node)
    }
    pub(crate) fn remove(&self, requested: &str, directory: bool) -> Result<(), KernelError> {
        let requested = path(requested)?;
        if requested.is_empty() {
            return Err(failure(
                "namespace_root",
                "Cannot remove the workspace root",
            ));
        }
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        let mut namespace = lock(&self.namespace)?;
        let node = self.load(&mut namespace, &requested)?;
        let before = self.observe(&requested, true)?;
        let is_directory = before["state"]["kind"] == "directory";
        if directory != is_directory {
            return Err(failure(
                if is_directory {
                    "namespace_is_directory"
                } else {
                    "namespace_not_directory"
                },
                "Unlink kind does not match the entry",
            ));
        }
        if directory && !self.directory_page(&requested, None, 1)?.entries.is_empty() {
            return Err(failure("namespace_not_empty", "Directory is not empty"));
        }
        let (branch, actor, selected) =
            (self.branch.clone(), self.grant.clone(), requested.clone());
        self.port.call(move |s| {
            s.admit_workspace_session(&branch, &selected, &actor, true)?;
            let mut changes=vec![json!({"path":selected,"expectedState":before["state"],"expectedNode":before["node"],"state":{"kind":"missing"}})];
            if !parent(&selected).is_empty() {
                // Namespace unlink leaves the parent directory in existence.
                // An imported implicit ancestor otherwise looks like a delta
                // shell that branch restoration may prune with its last child.
                let parent=s.branch_path_inspect(&json!({"branchId":branch,"path":parent(&selected)}))?;
                changes.push(json!({"path":parent["path"],"expectedState":parent["state"],"state":parent["state"]}));
            }
            let input = json!({"operationId":format!("workspace-unlink:{}", Uuid::new_v4()),"workspaceId":actor.owning_workspace,"branchId":branch,"changes":changes});
            let receipt = super::operations::idempotent(s,"workspace.namespace.unlink",&input,|s|{
                let receipt=s.branch_path_apply(&input,&actor.grant_id)?;
                if receipt["status"]=="committed"{s.remove_workspace_metadata(&branch,&selected,&actor)?;}
                Ok(receipt)
            })?;
            if receipt["status"] != "committed" { return Err(failure("namespace_conflict", "Unlink target changed")); }
            Ok(())
        })?;
        {
            let mut state = lock(&node.state)?;
            state.path = None;
            state.metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
        }
        namespace.dirty.remove(&node.id);
        let retired = lock(&node.content)?.dirty.take();
        namespace.paths.remove(&requested);
        self.touch_parent(&mut namespace, &requested)?;
        drop(namespace);
        drop(_boundary);
        drop(retired);
        Ok(())
    }
    pub(crate) fn rename(&self, from: &str, to: &str, replace: bool) -> Result<(), KernelError> {
        let (from, to) = (path(from)?, path(to)?);
        if from.is_empty() || to.is_empty() {
            return Err(failure(
                "namespace_root",
                "Cannot rename the workspace root",
            ));
        }
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        let mut namespace = lock(&self.namespace)?;
        self.load(&mut namespace, &from)?;
        let replaced = namespace.paths.get(&to).cloned();
        let source = self.observe(&from, true)?;
        let target = self.observe(&to, true)?;
        let (branch, actor, a, b) = (
            self.branch.clone(),
            self.grant.clone(),
            from.clone(),
            to.clone(),
        );
        self.port.call(move |s| {
            s.admit_workspace_session(&branch, &a, &actor, true)?;
            s.admit_workspace_session(&branch, &b, &actor, true)?;
            require_capability(&actor,"branch.rename")?;
            let input = json!({"operationId":format!("workspace-rename:{}",Uuid::new_v4()),"workspaceId":actor.owning_workspace,"branchId":branch,"sourcePath":a,"path":b,
                "expectedSourceNode":source["node"],"expectedTargetNode":target["node"],"replace":replace});
            let receipt = super::operations::idempotent(s,"workspace.namespace.rename",&input,|s|{
                let receipt=s.branch_rename(&input)?;
                if receipt["status"]=="committed" && a!=b {
                    s.rename_workspace_metadata(&branch,&a,&b,&serde_json::from_value(source["state"].clone())?,&serde_json::from_value(target["state"].clone())?,&actor)?;
                }
                Ok(receipt)
            })?;
            if receipt["status"] != "committed" { return Err(failure("namespace_conflict", "Rename source or target changed")); }
            Ok(())
        })?;
        if from == to {
            return Ok(());
        }
        let mut retired = None;
        if let Some(replaced) = replaced {
            {
                let mut state = lock(&replaced.state)?;
                state.path = None;
                state.metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
            }
            namespace.dirty.remove(&replaced.id);
            retired = lock(&replaced.content)?.dirty.take();
        }
        let prefix = format!("{from}/");
        let affected = namespace
            .paths
            .range(from.clone()..)
            .take_while(|(key, _)| **key == from || key.starts_with(&prefix))
            .map(|(key, node)| (key.clone(), node.clone()))
            .collect::<Vec<_>>();
        for (old, node) in affected {
            let next = format!("{to}{}", &old[from.len()..]);
            let mut state = lock(&node.state)?;
            state.path = Some(next.clone());
            state.observed["path"] = json!(next);
            if old == from {
                state.metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
                state.metadata_generation = state.metadata_generation.wrapping_add(1);
                namespace.dirty.insert(node.id, node.clone());
            }
            drop(state);
            namespace.paths.remove(&old);
            namespace.paths.insert(next, node);
        }
        self.touch_parent(&mut namespace, &from)?;
        if parent(&from) != parent(&to) {
            self.touch_parent(&mut namespace, &to)?;
        }
        drop(namespace);
        drop(_boundary);
        drop(retired);
        Ok(())
    }
    pub(crate) fn directory_page(
        &self,
        requested: &str,
        cursor: Option<String>,
        count: usize,
    ) -> Result<super::branch_namespace::DirectoryPage, KernelError> {
        self.active()?;
        let (branch, requested, actor) =
            (self.branch.clone(), path(requested)?, self.grant.clone());
        self.port.call(move |s| {
            s.read_branch_directory(&branch, &requested, None, cursor.as_deref(), count, &actor)
        })
    }
    pub(crate) fn directory_after(
        &self,
        requested: &str,
        after: Option<String>,
        count: usize,
    ) -> Result<super::branch_namespace::DirectoryPage, KernelError> {
        self.active()?;
        let (branch, requested, actor) =
            (self.branch.clone(), path(requested)?, self.grant.clone());
        self.port.call(move |s| {
            s.admit_workspace_session(&branch,&requested,&actor,false)?;
            let cursor=after.map(|after|->Result<String,KernelError> {
                let observed=s.branch_path_inspect(&json!({"branchId":branch,"path":requested}))?;
                Ok(BASE64.encode(serde_json::to_vec(&json!({"branchId":branch,"path":requested,"node":observed["node"],"after":after}))?))
            }).transpose()?;
            s.read_branch_directory(&branch,&requested,None,cursor.as_deref(),count,&actor)
        })
    }
    /// This boundary covers writes already delivered by a native backend. Its
    /// caller must first complete that backend's cache/mmap flush fence.
    pub(crate) fn checkpoint(&self) -> Result<Checkpoint, KernelError> {
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.active()?;
        let namespace = lock(&self.namespace)?;
        let mut files = Vec::new();
        let mut metadata = Vec::new();
        for node in namespace.dirty.values() {
            let state = lock(&node.state)?;
            if let Some(path) = &state.path {
                if state.metadata_generation != state.clean_metadata_generation {
                    metadata.push((path.clone(), state.metadata.clone()));
                }
            }
            drop(state);
            if let Some(file) = node.file()? {
                let snapshot = file.snapshot()?;
                let state = lock(&node.state)?;
                if snapshot.generation() != state.clean_generation {
                    let mode = state.metadata.attributes.mode;
                    if let Some(path) = &state.path {
                        files.push((path.clone(), mode, snapshot));
                    }
                }
            }
        }
        let (branch, actor, pin) = (
            self.branch.clone(),
            self.grant.clone(),
            format!("workspace-boundary:{}", Uuid::new_v4()),
        );
        let pinned = pin.clone();
        let metadata_pin = format!("{pin}:filesystem");
        let pinned_metadata = metadata_pin.clone();
        let metadata_head = self.port.call(move |s| {
            s.admit_workspace_session(&branch, "", &actor, false)?;
            require_capability(&actor, "branch.pin")?;
            s.filesystem_transaction(|s| {
                let data=s.branch(&branch)?;
                s.branch_pin(
                    &json!({"branchId":branch,"pinId":pinned,"expectedRoot":data.head_root,"expectedWriteRevision":data.write_revision}),
                    true,
                    &actor.grant_id,
                )?;
                let head = s.workspace_metadata_head(&branch, &actor)?;
                let metadata=s.branch(&head.metadata_branch)?;
                s.branch_pin(
                    &json!({"branchId":head.metadata_branch,"pinId":pinned_metadata,"expectedRoot":metadata.head_root,"expectedWriteRevision":metadata.write_revision}),
                    true,
                    &actor.grant_id,
                )?;
                Ok(head)
            })
        })?;
        Ok(Checkpoint {
            port: self.port.clone(),
            source_branch: self.branch.clone(),
            workspace: self.workspace.clone(),
            grant: self.grant.clone(),
            root: self.root.clone(),
            pin,
            metadata_pin,
            metadata_head,
            metadata,
            files,
            released: false,
        })
    }
    /// Only call after all native callbacks and process handles have drained.
    /// Errors leave the live session usable for retry, rather than discarding data.
    pub(crate) fn close(&self) -> Result<(), KernelError> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        self.flush_all()?;
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        let mut namespace = lock(&self.namespace)?;
        let mut clean = Vec::new();
        for (id, node) in &namespace.dirty {
            if let Some(content) = node.file()? {
                let state = lock(&node.state)?;
                if content.snapshot()?.generation() == state.clean_generation
                    && state.metadata_generation == state.clean_metadata_generation
                {
                    clean.push(*id);
                }
            } else if {
                let state = lock(&node.state)?;
                state.metadata_generation == state.clean_metadata_generation
            } {
                clean.push(*id);
            }
        }
        let mut retired = Vec::new();
        for id in clean {
            if let Some(node) = namespace.dirty.remove(&id) {
                if let Some(file) = lock(&node.content)?.dirty.take() {
                    retired.push(file);
                }
            }
        }
        if !namespace.dirty.is_empty() {
            drop(namespace);
            drop(_boundary);
            drop(retired);
            return Err(failure("workspace_still_writing","Workspace received new writes during close; original data and session remain available"));
        }
        // A normal detach closes this session's I/O, not the original grant or
        // already-retained checkpoint ranges. Those may outlive their mount.
        self.closed.store(true, Ordering::Release);
        drop(namespace);
        drop(_boundary);
        drop(retired);
        Ok(())
    }
}
impl Checkpoint {
    /// Complete a fork on a finite worker. Parent writes and unrelated Storage
    /// requests continue throughout hashing and installation. Publication of all
    /// dirty files and the target root is one original Storage transaction.
    pub(crate) fn fork(
        &self,
        target: &str,
        operation: &str,
        cancelled: &AtomicBool,
    ) -> Result<Value, KernelError> {
        let mut installed = Vec::new();
        for (path, mode, snapshot) in &self.files {
            let sealed = snapshot.seal(&self.root.join("staging"), cancelled)?;
            let (retention, sealed) = self
                .port
                .call(move |s| Ok((s.retain_private_file(&sealed), sealed)))?;
            installed.push((
                path.clone(),
                *mode,
                sealed.install(&self.root, retention, cancelled)?,
            ));
        }
        let (source, pin, workspace, actor, target, operation) = (
            self.source_branch.clone(),
            self.pin.clone(),
            self.workspace.clone(),
            self.grant.clone(),
            target.to_owned(),
            operation.to_owned(),
        );
        let metadata_head = self.metadata_head.clone();
        let metadata_pin = self.metadata_pin.clone();
        let metadata = self.metadata.clone();
        self.port.call(move |s| {
            s.publish_workspace_checkpoint(
                &source,
                &pin,
                &workspace,
                &target,
                &operation,
                &installed,
                &actor,
                &metadata_head,
                &metadata_pin,
                &metadata,
            )
        })
    }
    pub(crate) fn release(mut self) -> Result<(), KernelError> {
        let (branch, pin, actor) = (
            self.source_branch.clone(),
            self.pin.clone(),
            self.grant.clone(),
        );
        let metadata_branch = self.metadata_head.metadata_branch.clone();
        let metadata_pin = self.metadata_pin.clone();
        self.port.call(move |s| {
            s.filesystem_transaction(|s| {
                s.branch_pin(
                    &json!({"branchId":metadata_branch,"pinId":metadata_pin}),
                    false,
                    &actor.grant_id,
                )?;
                s.branch_pin(
                    &json!({"branchId":branch,"pinId":pin}),
                    false,
                    &actor.grant_id,
                )
                .map(|_| ())
            })
        })?;
        self.released = true;
        Ok(())
    }
}
impl Drop for Checkpoint {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let (branch, pin, actor) = (
            self.source_branch.clone(),
            self.pin.clone(),
            self.grant.clone(),
        );
        let metadata_branch = self.metadata_head.metadata_branch.clone();
        let metadata_pin = self.metadata_pin.clone();
        // Drop never waits on control: native backend teardown may be running
        // during drainage. The original grant still owns a failed release.
        let _ = (self.port.0)(Box::new(move |storage| {
            if let Some(s) = storage {
                let _ = s.filesystem_transaction(|s| {
                    s.branch_pin(
                        &json!({"branchId":metadata_branch,"pinId":metadata_pin}),
                        false,
                        &actor.grant_id,
                    )?;
                    s.branch_pin(
                        &json!({"branchId":branch,"pinId":pin}),
                        false,
                        &actor.grant_id,
                    )
                    .map(|_| ())
                });
            }
        }));
    }
}

impl Storage {
    pub(super) fn admit_workspace_branch_request(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<(), KernelError> {
        // The sidecar root is an internal typed metadata graph, never a user
        // file branch. Public branch writes must not replace encoded ACL/xattr
        // values or delete a still-owned metadata root through another method.
        let mut selected = vec![];
        for field in ["branchId", "sourceBranchId"] {
            if let Some(id) = params[field].as_str() {
                selected.push(id.to_owned());
            }
        }
        for field in ["pinId", "sourcePinId"] {
            if let Some(id) = params[field].as_str() {
                if let Some(branch) = self
                    .conn
                    .query_row(
                        "SELECT branch_id FROM pins WHERE pin_id=?1",
                        params![id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                {
                    selected.push(branch);
                }
            }
        }
        if let Some(builder) = params["builderId"]
            .as_str()
            .and_then(|id| self.branch_write_builders.get(id))
        {
            selected.push(builder.branch_id.clone());
        }
        for branch in selected {
            if branch
                .strip_prefix("workspace-metadata:")
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
            {
                return Err(KernelError::Authorization(
                    "Filesystem metadata is accessed through its original native workspace owner"
                        .into(),
                ));
            }
        }
        let current_boundary = matches!(
            method,
            "branch.write"
                | "branch.write.begin"
                | "branch.write.finish"
                | "branch.path.apply"
                | "branch.rename"
                | "branch.publish"
                | "branch.delete"
        ) || (method == "branch.pin" && params["revision"].is_null());
        let branch = if method == "branch.write.finish" {
            params["builderId"]
                .as_str()
                .and_then(|id| self.branch_write_builders.get(id))
                .map(|builder| builder.branch_id.as_str())
        } else if method == "branch.fork" && params["sourcePinId"].is_null() {
            params["sourceBranchId"].as_str()
        } else if current_boundary {
            params["branchId"].as_str()
        } else {
            None
        };
        if branch
            .and_then(|branch| self.workspace_sessions.get(branch))
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|session| session.active().is_ok())
        {
            return Err(failure("workspace_live_boundary_required","This branch has an active native file session; use that session for writes and cache-fenced version boundaries"));
        }
        Ok(())
    }
    fn admit_workspace_session(
        &self,
        branch: &str,
        path: &str,
        original: &Grant,
        write: bool,
    ) -> Result<(), KernelError> {
        let grant = self.load_grant(&original.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != original.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "workspace session's original grant is no longer active".into(),
            ));
        }
        if grant.owning_workspace.as_deref() != Some(&self.branch(branch)?.workspace_id)
            || !path_metadata_allowed_scopes(&grant.path_scopes, path)
            || (write && !path_allowed(&grant, path))
        {
            return Err(KernelError::Authorization(
                "workspace session path is outside its original source".into(),
            ));
        }
        require_capability(
            &grant,
            if write {
                "branch.path.apply"
            } else {
                "branch.read"
            },
        )
    }
}
