//! The native filesystem session shared by OS callbacks. Metadata is admitted by
//! the existing Storage owner; range I/O never takes the control thread or wire.
use super::workspace_files::{FileSnapshot, PrivateFile, SealedFile, InstalledFile};
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
    /// Loaded names of this inode. All hard-link names share one byte handle.
    aliases: BTreeMap<String, Value>,
    link_count: usize,
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
    pub(crate) fn link_count(&self) -> Result<u32, KernelError> {
        let state = lock(&self.state)?;
        Ok(if state.path.is_none() {
            0
        } else {
            u32::try_from(state.link_count).unwrap_or(u32::MAX)
        })
    }
    pub(crate) fn path(&self) -> Result<Option<String>, KernelError> {
        Ok(lock(&self.state)?.path.clone())
    }
}

struct Namespace {
    paths: BTreeMap<String, Arc<Node>>,
    inodes: HashMap<Uuid, std::sync::Weak<Node>>,
    numbers: HashMap<Uuid, u64>,
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
    mount_state: std::sync::atomic::AtomicU8,
    native_idle: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Namespace mutations use the exclusive boundary. A flush owns only its
    /// file publication lock during range persistence, and joins the shared boundary for
    /// its short metadata commit. Checkpoints never acquire publication locks.
    boundary: RwLock<()>,
    namespace: Mutex<Namespace>,
}

/// Owns a frozen namespace and only the dirty file range maps at its boundary.
/// Parent writes continue while a worker hashes/installs these individual files.
pub(crate) struct Checkpoint {
    session_id: Uuid,
    selected_scope: String,
    port: StoragePort,
    source_branch: String,
    workspace: String,
    grant: Grant,
    root: PathBuf,
    pin: String,
    base_pin: String,
    metadata_pin: String,
    metadata_head: Head,
    branch: BranchRow,
    metadata: Vec<(String, Metadata)>,
    files: Vec<(Vec<String>, u32, FileSnapshot)>,
    released: bool,
}

impl Session {
    pub(crate) fn storage_port(&self)->StoragePort{self.port.clone()}
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
            let root_inode = metadata.binding.file_id;
            let root_node = Arc::new(Node {
                id: 1,
                session: id,
                state: Mutex::new(NodeState {
                    path: Some(String::new()),
                    observed,
                    aliases: BTreeMap::new(),
                    link_count: 1,
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
                native_idle: Mutex::new(None),
                mount_state:std::sync::atomic::AtomicU8::new(0),
                boundary: RwLock::new(()),
                namespace: Mutex::new(Namespace {
                    paths: BTreeMap::from([(String::new(), root_node)]),
                    inodes: HashMap::new(),
                    numbers: HashMap::from([(root_inode, 1)]),
                    dirty: BTreeMap::new(),
                    next_id: 2,
                }),
            });
            // FUSE always reserves inode 1 for the root. Admission and reuse
            // happen on Storage, so two callers cannot invent parallel caches.
            storage
                .workspace_sessions
                .insert(branch, Arc::downgrade(&session));
            let root = session
                .namespace
                .lock()
                .map_err(|_| KernelError::Storage("workspace namespace lock poisoned".into()))?
                .paths
                .get("")
                .cloned()
                .expect("root inode");
            session
                .namespace
                .lock()
                .map_err(|_| KernelError::Storage("workspace namespace lock poisoned".into()))?
                .inodes
                .insert(root_inode, Arc::downgrade(&root));
            Ok(session)
        })
    }
    pub(super) fn active(&self) -> Result<(), KernelError> {
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
    pub(crate) fn on_native_idle(&self, notify: Arc<dyn Fn() + Send + Sync>) {
        *self
            .native_idle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(notify);
    }
    pub(crate) fn mount_started(&self){self.mount_state.store(1,Ordering::Release);}
    pub(crate) fn mount_disconnected(&self){self.mount_state.store(2,Ordering::Release);self.notify_native_idle();}
    pub(crate) fn is_mount_disconnected(&self)->bool{self.mount_state.load(Ordering::Acquire)==2}
    pub(crate) fn check_mounted(&self)->Result<(),KernelError>{
        self.active()?;
        if self.is_mount_disconnected(){return Err(failure("workspace_mount_disconnected","The original native filesystem dispatcher stopped; reopen its saved workspace"));}
        Ok(())
    }
    pub(crate) fn notify_native_idle(&self) {
        let notify = self
            .native_idle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(notify) = notify {
            notify();
        }
    }
    pub(crate) fn revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }
    /// An execution lease never replaces the project filesystem's owner. Check
    /// its own current grant before exposing any view or choosing a boundary.
    pub(crate) fn admit(
        &self,
        grant: &Grant,
        requested: &str,
        write: bool,
    ) -> Result<(), KernelError> {
        self.active()?;
        let (branch, grant, selected) = (self.branch.clone(), grant.clone(), path(requested)?);
        self.port
            .call(move |storage| storage.admit_workspace_session(&branch, &selected, &grant, write))
    }
    pub(crate) fn owned_by(&self, grant: &str) -> bool {
        self.grant.grant_id == grant
    }
    pub(crate) fn identity(&self) -> Uuid {
        self.id
    }
    pub(crate) fn owner(&self)->Grant {self.grant.clone()}
    pub(crate) fn assert_consumers_idle(&self) -> Result<(), KernelError> {
        let branch = self.branch.clone();
        let generation = self.id.to_string();
        self.port.call(move |storage| {
            storage.assert_native_source_idle(&branch, &generation)?;
            storage.native_closing_roots.insert((branch,generation));
            Ok(())
        })
    }
    pub(crate) fn replayed_fork(
        &self,
        operation: &str,
        target: &str,
        selected: &str,
        requester: Grant,
    ) -> Result<Option<Value>, KernelError> {
        let selected = path(selected)?;
        self.admit(&requester, &selected, true)?;
        let (operation, target, branch, session, grant) = (
            operation.to_owned(),
            target.to_owned(),
            self.branch.clone(),
            self.id,
            self.grant.clone(),
        );
        self.port.call(move |storage| {
            storage.replay_workspace_fork(
                &operation, &branch, &target, &selected, session, &grant, &requester,
            )
        })
    }
    pub(crate) fn replayed_result(
        &self,
        publication: &str,
        grant: Grant,
    ) -> Result<Option<Value>, KernelError> {
        self.admit(&grant, "", true)?;
        let (publication, branch, session) = (publication.to_owned(), self.branch.clone(), self.id);
        self.port.call(move |storage| {
            storage.replay_workspace_result(&publication, &branch, session, &grant)
        })
    }
    pub(crate) fn lease_count(&self) -> Result<usize, KernelError> {
        self.leases(&self.grant, None)
    }
    pub(crate) fn leases(
        &self,
        grant: &Grant,
        lease: Option<(&str, bool)>,
    ) -> Result<usize, KernelError> {
        self.active()?;
        let (branch, grant) = (self.branch.clone(), grant.clone());
        let lease = lease.map(|(id, release)| (id.to_owned(), release));
        let project_owner = self.grant.grant_id.clone();
        self.port.call(move |storage| {
            storage.admit_workspace_session(&branch, "", &grant, false)?;
            if grant.grant_id == project_owner {
                // Revoke requests retain their lease until the actual resource
                // owners stop. Release those completed lifetimes on observation,
                // so a revoked Run cannot leave a permanent project holder.
                let holders = storage.workspace_holders.iter().filter(|(_, (selected, _))| selected == &branch)
                    .map(|(id, (_, owner))| (id.clone(), owner.clone())).collect::<Vec<_>>();
                for (id, owner) in holders {
                    if storage.load_grant(&owner)?.state != crate::model::GrantState::Active {
                        match storage.assert_workspace_grant_idle(&owner) {
                            Ok(()) => { storage.workspace_holders.remove(&id); }
                            Err(KernelError::Execution(error)) if error.code == "workspace_in_use" => {},
                            Err(error) => return Err(error),
                        }
                    }
                }
            }
            if let Some((id, release)) = lease {
                if id.is_empty() { return Err(failure("workspace_lease_invalid", "Workspace lease identity is required")); }
                if let Some((original_branch, owner)) = storage.workspace_holders.get(&id) {
                    if original_branch != &branch || owner != &grant.grant_id {
                        return Err(failure("workspace_lease_owner_changed", "Workspace lease belongs to another original workspace or execution authority"));
                    }
                }
                if release {
                    // A cancellation request is not a stopped process. Consult
                    // the same native Process owner used by grant retirement.
                    storage.assert_workspace_grant_idle(&grant.grant_id)?;
                    storage.workspace_holders.remove(&id);
                } else { storage.workspace_holders.insert(id, (branch.clone(), grant.grant_id)); }
            }
            Ok(storage.workspace_holders.values().filter(|(selected, _)| selected == &branch).count())
        })
    }
    pub(crate) fn release_drained_leases(&self) -> Result<(), KernelError> {
        if !self.closed.load(Ordering::Acquire) {
            return Err(failure(
                "workspace_in_use",
                "Native callbacks have not finished closing",
            ));
        }
        let branch = self.branch.clone();
        let generation=self.id.to_string();
        self.port.call(move |storage| {
            storage
                .workspace_holders
                .retain(|_, (selected, _)| selected != &branch);
            let roots=storage.native_file_roots.iter().filter(|(_, (selected,epoch,_))|selected==&branch&&epoch==&generation).map(|(id,_)|id.clone()).collect::<Vec<_>>();
            for id in roots{storage.file_roots.remove(&id);storage.native_file_roots.remove(&id);storage.native_readers.lock().map_err(|_|KernelError::Storage("Native reader registry failed".into()))?.remove(&id);}
            storage.native_closing_roots.remove(&(branch,generation));
            Ok(())
        })
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
        let (observed, metadata, count) = self.port.call(move |s| {
            s.admit_workspace_session(&branch, &selected, &actor, false)?;
            let observed = s.branch_path_inspect(&json!({"branchId":branch,"path":selected}))?;
            let state = serde_json::from_value(observed["state"].clone())?;
            let metadata = s.read_workspace_metadata(&branch, &selected, &state, &actor)?;
            let count = if matches!(state, PathState::RegularFile { .. }) {
                s.workspace_file_link_count(&branch, metadata.binding.file_id, &actor)?
            } else {
                1
            };
            Ok((observed, metadata, count))
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
        if let Some(existing) = namespace
            .inodes
            .get(&metadata.binding.file_id)
            .and_then(std::sync::Weak::upgrade)
        {
            let mut selected = lock(&existing.state)?;
            if !matches!(state, PathState::RegularFile { .. })
                || selected.observed["state"] != observed["state"]
                || selected.path.is_none()
            {
                return Err(KernelError::Storage(
                    "workspace inode identity has incompatible namespace entries".into(),
                ));
            }
            selected.aliases.insert(path.to_owned(), observed);
            selected.link_count = count;
            drop(selected);
            namespace.paths.insert(path.into(), existing.clone());
            return Ok(existing);
        }
        let inode = metadata.binding.file_id;
        let number = if let Some(number) = namespace.numbers.get(&inode) {
            *number
        } else {
            let number = namespace.next_id;
            namespace.next_id = number.checked_add(1).ok_or_else(|| {
                failure(
                    "namespace_identity_exhausted",
                    "Native file identity space exhausted",
                )
            })?;
            namespace.numbers.insert(inode, number);
            number
        };
        let node = Arc::new(Node {
            id: number,
            session: self.id,
            state: Mutex::new(NodeState {
                path: Some(path.into()),
                observed: observed.clone(),
                aliases: BTreeMap::from([(path.to_owned(), observed)]),
                link_count: count,
                clean_generation: 0,
                metadata,
                metadata_generation: 0,
                clean_metadata_generation: 0,
            }),
            content: Mutex::new(ContentSlot::default()),
            publication: Mutex::new(()),
        });
        namespace.paths.insert(path.into(), node.clone());
        namespace.inodes.insert(inode, Arc::downgrade(&node));
        Ok(node)
    }
    /// Caller holds a shared namespace boundary. Metadata lookup/stat never
    /// opens a body: only an actual native open or byte operation retains it.
    fn content_locked(&self, node: &Node) -> Result<Arc<PrivateFile>, KernelError> {
        if lock(&node.state)?.observed["state"]["kind"] != "regular-file" {
            return Err(failure(
                "namespace_not_file",
                "Native byte I/O requires a regular file",
            ));
        }
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
    /// Release a clean lookup cache only after native references have ended.
    /// Dirty data, open handles and concurrently returned nodes retain it. The
    /// small inode number map preserves native identity across cache eviction.
    pub(crate) fn forget_cached(&self, node: &Arc<Node>) -> Result<(), KernelError> {
        if node.id == 1 {
            return Ok(());
        }
        let _boundary = self
            .boundary
            .read()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        let mut namespace = lock(&self.namespace)?;
        if namespace.dirty.contains_key(&node.id) {
            return Ok(());
        }
        let state = lock(&node.state)?;
        let mut names = state.aliases.keys().cloned().collect::<BTreeSet<_>>();
        if let Some(path) = &state.path {
            names.insert(path.clone());
        }
        let cached = names
            .iter()
            .filter(|name| {
                namespace
                    .paths
                    .get(*name)
                    .is_some_and(|cached| Arc::ptr_eq(cached, node))
            })
            .count();
        if Arc::strong_count(node) != cached + 1 {
            return Ok(());
        }
        let inode = state.metadata.binding.file_id;
        drop(state);
        for name in names {
            if namespace
                .paths
                .get(&name)
                .is_some_and(|cached| Arc::ptr_eq(cached, node))
            {
                namespace.paths.remove(&name);
            }
        }
        namespace.inodes.remove(&inode);
        Ok(())
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
        let installed = snapshot.freeze(&self.root, &self.port, &self.revoked)?;
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
                false,
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
        let mut aliases = BTreeMap::new();
        for path in state.aliases.keys() {
            let mut observed = state.observed.clone();
            observed["path"] = json!(path);
            aliases.insert(path.clone(), observed);
        }
        state.aliases = aliases;
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
    /// only after freezing, so chmod/utimes cannot be overwritten by that flush.
    pub(crate) fn set_attributes(
        &self,
        node: &Arc<Node>,
        update: impl FnOnce(&mut Attributes) -> Result<(), KernelError>,
    ) -> Result<(), KernelError> {
        self.set_attributes_inner(node, update, true)
    }
    /// Source import preserves the observed change time; ordinary chmod/utimes
    /// still advance it. The caller cannot replace this workspace's inode ID.
    pub(crate) fn import_attributes(
        &self,
        node: &Arc<Node>,
        mut attributes: Attributes,
    ) -> Result<(), KernelError> {
        self.set_attributes_inner(
            node,
            |current| {
                attributes.file_id = current.file_id;
                *current = attributes;
                Ok(())
            },
            false,
        )
    }
    /// Standard Windows symbolic links/junctions change the existing empty
    /// inode, rather than replacing its native handle or copying a workspace.
    pub(crate) fn set_reparse_data(
        &self,
        node: &Arc<Node>,
        data: Option<Vec<u8>>,
    ) -> Result<(), KernelError> {
        let parsed = data
            .as_deref()
            .map(crate::reparse_data::parse)
            .transpose()?;
        self.owns(node)?;
        self.flush(node)?;
        let empty = if data.is_none() {
            let cleanup = self.port.call(|s| Ok(s.private_cleanup.clone()))?;
            let sealed = FileSnapshot::empty(self.revoked.clone(), cleanup)
                .seal(&self.root.join("staging"), &self.revoked)?;
            let (retained, sealed) = self
                .port
                .call(move |s| Ok((s.retain_private_file(&sealed), sealed)))?;
            Some(sealed.install(&self.root, retained, &self.revoked)?)
        } else {
            None
        };
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
        let mut namespace = lock(&self.namespace)?;
        let mut state = lock(&node.state)?;
        let path = state
            .path
            .clone()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                failure(
                    "workspace_reparse_invalid",
                    "An unlinked inode or workspace root cannot change reparse type",
                )
            })?;
        if state.link_count != 1 {
            return Err(failure(
                "workspace_reparse_hardlinks",
                "A reparse inode must have one namespace name in this backend",
            ));
        }
        let original: PathState = serde_json::from_value(state.observed["state"].clone())?;
        let directory = original.is_directory()
            || matches!(original, PathState::Symlink { .. })
                && state.metadata.attributes.windows_attributes & 0x10 != 0;
        if parsed.is_none() && !matches!(original, PathState::Symlink { .. }) {
            return Err(failure(
                "workspace_not_reparse",
                "The inode has no reparse point",
            ));
        }
        if let PathState::RegularFile { byte_length, .. } = original {
            let length = node
                .file()?
                .map(|file| file.snapshot().map(|snapshot| snapshot.byte_length()))
                .transpose()?
                .unwrap_or(byte_length);
            if length != 0 {
                return Err(failure("workspace_reparse_nonempty","This backend cannot hide existing file bytes behind a reparse point; the original bytes were retained"));
            }
        }
        let target = if let Some(parsed) = parsed {
            PathState::Symlink {
                symlink_target: parsed.target,
                mode: Some(state.metadata.attributes.mode),
            }
        } else if directory {
            PathState::Directory {
                mode: Some(state.metadata.attributes.mode),
            }
        } else {
            empty
                .as_ref()
                .expect("regular empty object prepared")
                .state(state.metadata.attributes.mode)
        };
        let mut metadata = state.metadata.clone();
        metadata.attributes.reparse_data = data;
        if metadata.attributes.reparse_data.is_some() {
            metadata.attributes.windows_attributes |= 0x400;
        } else {
            metadata.attributes.windows_attributes &= !0x400;
        }
        if target.is_directory() {
            metadata.directory_origin();
        }
        metadata.attributes.touch();
        let (branch, actor, expected, selected, target_path) = (
            self.branch.clone(),
            self.grant.clone(),
            state.observed.clone(),
            metadata.clone(),
            path.clone(),
        );
        let observed=self.port.call(move|s|{
            s.admit_workspace_session(&branch,&target_path,&actor,true)?;
            s.filesystem_transaction(|s|{
                if original.is_directory(){
                    let page=s.read_branch_directory(&branch,&target_path,None,None,1,&actor)?;
                    if !page.entries.is_empty(){return Err(failure("namespace_not_empty","A reparse directory must be empty"));}
                }
                let operation=format!("workspace-reparse:{}",Uuid::new_v4());
                let mut change=json!({"path":target_path,"expectedState":expected["state"],"expectedNode":expected["node"],"state":target});
                if let Some(empty)=empty.as_ref().filter(|_|matches!(target,PathState::RegularFile{..})){
                    let PathState::RegularFile{object_hash,..}=empty.state(selected.attributes.mode) else{unreachable!()};
                    s.conn.execute("INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,0)",params![object_hash])?;
                    let owner=blob_owner_id(&operation);
                    s.record_object_owner(&owner,&object_hash,Some(&s.branch(&branch)?.workspace_id),Some(&operation),&actor.grant_id)?;
                    change["ownerId"]=json!(owner);
                }
                let result=s.branch_path_apply(&json!({"operationId":operation,"branchId":branch,"changes":[change]}),&actor.grant_id)?;
                if result["status"]!="committed"{return Err(failure("namespace_conflict","The reparse inode changed before publication"));}
                s.save_workspace_metadata(&branch,&target_path,&selected,&actor)?;
                s.branch_path_inspect(&json!({"branchId":branch,"path":target_path}))
            })
        })?;
        state.observed = observed.clone();
        state.aliases = BTreeMap::from([(path, observed)]);
        state.metadata = metadata;
        state.metadata_generation = state.metadata_generation.wrapping_add(1);
        state.clean_metadata_generation = state.metadata_generation;
        namespace.dirty.remove(&node.id);
        lock(&node.content)?.dirty = None;
        Ok(())
    }
    fn set_attributes_inner(
        &self,
        node: &Arc<Node>,
        update: impl FnOnce(&mut Attributes) -> Result<(), KernelError>,
        advance_changed: bool,
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
        if advance_changed && metadata.attributes.changed == previous_change {
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
                        let paths=if matches!(next,PathState::RegularFile{..}){
                            s.workspace_file_links(&branch,selected.binding.file_id,Some(&path),&actor)?
                        }else{vec![path.clone()]};
                        let mut changes=Vec::with_capacity(paths.len());
                        for alias in paths {
                            s.admit_workspace_session(&branch,&alias,&actor,true)?;
                            let original=if alias==path{expected.clone()}else{s.branch_path_inspect(&json!({"branchId":branch,"path":alias}))?};
                            if original["state"]!=expected["state"]{return Err(failure("namespace_conflict","Hard-link attributes differ between names"));}
                            let mut change=json!({"path":alias,"expectedNode":original["node"],"expectedState":original["state"],"state":next});
                            // Chmod preserves directory children. Cached ancestor
                            // hashes can legitimately change after any child write.
                            if next.is_directory(){change.as_object_mut().unwrap().remove("expectedNode");}
                            changes.push(change);
                        }
                        let input=json!({"operationId":format!("workspace-attributes:{}",Uuid::new_v4()),"branchId":branch,"changes":changes});
                        if s.branch_path_apply(&input,&actor.grant_id)?["status"]!="committed"{return Err(failure("namespace_conflict","File changed while setting attributes"));}
                    }
                    s.save_workspace_metadata(&branch,&path,&selected,&actor)?;
                    s.branch_path_inspect(&json!({"branchId":branch,"path":path}))
                })
            })?;
            state.observed = observed;
            let mut aliases = BTreeMap::new();
            for path in state.aliases.keys() {
                let mut observed = state.observed.clone();
                observed["path"] = json!(path);
                aliases.insert(path.clone(), observed);
            }
            state.aliases = aliases;
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
        self.create_entry(requested, state, metadata, None)
    }
    /// Source adoption owns the stable reader and never exposes this private
    /// candidate to programs. Install bytes once, then publish namespace+metadata.
    pub(crate) fn import_file(
        &self, requested: &str, source: impl std::io::Read, attributes: Attributes,
        cancellation: &AtomicBool, progress: impl FnMut(u64) -> Result<(), KernelError>,
    ) -> Result<Arc<Node>, KernelError> {
        let cleanup = self.port.call(|s| Ok(s.private_cleanup.clone()))?;
        let sealed = SealedFile::capture(&self.root.join("staging"), source,
            self.revoked.clone(), cleanup, cancellation, progress)?;
        self.install_imported_file(requested, sealed, attributes, cancellation)
    }
    pub(crate) fn import_open_file(
        &self, requested: &str, source: std::fs::File, attributes: Attributes,
        cancellation: &AtomicBool, progress: impl FnMut(u64) -> Result<(), KernelError>,
    ) -> Result<Arc<Node>, KernelError> {
        let cleanup = self.port.call(|s| Ok(s.private_cleanup.clone()))?;
        let sealed = SealedFile::capture_open_file(&self.root.join("staging"), source,
            self.revoked.clone(), cleanup, cancellation, progress)?;
        self.install_imported_file(requested, sealed, attributes, cancellation)
    }
    fn install_imported_file(&self, requested: &str, sealed: SealedFile, mut attributes: Attributes,
        cancellation: &AtomicBool) -> Result<Arc<Node>, KernelError> {
        let (retained, sealed) = self.port.call(move |s| Ok((s.retain_private_file(&sealed), sealed)))?;
        let installed = sealed.install(&self.root, retained, cancellation)?;
        let state = installed.state(attributes.mode);
        let mut metadata = Storage::new_workspace_metadata(&state);
        attributes.file_id = metadata.binding.file_id;
        attributes.validate()?;
        metadata.attributes = attributes;
        self.create_entry(requested, state, metadata, Some(installed))
    }
    fn create_entry(&self, requested: &str, state: PathState, metadata: Metadata, installed: Option<InstalledFile>) -> Result<Arc<Node>, KernelError> {
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
            let mut input = json!({"operationId":operation,"workspaceId":actor.owning_workspace,"branchId":branch,"changes":[{"path":selected,"expectedState":before["state"],"state":state}]});
            storage.filesystem_transaction(|s| {
                if let Some(file) = &installed {
                    input["changes"][0]["ownerId"] = json!(s.admit_imported_file(&operation, file, &actor)?);
                }
                let result=s.branch_path_apply(&input, &actor.grant_id)?;
                if result["status"] != "committed" { return Err(failure("namespace_conflict", "Create target changed")); }
                s.save_workspace_metadata(&branch,&selected,&metadata,&actor)?;
                Ok(())
            })?;
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
                    false,
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
    /// Introduce another name for the same native inode. Namespace and link
    /// identities commit together; dirty byte ranges stay shared in memory.
    pub(crate) fn link(&self, node: &Arc<Node>, requested: &str) -> Result<Arc<Node>, KernelError> {
        let requested = path(requested)?;
        if requested.is_empty() {
            return Err(failure("namespace_exists", "Workspace root already exists"));
        }
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.owns(node)?;
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
        let mut state = lock(&node.state)?;
        let from = state
            .path
            .clone()
            .ok_or_else(|| failure("namespace_missing", "Cannot link an unlinked file"))?;
        if state.observed["state"]["kind"] != "regular-file" {
            return Err(failure(
                "namespace_not_file",
                "Only regular files can have hard links",
            ));
        }
        let before = self.observe(&requested, true)?;
        if before["state"]["kind"] != "missing" {
            return Err(failure(
                "namespace_exists",
                "Hard-link destination already exists",
            ));
        }
        let expected = state.observed.clone();
        let mut metadata = state.metadata.clone();
        metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
        let selected = metadata.clone();
        let (branch, actor, to) = (self.branch.clone(), self.grant.clone(), requested.clone());
        let (observed,count)=self.port.call(move |s|{
            s.admit_workspace_session(&branch,&from,&actor,true)?;
            s.admit_workspace_session(&branch,&to,&actor,true)?;
            let input=json!({"operationId":format!("workspace-hardlink:{}",Uuid::new_v4()),"branchId":branch,
                "changes":[{"path":to,"expectedState":before["state"],"state":expected["state"],"sourcePath":from}]});
            s.filesystem_transaction(|s|{
                let current=s.branch_path_inspect(&json!({"branchId":branch,"path":from}))?;
                if current["state"]!=expected["state"] || current["node"]!=expected["node"]{return Err(failure("namespace_conflict","Hard-link source changed"));}
                if s.branch_path_apply(&input,&actor.grant_id)?["status"]!="committed"{return Err(failure("namespace_conflict","Hard-link destination changed"));}
                let count=s.link_workspace_metadata(&branch,&from,&to,&selected,&actor)?;
                let observed=s.branch_path_inspect(&json!({"branchId":branch,"path":to}))?;
                Ok(json!({"status":"committed","observed":observed,"count":count}))
            }).and_then(|result|{
                let count=result["count"].as_u64().and_then(|n|usize::try_from(n).ok()).ok_or_else(||KernelError::Storage("hard-link count is invalid".into()))?;
                Ok((result["observed"].clone(),count))
            })
        })?;
        state.aliases.insert(requested.clone(), observed);
        state.metadata = metadata;
        state.metadata_generation = state.metadata_generation.wrapping_add(1);
        state.clean_metadata_generation = state.metadata_generation;
        state.link_count = count;
        drop(state);
        namespace.paths.insert(requested.clone(), node.clone());
        self.touch_parent(&mut namespace, &requested)?;
        Ok(node.clone())
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
        let id = lock(&node.state)?.metadata.binding.file_id;
        let remaining=self.port.call(move |s| {
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
            let receipt = s.filesystem_transaction(|s|{
                let receipt=s.branch_path_apply(&input,&actor.grant_id)?;
                if receipt["status"]=="committed"{s.remove_workspace_metadata(&branch,&selected,&actor)?;}
                Ok(receipt)
            })?;
            if receipt["status"] != "committed" { return Err(failure("namespace_conflict", "Unlink target changed")); }
            let paths=s.workspace_file_links(&branch,id,None,&actor)?;
            let mut remaining=Vec::with_capacity(paths.len());
            for path in paths{
                s.admit_workspace_session(&branch,&path,&actor,true)?;
                remaining.push(s.branch_path_inspect(&json!({"branchId":branch,"path":path}))?);
            }
            Ok(remaining)
        })?;
        let mut retired = None;
        {
            let mut state = lock(&node.state)?;
            state.aliases.remove(&requested);
            state.link_count = remaining.len();
            if remaining.is_empty() {
                state.path = None;
                namespace.inodes.remove(&state.metadata.binding.file_id);
                namespace.numbers.remove(&state.metadata.binding.file_id);
                namespace.dirty.remove(&node.id);
                retired = lock(&node.content)?.dirty.take();
            } else {
                for observed in remaining {
                    let path = observed["path"]
                        .as_str()
                        .ok_or_else(|| {
                            KernelError::Storage("hard-link observation omitted path".into())
                        })?
                        .to_owned();
                    state.aliases.insert(path.clone(), observed.clone());
                    namespace.paths.insert(path.clone(), node.clone());
                    if state.path.as_deref() == Some(&requested) {
                        state.path = Some(path);
                        state.observed = observed;
                    }
                }
                state.metadata_generation = state.metadata_generation.wrapping_add(1);
                namespace.dirty.insert(node.id, node.clone());
            }
            state.metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
        }
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
        let source_node = self.load(&mut namespace, &from)?;
        let source = self.observe(&from, true)?;
        let target = self.observe(&to, true)?;
        let replaced = if target["state"]["kind"] != "missing" {
            Some(self.load(&mut namespace, &to)?)
        } else {
            None
        };
        if replaced
            .as_ref()
            .is_some_and(|node| Arc::ptr_eq(node, &source_node))
        {
            return Ok(());
        }
        let replaced_id = replaced
            .as_ref()
            .map(|node| node.attributes().map(|a| a.file_id))
            .transpose()?;
        let (branch, actor, a, b) = (
            self.branch.clone(),
            self.grant.clone(),
            from.clone(),
            to.clone(),
        );
        let remaining=self.port.call(move |s| {
            s.admit_workspace_session(&branch, &a, &actor, true)?;
            s.admit_workspace_session(&branch, &b, &actor, true)?;
            require_capability(&actor,"branch.rename")?;
            let input = json!({"operationId":format!("workspace-rename:{}",Uuid::new_v4()),"workspaceId":actor.owning_workspace,"branchId":branch,"sourcePath":a,"path":b,
                "expectedSourceNode":source["node"],"expectedTargetNode":target["node"],"replace":replace});
            let receipt = s.filesystem_transaction(|s|{
                let receipt=s.branch_rename(&input)?;
                if receipt["status"]=="committed" && a!=b {
                    s.rename_workspace_metadata(&branch,&a,&b,&serde_json::from_value(source["state"].clone())?,&serde_json::from_value(target["state"].clone())?,&actor)?;
                }
                Ok(receipt)
            })?;
            if receipt["status"] != "committed" { return Err(failure("namespace_conflict", "Rename source or target changed")); }
            let mut remaining=Vec::new();
            if let Some(id)=replaced_id {
                for path in s.workspace_file_links(&branch,id,None,&actor)?{
                    s.admit_workspace_session(&branch,&path,&actor,true)?;
                    remaining.push(s.branch_path_inspect(&json!({"branchId":branch,"path":path}))?);
                }
            }
            Ok(remaining)
        })?;
        if from == to {
            return Ok(());
        }
        let mut retired = None;
        if let Some(replaced) = replaced {
            {
                let mut state = lock(&replaced.state)?;
                state.aliases.remove(&to);
                state.link_count = remaining.len();
                if remaining.is_empty() {
                    state.path = None;
                    namespace.inodes.remove(&state.metadata.binding.file_id);
                    namespace.numbers.remove(&state.metadata.binding.file_id);
                    namespace.dirty.remove(&replaced.id);
                    retired = lock(&replaced.content)?.dirty.take();
                } else {
                    for observed in remaining {
                        let path = observed["path"]
                            .as_str()
                            .ok_or_else(|| {
                                KernelError::Storage("hard-link observation omitted path".into())
                            })?
                            .to_owned();
                        state.aliases.insert(path.clone(), observed.clone());
                        namespace.paths.insert(path.clone(), replaced.clone());
                        if state.path.as_deref() == Some(&to) {
                            state.path = Some(path);
                            state.observed = observed;
                        }
                    }
                    state.metadata_generation = state.metadata_generation.wrapping_add(1);
                    namespace.dirty.insert(replaced.id, replaced.clone());
                }
                state.metadata.attributes.changed = super::workspace_metadata::Timestamp::now();
            }
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
            let mut observed = state
                .aliases
                .remove(&old)
                .unwrap_or_else(|| state.observed.clone());
            observed["path"] = json!(next);
            if state.path.as_deref() == Some(&old) {
                state.path = Some(next.clone());
                state.observed = observed.clone();
            }
            state.aliases.insert(next.clone(), observed);
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
        self.checkpoint_native("", &[], &[])
    }
    /// The backend seals new native opens while this method checks original
    /// writable references and captures the selected namespace under one lock.
    /// A rename cannot move an unfenced writer into scope between these steps.
    pub(crate) fn checkpoint_native(
        &self,
        selected: &str,
        writers: &[Arc<Node>],
        unsettled: &[Arc<Node>],
    ) -> Result<Checkpoint, KernelError> {
        let selected = path(selected)?;
        let _boundary = self
            .boundary
            .write()
            .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
        self.active()?;
        let namespace = lock(&self.namespace)?;
        for (nodes, code, message) in [
            (writers, "workspace_snapshot_writers_active", "An active writable native file reference in the selected scope may retain mapped writes"),
            (unsettled, "workspace_snapshot_cleanup_pending", "Native file cleanup in the selected scope has not completed"),
        ] {
            for node in nodes {
                self.owns(node)?;
                if self.node_in_scope(node, &selected, true)? {
                    return Err(KernelError::Execution(varin_runtime::execution::ExecutionError::new(code, message)
                        .with_details(json!({"sourcePath":selected,"path":node.path()?,"parentAvailable":true}))));
                }
            }
        }
        let mut files = Vec::new();
        let mut metadata = Vec::new();
        for node in namespace.dirty.values() {
            if !self.node_in_scope(node, &selected, false)? {
                continue;
            }
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
                        let (branch, actor, id, path) = (
                            self.branch.clone(),
                            self.grant.clone(),
                            state.metadata.binding.file_id,
                            path.clone(),
                        );
                        let paths = self.port.call(move |s| {
                            s.workspace_file_links(&branch, id, Some(&path), &actor)
                        })?;
                        files.push((paths, mode, snapshot));
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
        let base_pin = format!("{pin}:base");
        let pinned_base = base_pin.clone();
        let metadata_pin = format!("{pin}:filesystem");
        let pinned_metadata = metadata_pin.clone();
        let (metadata_head, branch) = self.port.call(move |s| {
            s.admit_workspace_session(&branch, "", &actor, false)?;
            require_capability(&actor, "branch.pin")?;
            s.filesystem_transaction(|s| {
                let data=s.branch(&branch)?;
                s.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,1,?7)",
                    params![pinned_base,branch,data.workspace_id,crate::model::SNAPSHOT_PIN_WRITE_REVISION,data.base_root,actor.grant_id,now_ms()])?;
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
                Ok((head, data))
            })
        })?;
        Ok(Checkpoint {
            session_id: self.id,
            selected_scope: selected,
            port: self.port.clone(),
            source_branch: self.branch.clone(),
            workspace: self.workspace.clone(),
            grant: self.grant.clone(),
            root: self.root.clone(),
            pin,
            base_pin,
            metadata_pin,
            metadata_head,
            branch,
            metadata,
            files,
            released: false,
        })
    }
    /// Caller owns the session boundary. Names are read from the same immutable
    /// metadata graph, including hard-link aliases never opened in this process.
    fn node_in_scope(
        &self,
        node: &Node,
        selected: &str,
        ancestors: bool,
    ) -> Result<bool, KernelError> {
        let state = lock(&node.state)?;
        let Some(path) = state.path.clone() else {
            return Ok(false);
        };
        if selected.is_empty() {
            return Ok(true);
        }
        let directory = state.observed["state"]["kind"] == "directory";
        let regular = state.observed["state"]["kind"] == "regular-file";
        let id = state.metadata.binding.file_id;
        drop(state);
        let contains = |path: &str| {
            path == selected
                || path
                    .strip_prefix(selected)
                    .is_some_and(|tail| tail.starts_with('/'))
                || (ancestors
                    && directory
                    && (path.is_empty()
                        || selected
                            .strip_prefix(path)
                            .is_some_and(|tail| tail.starts_with('/'))))
        };
        if contains(&path) {
            return Ok(true);
        }
        if !regular {
            return Ok(false);
        }
        let (branch, grant) = (self.branch.clone(), self.grant.clone());
        let paths = self
            .port
            .call(move |s| s.workspace_file_links(&branch, id, Some(&path), &grant))?;
        Ok(paths.iter().any(|path| contains(path)))
    }
    /// Discard only this operation's unpublished import, never a public workspace.
    pub(crate) fn discard_adoption(&self) -> Result<(), KernelError> {
        let branch = self.branch.clone();
        let actor = self.grant.grant_id.clone();
        self.port.call(move|s| {
            if !branch.starts_with("workspace-adoption:"){return Err(KernelError::Authorization("Only an unpublished source adoption may discard private bytes".into()));}
            let owned:bool=s.conn.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE kind='workspace.adopt' AND state='started' AND json_extract(result_json,'$.temporaryBranchId')=?1 AND json_extract(result_json,'$.grantId')=?2)",params![branch,actor],|row|row.get(0))?;
            if !owned{return Err(KernelError::Authorization("The original unpublished adoption owner is unavailable".into()));}
            Ok(())
        })?;
        self.revoked.store(true, Ordering::Release);
        self.close()
    }
    /// Only call after all native callbacks and process handles have drained.
    /// Errors leave the live session usable for retry, rather than discarding data.
    pub(crate) fn close(&self) -> Result<(), KernelError> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.revoked() {
            // Explicit revocation has already made every private range
            // inaccessible. Drain native handles before calling this path;
            // durable acknowledged publications remain in the branch.
            let _boundary = self
                .boundary
                .write()
                .map_err(|_| failure("workspace_failed", "Workspace boundary lock poisoned"))?;
            let mut namespace = lock(&self.namespace)?;
            let mut retired = Vec::new();
            for node in namespace.dirty.values() {
                if let Some(content) = lock(&node.content)?.dirty.take() {
                    retired.push(content);
                }
            }
            namespace.dirty.clear();
            self.closed.store(true, Ordering::Release);
            drop(namespace);
            drop(_boundary);
            drop(retired);
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
    fn install_files(
        &self,
        cancelled: &AtomicBool,
        selected: &str,
    ) -> Result<Vec<(Vec<String>, u32, super::workspace_files::InstalledFile)>, KernelError> {
        let mut installed = Vec::new();
        for (paths, mode, snapshot) in &self.files {
            let paths: Vec<_> = paths
                .iter()
                .filter(|path| {
                    selected.is_empty()
                        || path
                            .strip_prefix(selected)
                            .is_some_and(|tail| tail.starts_with('/'))
                })
                .cloned()
                .collect();
            if paths.is_empty() {
                continue;
            }
            installed.push((
                paths,
                *mode,
                snapshot.freeze(&self.root, &self.port, cancelled)?,
            ));
        }
        Ok(installed)
    }
    /// Fix a publication candidate without updating the active branch or
    /// materializing/scanning a directory. Sealing remains on this worker.
    pub(crate) fn prepare_result(
        &self,
        publication: &str,
        grant: Grant,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, KernelError> {
        if !self.selected_scope.is_empty() {
            return Err(failure(
                "workspace_checkpoint_scope",
                "A subtree boundary cannot publish a whole-workspace result",
            ));
        }
        let files = self.install_files(cancelled.as_ref(), "")?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let (publication, branch_id, pin, base_pin, metadata_pin, branch, head, metadata, session) = (
            publication.to_owned(),
            self.source_branch.clone(),
            self.pin.clone(),
            self.base_pin.clone(),
            self.metadata_pin.clone(),
            self.branch.clone(),
            self.metadata_head.clone(),
            self.metadata.clone(),
            self.session_id,
        );
        let file_owner = self.grant.clone();
        self.port.call(move |storage| {
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            storage.prepare_workspace_result(
                &publication,
                &branch_id,
                &pin,
                &base_pin,
                &metadata_pin,
                &branch,
                &head,
                &metadata,
                &files,
                session,
                &grant,
                &file_owner,
            )
        })
    }
    /// Complete a fork on a finite worker. Parent writes and unrelated Storage
    /// requests continue throughout hashing and installation. Publication of all
    /// dirty files and the target root is one original Storage transaction.
    pub(crate) fn fork(
        &self,
        target: &str,
        operation: &str,
        cancelled: &AtomicBool,
    ) -> Result<Value, KernelError> {
        self.fork_inner(target, operation, "", cancelled, self.grant.clone(), None)
    }
    pub(crate) fn fork_for(
        &self,
        target: &str,
        operation: &str,
        selected: &str,
        requester: Grant,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, KernelError> {
        self.fork_inner(
            target,
            operation,
            selected,
            cancelled.as_ref(),
            requester,
            Some(cancelled.clone()),
        )
    }
    fn fork_inner(
        &self,
        target: &str,
        operation: &str,
        selected: &str,
        cancelled: &AtomicBool,
        requester: Grant,
        late_cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Value, KernelError> {
        let selected = path(selected)?;
        if !self.selected_scope.is_empty()
            && selected != self.selected_scope
            && !selected
                .strip_prefix(&self.selected_scope)
                .is_some_and(|tail| tail.starts_with('/'))
        {
            return Err(failure(
                "workspace_checkpoint_scope",
                "Fork sourcePath is outside its original checkpoint scope",
            ));
        }
        let selected_replay = selected.clone();
        let (operation_key, source, target_key, session_id, grant) = (
            operation.to_owned(),
            self.source_branch.clone(),
            target.to_owned(),
            self.session_id,
            self.grant.clone(),
        );
        let original_requester = requester.clone();
        if let Some(result) = self.port.call(move |s| {
            s.replay_workspace_fork(
                &operation_key,
                &source,
                &target_key,
                &selected_replay,
                session_id,
                &grant,
                &original_requester,
            )
        })? {
            return Ok(result);
        }
        let installed = self.install_files(cancelled, &selected)?;
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
        let session_id = self.session_id;
        self.port.call(move |s| {
            if late_cancel
                .as_ref()
                .is_some_and(|cancel| cancel.load(Ordering::Acquire))
            {
                return Err(KernelError::Cancelled);
            }
            if let Some(result) = s.replay_workspace_fork(
                &operation, &source, &target, &selected, session_id, &actor, &requester,
            )? {
                return Ok(result);
            }
            s.publish_workspace_checkpoint(
                &source,
                &pin,
                &workspace,
                &target,
                &operation,
                &selected,
                &installed,
                &actor,
                &metadata_head,
                &metadata_pin,
                &metadata,
                session_id,
                &requester.grant_id,
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
        let base_pin = self.base_pin.clone();
        self.port.call(move |s| {
            s.filesystem_transaction(|s| {
                s.branch_pin(
                    &json!({"branchId":branch,"pinId":base_pin}),
                    false,
                    &actor.grant_id,
                )?;
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
        let base_pin = self.base_pin.clone();
        // Drop never waits on control: native backend teardown may be running
        // during drainage. The original grant still owns a failed release.
        let _ = (self.port.0)(Box::new(move |storage| {
            if let Some(s) = storage {
                let _ = s.filesystem_transaction(|s| {
                    s.branch_pin(
                        &json!({"branchId":branch,"pinId":base_pin}),
                        false,
                        &actor.grant_id,
                    )?;
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
    fn replay_workspace_fork(
        &self,
        operation: &str,
        source: &str,
        target: &str,
        selected: &str,
        session: Uuid,
        owner: &Grant,
        requester: &Grant,
    ) -> Result<Option<Value>, KernelError> {
        let current = self.load_grant(&owner.grant_id)?;
        if current.state != crate::model::GrantState::Active
            || current.kernel_epoch != owner.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Workspace fork owner is no longer active".into(),
            ));
        }
        let requested = self.load_grant(&requester.grant_id)?;
        if requested.state != crate::model::GrantState::Active
            || requested.kernel_epoch != requester.kernel_epoch
            || requested.owning_workspace != current.owning_workspace
            || requested
                .execution_workspace
                .as_ref()
                .or(requested.owning_workspace.as_ref())
                != current
                    .execution_workspace
                    .as_ref()
                    .or(current.owning_workspace.as_ref())
            || !path_allowed(&requested, selected)
        {
            return Err(KernelError::Authorization(
                "Fork execution no longer owns its original workspace scope".into(),
            ));
        }
        require_capability(&requested, "branch.fork")?;
        let prior = self.operation_get(&json!({"operationId":operation}))?;
        if prior.is_null() {
            return Ok(None);
        }
        let origin = &prior["result"]["filesystem"];
        if prior["kind"] != "workspace.checkpoint.fork"
            || origin["sourceBranchId"] != source
            || origin["targetBranchId"] != target
            || origin["sourcePath"] != selected
            || origin["sessionId"] != session.to_string()
            || origin["ownerGrantId"] != owner.grant_id
            || origin["requestGrantId"] != requester.grant_id
        {
            return Err(failure("workspace_operation_changed", "Fork operation does not match its original workspace, target and filesystem lifetime"));
        }
        if prior["state"] != "committed" {
            return Err(failure(
                "workspace_operation_pending",
                "Original workspace fork has not committed",
            ));
        }
        Ok(Some(prior["result"].clone()))
    }
    fn assert_workspace_grant_idle(&mut self, grant: &str) -> Result<(), KernelError> {
        if self
            .computations
            .jobs
            .values()
            .any(|job| job.grant_id == grant && !job.done())
            || self
                .file_leases
                .values()
                .any(|lease| lease.grant_id == grant)
        {
            return Err(failure(
                "workspace_in_use",
                "Original computation or file lease still retains this workspace execution",
            ));
        }
        let ids = {
            let mut query = self
                .conn
                .prepare("SELECT process_id FROM process_records WHERE grant_id=?1")?;
            let rows = query.query_map([grant], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for id in ids {
            let process = self.refresh_process_record(&id)?.ok_or_else(|| {
                failure(
                    "workspace_process_unknown",
                    "Original workspace process receipt is missing",
                )
            })?;
            if process["writerActive"] != false
                || !matches!(
                    process["status"].as_str(),
                    Some("exited" | "failed" | "released")
                )
            {
                return Err(failure(
                    "workspace_in_use",
                    "Original workspace process has not confirmed its stop",
                ));
            }
        }
        Ok(())
    }
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
        let current_boundary =
            matches!(
                method,
                "branch.write"
                    | "branch.write.begin"
                    | "branch.write.finish"
                    | "branch.path.apply"
                    | "branch.rename"
                    | "branch.publish"
                    | "branch.delete"
                    | "working.result.prepare"
            ) || (matches!(method, "branch.pin" | "branch.read" | "branch.path.inspect")
                && params["revision"].is_null());
        let branch = if matches!(method, "branch.write.finish" | "working.result.prepare") {
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
    pub(super) fn admit_workspace_session(
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
        if let Some(session) = self
            .workspace_sessions
            .get(branch)
            .and_then(std::sync::Weak::upgrade)
        {
            if session.active().is_ok()
                && grant
                    .execution_workspace
                    .as_ref()
                    .or(grant.owning_workspace.as_ref())
                    != session
                        .grant
                        .execution_workspace
                        .as_ref()
                        .or(session.grant.owning_workspace.as_ref())
            {
                return Err(KernelError::Authorization(
                    "Workspace execution authority belongs to another original source".into(),
                ));
            }
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
