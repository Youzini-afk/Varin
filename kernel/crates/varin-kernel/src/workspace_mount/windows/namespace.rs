//! One per-kernel, per-user WinFsp network volume. UNC paths keep Windows/Node
//! realpath working; one owned DOS alias keeps legacy shells on that same volume.
//! Entries route to original Storage Sessions, never copies or a second writer.
use super::*;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    RwLock, Weak,
};
use winfsp::{
    host::{FileSystemHost, FileSystemParams, MountPoint, VolumeParams},
    notify::{Notifier, NotifyInfo, NotifyingFileSystemContext},
    U16CString,
};

type Entries = Arc<RwLock<BTreeMap<String, Arc<Backend>>>>;
static VOLUME: Mutex<Weak<Volume>> = Mutex::new(Weak::new());

pub(super) struct Inodes {
    next: Arc<AtomicU64>,
    nodes: Mutex<BTreeMap<u64, u64>>,
}
impl Inodes {
    pub(super) fn get(&self, node: u64) -> winfsp::Result<u64> {
        let mut nodes = self.nodes.lock().map_err(|_| status(0xc00000e5))?;
        Ok(*nodes
            .entry(node)
            .or_insert_with(|| self.next.fetch_add(1, Ordering::Relaxed)))
    }
}

pub(super) struct Volume {
    host: Mutex<Option<FileSystemHost<Namespace>>>,
    entries: Entries,
    root: PathBuf,
    drive: Drive,
    retired: AtomicBool,
    next_inode: Arc<AtomicU64>,
}
impl Volume {
    pub(super) fn acquire(security: Vec<u8>) -> Result<Arc<Self>, KernelError> {
        let mut shared = VOLUME
            .lock()
            .map_err(|_| unsupported("Native namespace registry failed"))?;
        if let Some(volume) = shared.upgrade() {
            return Ok(volume);
        }
        let server = format!("varin-{}", uuid::Uuid::new_v4().simple());
        let prefix = format!("\\{server}\\workspaces");
        let entries = Arc::new(RwLock::new(BTreeMap::new()));
        let mut params = VolumeParams::new();
        params
            .prefix(&prefix)
            .filesystem_name("Varin")
            .sector_size(4096)
            .sectors_per_allocation_unit(1)
            .max_component_length(255)
            .case_sensitive_search(true)
            .case_preserved_names(true)
            .unicode_on_disk(true)
            .reparse_points(true)
            .flush_and_purge_on_cleanup(true);
        // The WinFsp notification dispatcher services pending cache invalidations;
        // its cadence is not a close deadline or a retry of a workspace command.
        let mut host = FileSystemHost::<Namespace>::new_with_timer::<_, 100>(
            FileSystemParams::default_params(params),
            Namespace {
                entries: entries.clone(),
                security,
            },
        )
        .map_err(|e| failure("create", e))?;
        // WinFsp creates a per-user DOS device, not a Mount Manager volume.
        // This is a local driver namespace; no SMB server or network connection.
        host.mount(MountPoint::NextFreeDrive)
            .map_err(|e| failure("mount", e))?;
        let drive = match owned_drive(&prefix) {
            Ok(drive) => drive,
            Err(error) => {
                host.unmount();
                return Err(error);
            }
        };
        if let Err(error) = host.start() {
            host.unmount();
            if let Err(cleanup) = drive.remove() {
                return Err(failure(
                    "start dispatcher and release its drive",
                    format!("{error}; {cleanup}"),
                ));
            }
            return Err(failure("start dispatcher", error));
        }
        let volume = Arc::new(Self {
            host: Mutex::new(Some(host)),
            entries,
            root: PathBuf::from(format!("\\\\?\\UNC\\{server}\\workspaces")),
            drive,
            retired: AtomicBool::new(false),
            next_inode: Arc::new(AtomicU64::new(2)),
        });
        *shared = Arc::downgrade(&volume);
        Ok(volume)
    }
    pub(super) fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    pub(super) fn inodes(&self) -> Inodes {
        Inodes {
            next: self.next_inode.clone(),
            nodes: Mutex::new(BTreeMap::new()),
        }
    }
    pub(super) fn insert(&self, name: &str, backend: Arc<Backend>) -> Result<(), KernelError> {
        self.entries
            .write()
            .map_err(|_| unsupported("Native namespace registry failed"))?
            .insert(name.into(), backend);
        Ok(())
    }
    pub(super) fn remove(&self, name: &str) -> Result<(), KernelError> {
        let backend = self
            .entries
            .write()
            .map_err(|_| unsupported("Native namespace registry failed"))?
            .remove(name);
        drop(backend);
        Ok(())
    }

    pub(super) fn detach(slot: &mut Option<Arc<Self>>, name: &str) -> Result<(), KernelError> {
        let Some(volume) = slot.as_ref() else {
            return Ok(());
        };
        let mut shared = VOLUME
            .lock()
            .map_err(|_| unsupported("Native namespace registry failed"))?;
        volume.remove(name)?;
        // An in-flight acquire owns a reference before it inserts its entry.
        // Do not detach underneath it or a sibling workspace.
        if Arc::strong_count(volume) == 1 {
            let result = volume.retire();
            if shared.as_ptr() == Arc::as_ptr(volume) {
                *shared = Weak::new();
            }
            result?;
        }
        slot.take();
        Ok(())
    }

    fn retire(&self) -> Result<(), KernelError> {
        let mut host = self
            .host
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if self.retired.load(Ordering::Acquire) {
            return Ok(());
        }
        if let Some(mut host) = host.take() {
            host.unmount();
            host.stop();
        }
        self.drive
            .remove()
            .map_err(|error| failure("retire its drive", error))?;
        self.retired.store(true, Ordering::Release);
        Ok(())
    }
}
impl Drop for Volume {
    fn drop(&mut self) {
        if let Err(error) = self.retire() {
            eprintln!("[Workspace] {error}");
        }
    }
}

/// Only the guardian's private launch configuration uses the DOS alias. Durable
/// source identity, admission, containment and leases retain the canonical UNC.
pub(crate) fn execution_path(path: &Path) -> Result<PathBuf, KernelError> {
    let volume = VOLUME
        .lock()
        .map_err(|_| unsupported("Native namespace registry failed"))?
        .upgrade();
    let Some(volume) = volume else {
        return Ok(path.into());
    };
    let canonical = if path.starts_with(&volume.drive.root) {
        std::fs::canonicalize(path)?
    } else {
        path.into()
    };
    let Ok(relative) = canonical.strip_prefix(&volume.root) else {
        return Ok(path.into());
    };
    let selected = volume.drive.root.join(relative);
    if std::fs::canonicalize(&selected)? != canonical {
        return Err(KernelError::Authorization(
            "Native execution alias changed source identity".into(),
        ));
    }
    Ok(selected)
}

struct Drive {
    name: [u16; 3],
    root: PathBuf,
    target: Vec<u16>,
}
impl Drive {
    fn remove(&self) -> std::io::Result<()> {
        use windows_sys::Win32::Storage::FileSystem::{
            DefineDosDeviceW, DDD_EXACT_MATCH_ON_REMOVE, DDD_RAW_TARGET_PATH, DDD_REMOVE_DEFINITION,
        };
        use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_DRIVEREMOVED, SHCNF_PATHW};
        let mut mappings = drive_mappings(&self.name)?;
        if mappings.contains(&self.target) {
            let target: Vec<u16> = self.target.iter().copied().chain([0]).collect();
            let removed = unsafe {
                DefineDosDeviceW(
                    DDD_REMOVE_DEFINITION | DDD_EXACT_MATCH_ON_REMOVE | DDD_RAW_TARGET_PATH,
                    self.name.as_ptr(),
                    target.as_ptr(),
                )
            };
            let remove_error = (removed == 0).then(std::io::Error::last_os_error);
            mappings = drive_mappings(&self.name)?;
            if mappings.contains(&self.target) {
                return Err(remove_error.unwrap_or_else(|| {
                    std::io::Error::other("The original drive mapping is still present")
                }));
            }
        }
        if mappings.is_empty() {
            // WinFsp documents that the device broadcast may miss Explorer.
            // Refresh only after removal, and only when the drive is vacant.
            let path = [self.name[0], b':' as u16, b'\\' as u16, 0];
            unsafe {
                SHChangeNotify(
                    SHCNE_DRIVEREMOVED as i32,
                    SHCNF_PATHW,
                    path.as_ptr().cast(),
                    std::ptr::null(),
                )
            };
        }
        Ok(())
    }
}

fn owned_drive(prefix: &str) -> Result<Drive, KernelError> {
    let suffix: Vec<u16> = prefix.encode_utf16().collect();
    for letter in b'A'..=b'Z' {
        let name = [letter as u16, b':' as u16, 0];
        if let Some(target) = drive_mappings(&name)?
            .into_iter()
            .next()
            .filter(|path| path.ends_with(&suffix))
        {
            return Ok(Drive {
                name,
                root: PathBuf::from(format!("{}:\\", letter as char)),
                target,
            });
        }
    }
    Err(unsupported(
        "WinFsp did not retain its original per-user execution drive",
    ))
}

fn drive_mappings(name: &[u16; 3]) -> std::io::Result<Vec<Vec<u16>>> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER};
    use windows_sys::Win32::Storage::FileSystem::QueryDosDeviceW;
    let mut buffer = vec![0u16; 256];
    loop {
        let count =
            unsafe { QueryDosDeviceW(name.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
        if count != 0 {
            return Ok(buffer[..count as usize]
                .split(|&unit| unit == 0)
                .filter(|entry| !entry.is_empty())
                .map(<[u16]>::to_vec)
                .collect());
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_FILE_NOT_FOUND) => return Ok(Vec::new()),
            Some(ERROR_INSUFFICIENT_BUFFER) => buffer.resize(buffer.len() * 2, 0),
            _ => return Err(error),
        }
    }
}

fn failure(stage: &str, error: impl std::fmt::Display) -> KernelError {
    KernelError::Storage(format!(
        "WinFsp could not {stage} the user workspace namespace: {error}"
    ))
}
fn status(code: u32) -> FspError {
    FspError::NTSTATUS(code as i32)
}
fn root_info(info: &mut FileInfo) {
    *info = FileInfo::default();
    info.index_number = 1;
    info.file_attributes = 0x10;
}

struct Namespace {
    entries: Entries,
    security: Vec<u8>,
}
impl NotifyingFileSystemContext<Vec<(String, Arc<Backend>)>> for Namespace {
    fn should_notify(&self) -> Option<Vec<(String, Arc<Backend>)>> {
        let entries = self.entries.read().unwrap_or_else(|p| p.into_inner());
        let closing = entries
            .iter()
            .filter(|(_, backend)| {
                backend.closing.load(Ordering::Acquire) && !backend.opens.cleaned_files().is_empty()
            })
            .map(|(name, backend)| (name.clone(), backend.clone()))
            .collect::<Vec<_>>();
        // Do not consume work before NotifyBegin has acquired the rename fence.
        (!closing.is_empty()).then_some(closing)
    }
    fn notify(&self, closing: Vec<(String, Arc<Backend>)>, notifier: &Notifier) {
        // WinFsp v2.1 file.c::FspFileNodeInvalidateCachesAndNotifyChangeByName
        // flushes then CcPurgeCacheSection(..., FALSE). Filter=0/Action=0 only
        // invalidates caches, never fabricates a change or disconnects a mapping.
        // https://github.com/winfsp/winfsp/blob/v2.1/src/sys/file.c#L2372
        // Notify is asynchronous and may fail to purge a live mapping. Retain
        // each original inode in this work set until its actual Close callback.
        // This also lets an unmapped file leave standby after an earlier purge
        // could not complete. No successful notification releases a handle.
        // Every pathname admitted by WinFsp fits its native request buffer.
        const NAME_UNITS: usize = winfsp_sys::FSP_FSCTL_TRANSACT_REQ_SIZEMAX as usize / 2;
        for (name, backend) in closing {
            for node in backend.opens.cleaned_files() {
                if let Ok(Some(path)) = node.path() {
                    let mut info = NotifyInfo::<NAME_UNITS>::new();
                    if info
                        .set_name(format!("\\{}\\{}", name, path.replace('/', "\\")))
                        .is_ok()
                    {
                        notifier.notify(&info);
                        #[cfg(test)]
                        if let Some(observer) =
                            &*backend.opens.invalidation_observer.lock().unwrap()
                        {
                            let _ = observer.send(node.id);
                        }
                    }
                }
            }
        }
    }
}
enum Context {
    Root,
    Entry {
        backend: Arc<Backend>,
        handle: Handle,
        name: String,
    },
}
impl Context {
    fn entry(&self) -> winfsp::Result<(&Backend, &Handle)> {
        match self {
            Self::Entry {
                backend, handle, ..
            } => {
                backend.session.check_mounted().map_err(native)?;
                Ok((backend, handle))
            }
            Self::Root => Err(status(0xc0000022)),
        }
    }
}
impl Namespace {
    fn select(&self, name: &U16CStr) -> winfsp::Result<(String, Arc<Backend>, U16CString)> {
        let selected = path(name)?;
        let (name, relative) = selected.split_once('/').unwrap_or((&selected, ""));
        let backend = self
            .entries
            .read()
            .map_err(|_| status(0xc00000e5))?
            .get(name)
            .cloned()
            .ok_or(status(0xc0000034))?;
        let relative = U16CString::from_str(format!("\\{}", relative.replace('/', "\\")))
            .map_err(|_| status(0xc0000033))?;
        Ok((name.into(), backend, relative))
    }
    fn root_security(&self, descriptor: Option<&mut [c_void]>) -> winfsp::Result<u64> {
        if let Some(buffer) = descriptor {
            if buffer.len() < self.security.len() {
                return Err(status(0x80000005));
            }
            unsafe {
                std::ptr::copy_nonoverlapping(
                    self.security.as_ptr(),
                    buffer.as_mut_ptr().cast(),
                    self.security.len(),
                );
            }
        }
        Ok(self.security.len() as u64)
    }
}
impl FileSystemContext for Namespace {
    type FileContext = Context;
    fn get_security_by_name(
        &self,
        name: &U16CStr,
        descriptor: Option<&mut [c_void]>,
        resolve: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
    ) -> winfsp::Result<FileSecurity> {
        if let Some(security) = resolve(name) {
            return Ok(security);
        }
        if path(name)?.is_empty() {
            return Ok(FileSecurity {
                reparse: false,
                sz_security_descriptor: self.root_security(descriptor)?,
                attributes: 0x10,
            });
        }
        let (_, backend, relative) = self.select(name)?;
        backend.get_security_by_name(&relative, descriptor, |_| None)
    }
    fn open(
        &self,
        name: &U16CStr,
        options: u32,
        access: u32,
        info: &mut OpenFileInfo,
    ) -> winfsp::Result<Context> {
        if path(name)?.is_empty() {
            if options & 0x40 != 0 {
                return Err(status(0xc00000ba));
            }
            root_info(info.as_mut());
            return Ok(Context::Root);
        }
        let (name, backend, relative) = self.select(name)?;
        let handle = backend.open(&relative, options, access, info)?;
        Ok(Context::Entry {
            backend,
            handle,
            name,
        })
    }
    fn create(
        &self,
        name: &U16CStr,
        options: u32,
        access: u32,
        attributes: u32,
        security: Option<&[c_void]>,
        allocation: u64,
        extra: Option<&[u8]>,
        reparse: bool,
        info: &mut OpenFileInfo,
    ) -> winfsp::Result<Context> {
        let (name, backend, relative) = self.select(name)?;
        if path(&relative)?.is_empty() {
            // The generation directory already exists. mkdir/create_dir_all
            // depend on the ordinary name-collision result, even though its
            // lifetime is owned by the mount rather than a file operation.
            return Err(status(0xc0000035));
        }
        let handle = backend.create(
            &relative, options, access, attributes, security, allocation, extra, reparse, info,
        )?;
        Ok(Context::Entry {
            backend,
            handle,
            name,
        })
    }
    fn close(&self, context: Context) {
        if let Context::Entry {
            backend, handle, ..
        } = context
        {
            backend.close(handle);
        }
    }
    fn cleanup(&self, context: &Context, _name: Option<&U16CStr>, flags: u32) {
        // The original node follows rename. The outer name includes the routing
        // directory and must never be replayed into the source's namespace.
        if let Context::Entry {
            backend, handle, ..
        } = context
        {
            backend.cleanup(handle, None, flags);
        }
    }
    fn get_file_info(&self, context: &Context, info: &mut FileInfo) -> winfsp::Result<()> {
        if matches!(context, Context::Root) {
            root_info(info);
            return Ok(());
        }
        let (backend, handle) = context.entry()?;
        backend.get_file_info(handle, info)
    }
    fn get_security(
        &self,
        context: &Context,
        descriptor: Option<&mut [c_void]>,
    ) -> winfsp::Result<u64> {
        if matches!(context, Context::Root) {
            return self.root_security(descriptor);
        }
        let (backend, handle) = context.entry()?;
        backend.get_security(handle, descriptor)
    }
    fn flush(&self, context: Option<&Context>, info: &mut FileInfo) -> winfsp::Result<()> {
        if let Some(Context::Entry {
            backend, handle, ..
        }) = context
        {
            return backend.flush(Some(handle), info);
        }
        let entries = self
            .entries
            .read()
            .map_err(|_| status(0xc00000e5))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for backend in entries {
            backend.flush(None, &mut FileInfo::default())?;
        }
        root_info(info);
        Ok(())
    }
    fn read(&self, context: &Context, bytes: &mut [u8], offset: u64) -> winfsp::Result<u32> {
        let (backend, handle) = context.entry()?;
        backend.read(handle, bytes, offset)
    }
    fn write(
        &self,
        context: &Context,
        bytes: &[u8],
        offset: u64,
        append: bool,
        constrained: bool,
        info: &mut FileInfo,
    ) -> winfsp::Result<u32> {
        let (backend, handle) = context.entry()?;
        backend.write(handle, bytes, offset, append, constrained, info)
    }
    fn set_file_size(
        &self,
        context: &Context,
        size: u64,
        allocation: bool,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        backend.set_file_size(handle, size, allocation, info)
    }
    fn set_basic_info(
        &self,
        context: &Context,
        attributes: u32,
        creation: u64,
        access: u64,
        write: u64,
        change: u64,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        backend.set_basic_info(handle, attributes, creation, access, write, change, info)
    }
    fn set_security(
        &self,
        context: &Context,
        information: u32,
        modification: ModificationDescriptor,
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        backend.set_security(handle, information, modification)
    }
    fn overwrite(
        &self,
        context: &Context,
        attributes: u32,
        replace: bool,
        allocation: u64,
        extra: Option<&[u8]>,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        backend.overwrite(handle, attributes, replace, allocation, extra, info)
    }
    fn set_delete(&self, context: &Context, name: &U16CStr, delete: bool) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        if handle.node.path().map_err(native)?.as_deref() == Some("") {
            return Err(status(0xc0000022));
        }
        backend.set_delete(handle, name, delete)
    }
    fn rename(
        &self,
        context: &Context,
        from: &U16CStr,
        to: &U16CStr,
        replace: bool,
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        let (from_name, _, from_path) = self.select(from)?;
        let (to_name, _, to_path) = self.select(to)?;
        let Context::Entry { name, .. } = context else {
            return Err(status(0xc0000022));
        };
        if &from_name != name || &to_name != name {
            return Err(status(0xc00000d4));
        }
        if path(&from_path)?.is_empty() || path(&to_path)?.is_empty() {
            return Err(status(0xc0000022));
        }
        backend.rename(handle, &from_path, &to_path, replace)
    }
    fn get_reparse_point_by_name(
        &self,
        name: &U16CStr,
        directory: bool,
        buffer: &mut [u8],
    ) -> winfsp::Result<u64> {
        if path(name)?.is_empty() {
            return Err(status(0xc0000275));
        }
        let (_, backend, relative) = self.select(name)?;
        backend.get_reparse_point_by_name(&relative, directory, buffer)
    }
    fn get_reparse_point(
        &self,
        context: &Context,
        name: &U16CStr,
        buffer: &mut [u8],
    ) -> winfsp::Result<u64> {
        let (backend, handle) = context.entry()?;
        backend.get_reparse_point(handle, name, buffer)
    }
    fn set_reparse_point(
        &self,
        context: &Context,
        name: &U16CStr,
        buffer: &[u8],
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        backend.set_reparse_point(handle, name, buffer)
    }
    fn delete_reparse_point(
        &self,
        context: &Context,
        name: &U16CStr,
        buffer: &[u8],
    ) -> winfsp::Result<()> {
        let (backend, handle) = context.entry()?;
        backend.delete_reparse_point(handle, name, buffer)
    }
    fn read_directory(
        &self,
        context: &Context,
        pattern: Option<&U16CStr>,
        marker: DirMarker,
        buffer: &mut [u8],
    ) -> winfsp::Result<u32> {
        if let Context::Entry {
            backend, handle, ..
        } = context
        {
            return backend.read_directory(handle, pattern, marker, buffer);
        }
        let after = marker
            .inner_as_cstr()
            .map(|v| v.to_string().map_err(|_| status(0xc0000033)))
            .transpose()?;
        let entries = self
            .entries
            .read()
            .map_err(|_| status(0xc00000e5))?
            .iter()
            .filter(|(name, _)| after.as_ref().is_none_or(|after| *name > after))
            .map(|(name, backend)| (name.clone(), backend.clone()))
            .collect::<Vec<_>>();
        let mut written = 0;
        for (name, backend) in entries {
            let node = backend.session.lookup("").map_err(native)?;
            let mut info = DirInfo::<256>::new();
            info.set_name(name)?;
            backend.info(&node, info.file_info_mut())?;
            backend.session.forget_cached(&node).map_err(native)?;
            if !info.append_to_buffer(buffer, &mut written) {
                return Ok(written);
            }
        }
        DirInfo::<256>::finalize_buffer(buffer, &mut written);
        Ok(written)
    }
    fn get_volume_info(&self, info: &mut VolumeInfo) -> winfsp::Result<()> {
        let backend = self
            .entries
            .read()
            .map_err(|_| status(0xc00000e5))?
            .values()
            .next()
            .cloned();
        if let Some(backend) = backend {
            backend.get_volume_info(info)?;
        }
        info.set_volume_label("Varin Workspaces");
        Ok(())
    }
    fn dispatcher_stopped(&self, _: bool) {
        let entries = self
            .entries
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for backend in entries {
            backend.session.mount_disconnected();
        }
    }
}
