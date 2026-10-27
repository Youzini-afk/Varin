//! One-time physical source stabilization. Subsequent workspace forks share
//! immutable roots; this traversal never runs as part of a managed fork.
use crate::{
    error::KernelError,
    model::{Grant, PathState},
    native_metadata::{self, Kind, Observation},
    protocol_generated::KernelWorkspaceAdoptParams,
    storage::{
        workspace_adoption::{Admission, Adoption},
        workspace_session::{Session, StoragePort},
    },
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn failed(code: &str, message: impl Into<String>) -> KernelError {
    KernelError::Execution(varin_runtime::execution::ExecutionError::new(code, message))
}
fn check(cancel: &AtomicBool) -> Result<(), KernelError> {
    if cancel.load(Ordering::Acquire) {
        Err(KernelError::Cancelled)
    } else {
        Ok(())
    }
}
fn changed(path: &Path) -> KernelError {
    failed(
        "workspace_source_changed",
        format!(
            "Source changed while stabilizing {}; the previous source was retained",
            path.display()
        ),
    )
}
#[derive(Clone)]
struct Entry {
    absolute: PathBuf,
    observed: Observation,
    config: bool,
}
struct Inventory {
    files: BTreeMap<String, Entry>,
    controls: BTreeMap<PathBuf, (Observation, String)>,
    git_configs: BTreeSet<String>,
    progress: StoragePort,
    phase: &'static str,
    last: Instant,
}
impl Inventory {
    fn read(
        plan: &Adoption,
        cancel: &AtomicBool,
        port: &StoragePort,
        phase: &'static str,
    ) -> Result<Self, KernelError> {
        let mut result = Self {
            files: BTreeMap::new(),
            controls: BTreeMap::new(),
            git_configs: BTreeSet::new(),
            progress: port.clone(),
            phase,
            last: Instant::now(),
        };
        result.walk(plan, &plan.source, "", cancel, false)?;
        Ok(result)
    }
    fn authorized(plan: &Adoption, path: &Path) -> Result<PathBuf, KernelError> {
        let canonical = fs::canonicalize(path)?;
        if !plan
            .git_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            return Err(failed("workspace_git_root_required",format!("Git administration is outside the admitted source roots: {}. Admit its original directory before importing this workspace",canonical.display())));
        }
        if canonical.starts_with(&plan.storage) || plan.storage.starts_with(&canonical) {
            return Err(failed("workspace_source_recursion","A source cannot contain, or be inside, its own Storage and managed mount directories"));
        }
        Ok(canonical)
    }
    fn control(&mut self, path: &Path, cancel: &AtomicBool) -> Result<String, KernelError> {
        check(cancel)?;
        let before = native_metadata::observe(path)?;
        let value = fs::read_to_string(path)?;
        if !before.same(&native_metadata::observe(path)?) {
            return Err(changed(path));
        }
        self.controls.insert(
            path.into(),
            (before, hex::encode(Sha256::digest(value.as_bytes()))),
        );
        Ok(value)
    }
    fn walk(
        &mut self,
        plan: &Adoption,
        absolute: &Path,
        relative: &str,
        cancel: &AtomicBool,
        git: bool,
    ) -> Result<(), KernelError> {
        let mut pending = vec![(absolute.to_path_buf(), relative.to_owned())];
        while let Some((absolute, relative)) = pending.pop() {
            check(cancel)?;
            let observed = native_metadata::observe(&absolute)?;
            let directory = matches!(observed.kind, Kind::Directory);
            if self.files.contains_key(&relative) && !directory {
                continue;
            }
            let config =
                matches!(observed.kind, Kind::File) && self.git_configs.contains(&relative);
            self.files.entry(relative.clone()).or_insert(Entry {
                absolute: absolute.clone(),
                observed,
                config,
            });
            if self.last.elapsed() >= Duration::from_millis(100) {
                progress(&self.progress, plan, self.phase, self.files.len() as u64, 0)?;
                self.last = Instant::now();
            }
            if directory {
                // Do not follow a directory replaced with a symlink/junction.
                let canonical = Self::authorized(plan, &absolute)?;
                if canonical != absolute {
                    return Err(changed(&absolute));
                }
                for child in fs::read_dir(&absolute)? {
                    check(cancel)?;
                    let child = child?;
                    let name = child.file_name().into_string().map_err(|_| {
                        failed(
                            "workspace_native_name_unsupported",
                            "A source filename is outside the current native name contract",
                        )
                    })?;
                    if name.contains(['\\', '\0']) {
                        return Err(failed(
                            "workspace_native_name_unsupported",
                            "A source filename cannot be represented by the current path contract",
                        ));
                    }
                    let target = if relative.is_empty() {
                        name.clone()
                    } else {
                        format!("{relative}/{name}")
                    };
                    if !git && name == ".git" {
                        self.git(plan, &child.path(), &target, cancel)?;
                    } else {
                        pending.push((child.path(), target));
                    }
                }
            }
        }
        Ok(())
    }
    fn git(
        &mut self,
        plan: &Adoption,
        original: &Path,
        prefix: &str,
        cancel: &AtomicBool,
    ) -> Result<(), KernelError> {
        self.git_configs.insert(format!("{prefix}/config"));
        self.git_configs.insert(format!("{prefix}/config.worktree"));
        let observed = native_metadata::observe(original)?;
        let admin = if matches!(observed.kind, Kind::File) {
            let text = self.control(original, cancel)?;
            let directory = text
                .trim()
                .strip_prefix("gitdir:")
                .ok_or_else(|| {
                    failed(
                        "workspace_git_admin_invalid",
                        "The .git pointer does not contain gitdir",
                    )
                })?
                .trim();
            Self::authorized(plan, &original.parent().unwrap().join(directory))?
        } else {
            Self::authorized(plan, original)?
        };
        let common_path = admin.join("commondir");
        let common = if common_path.try_exists()? {
            let pointer = self.control(&common_path, cancel)?;
            Self::authorized(plan, &admin.join(pointer.trim()))?
        } else {
            admin.clone()
        };
        let mut roots = vec![admin.clone()];
        if common != admin {
            roots.push(common.clone());
        }
        // Worktree-private entries win. Pointer files are replaced by a private
        // standalone .git directory; other worktrees keep their original files.
        for root in roots {
            if !self.files.contains_key(prefix) {
                self.files.insert(
                    prefix.into(),
                    Entry {
                        absolute: root.clone(),
                        observed: native_metadata::observe(&root)?,
                        config: false,
                    },
                );
            }
            for child in fs::read_dir(&root)? {
                check(cancel)?;
                let child = child?;
                let name = child.file_name().into_string().map_err(|_| {
                    failed(
                        "workspace_native_name_unsupported",
                        "Git administration contains a non-representable filename",
                    )
                })?;
                if matches!(name.as_str(), "commondir" | "gitdir" | "worktrees") {
                    continue;
                }
                let relative = format!("{prefix}/{name}");
                if name == "objects" {
                    let mut visited = BTreeSet::new();
                    self.git_objects(plan, &child.path(), &relative, cancel, &mut visited)?;
                } else {
                    self.walk(plan, &child.path(), &relative, cancel, true)?;
                }
            }
        }
        Ok(())
    }
    fn git_objects(
        &mut self,
        plan: &Adoption,
        root: &Path,
        prefix: &str,
        cancel: &AtomicBool,
        visited: &mut BTreeSet<PathBuf>,
    ) -> Result<(), KernelError> {
        let root = Self::authorized(plan, root)?;
        if !visited.insert(root.clone()) {
            return Ok(());
        }
        self.walk(plan, &root, prefix, cancel, true)?;
        let alternates = root.join("info/alternates");
        if alternates.try_exists()? {
            let content = self.control(&alternates, cancel)?;
            self.files.remove(&format!("{prefix}/info/alternates"));
            for alternate in content.lines().filter(|line| !line.is_empty()) {
                check(cancel)?;
                self.git_objects(plan, &root.join(alternate), prefix, cancel, visited)?;
            }
        }
        Ok(())
    }
    fn same(&self, other: &Self) -> bool {
        self.files.len() == other.files.len()
            && self.controls.len() == other.controls.len()
            && self.files.iter().all(|(path, before)| {
                other.files.get(path).is_some_and(|after| {
                    before.absolute == after.absolute && before.observed.same(&after.observed)
                })
            })
            && self.controls.iter().all(|(path, (before, hash))| {
                other
                    .controls
                    .get(path)
                    .is_some_and(|(after, next)| before.same(after) && hash == next)
            })
    }
}
fn open(path: &Path) -> Result<File, KernelError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(changed(path));
    }
    Ok(file)
}
fn progress(
    port: &StoragePort,
    plan: &Adoption,
    phase: &'static str,
    entries: u64,
    bytes: u64,
) -> Result<(), KernelError> {
    let plan = plan.clone();
    port.call(move |storage| storage.workspace_adoption_progress(&plan, phase, entries, bytes))
}
const PRIVATE_GIT_CONFIG: &[u8] = b"\n[core]\n\tworktree = ..\n\tbare = false\n";

pub(crate) fn adopt(
    port: StoragePort,
    input: KernelWorkspaceAdoptParams,
    grant: Grant,
    cancel: Arc<AtomicBool>,
) -> Result<Value, KernelError> {
    let admission = port.call(move |storage| storage.begin_workspace_adoption(input, &grant))?;
    let plan = match admission {
        Admission::Complete(value) => return Ok(value),
        Admission::Work(plan) => plan,
    };
    let mut session = None;
    let result = (|| {
        check(&cancel)?;
        if fs::canonicalize(&plan.source)? != plan.source {
            return Err(changed(&plan.source));
        }
        Inventory::authorized(&plan, &plan.source)?;
        let inventory = Inventory::read(&plan, &cancel, &port, "inventory")?;
        progress(&port, &plan, "capture", 0, 0)?;
        let workspace = Session::open(port.clone(), plan.temporary.clone(), plan.grant.clone())?;
        session = Some(workspace.clone());
        let mut links = BTreeMap::<String, Arc<crate::storage::workspace_session::Node>>::new();
        let mut hashes = BTreeMap::new();
        let mut bytes = 0u64;
        let mut completed = 0u64;
        let mut last = Instant::now();
        // Parents sort before their children. An entry is installed only after
        // its source body and native metadata have been observed successfully.
        for (path, entry) in &inventory.files {
            check(&cancel)?;
            if !entry
                .observed
                .same(&native_metadata::observe(&entry.absolute)?)
            {
                return Err(changed(&entry.absolute));
            }
            let node = match &entry.observed.kind {
                Kind::Directory if path.is_empty() => workspace.lookup("")?,
                Kind::Directory => workspace.create(
                    path,
                    PathState::Directory {
                        mode: Some(entry.observed.attributes.mode),
                    },
                )?,
                Kind::Symlink(target) => workspace.create(
                    path,
                    PathState::Symlink {
                        symlink_target: target.clone(),
                        mode: Some(entry.observed.attributes.mode),
                    },
                )?,
                Kind::File => {
                    if let Some(node) = links.get(&entry.observed.identity) {
                        // Config gets a private binding and cannot accidentally
                        // share an imported object's transformed byte stream.
                        if !entry.config {
                            workspace.link(node, path)?;
                            hashes.insert(path.clone(), hash_file(&entry.absolute, &cancel)?);
                            workspace.import_attributes(node, entry.observed.attributes.clone())?;
                            completed += 1;
                            continue;
                        }
                    }
                    let node = workspace.create_file(path, entry.observed.attributes.mode)?;
                    let mut source = open(&entry.absolute)?;
                    let mut digest = Sha256::new();
                    let mut offset = 0;
                    let mut buffer = [0u8; 128 * 1024];
                    loop {
                        check(&cancel)?;
                        let count = source.read(&mut buffer)?;
                        if count == 0 {
                            break;
                        }
                        workspace.write(&node, Some(offset), &buffer[..count])?;
                        digest.update(&buffer[..count]);
                        offset += count as u64;
                        bytes += count as u64;
                        if last.elapsed() >= Duration::from_millis(100) {
                            progress(&port, &plan, "capture", completed, bytes)?;
                            last = Instant::now();
                        }
                    }
                    if offset != entry.observed.length
                        || !entry
                            .observed
                            .same(&native_metadata::observe(&entry.absolute)?)
                    {
                        return Err(changed(&entry.absolute));
                    }
                    hashes.insert(path.clone(), hex::encode(digest.finalize()));
                    if entry.config {
                        workspace.write(&node, Some(offset), PRIVATE_GIT_CONFIG)?;
                    }
                    workspace.flush(&node)?;
                    if !entry.config {
                        links.insert(entry.observed.identity.clone(), node.clone());
                    }
                    node
                }
            };
            workspace.import_attributes(&node, entry.observed.attributes.clone())?;
            completed += 1;
        }
        progress(&port, &plan, "verify", completed, bytes)?;
        for (path, hash) in &hashes {
            check(&cancel)?;
            let entry = &inventory.files[path];
            if hash_file(&entry.absolute, &cancel)? != *hash {
                return Err(changed(&entry.absolute));
            }
        }
        let verified = Inventory::read(&plan, &cancel, &port, "verify")?;
        if !inventory.same(&verified) {
            return Err(changed(&plan.source));
        }
        // Child creation changed parent times; restore the source attributes
        // after the namespace is complete, without inventing a new change time.
        for (path, entry) in inventory.files.iter().rev() {
            check(&cancel)?;
            if matches!(entry.observed.kind, Kind::Directory) {
                workspace.import_attributes(
                    &workspace.lookup(path)?,
                    entry.observed.attributes.clone(),
                )?;
            }
        }
        workspace.close()?;
        check(&cancel)?;
        let final_plan = plan.clone();
        let cancelled = cancel.clone();
        port.call(move |storage| {
            storage.finish_workspace_adoption(&final_plan, completed, bytes, &cancelled)
        })
    })();
    if let Err(error) = &result {
        if let Some(workspace) = session {
            // The private import has no native mount, process or public binding.
            // Drop its unacknowledged dirty extent, rather than hashing it after
            // cancellation. The durable source branch remains until cleanup.
            workspace.discard_adoption()?;
        }
        let plan = plan.clone();
        let failure = error.to_string();
        port.call(move |storage| {
            storage.abort_workspace_adoption(&plan, &KernelError::Operation(failure))
        })?;
    }
    result
}
fn hash_file(path: &Path, cancel: &AtomicBool) -> Result<String, KernelError> {
    let before = native_metadata::observe(path)?;
    let mut file = open(path)?;
    let mut digest = Sha256::new();
    let mut bytes = [0; 128 * 1024];
    let mut length = 0;
    loop {
        check(cancel)?;
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
        length += count as u64;
    }
    if before.length != length || !before.same(&native_metadata::observe(path)?) {
        return Err(changed(path));
    }
    Ok(hex::encode(digest.finalize()))
}
