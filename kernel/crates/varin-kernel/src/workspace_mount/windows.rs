//! WinFsp callback adapter over the native Storage session. The optional DLL is
//! loaded only when a caller explicitly starts a qualification mount.
use super::*;
use crate::storage::workspace_metadata::Timestamp;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::sync::Mutex;
use winfsp::{
    filesystem::{
        DirInfo, DirMarker, FileInfo, FileSecurity, FileSystemContext, ModificationDescriptor,
        OpenFileInfo, VolumeInfo, WideNameInfo,
    },
    FspError, U16CStr,
};
mod namespace;
pub(crate) use namespace::execution_path;

pub(super) fn initialize() -> Result<(), KernelError> {
    static LOADED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    static ADMISSION: Mutex<()> = Mutex::new(());
    let _admission = ADMISSION
        .lock()
        .map_err(|_| unsupported("WinFsp initialization lock failed"))?;
    if LOADED.get().is_some() {
        return Ok(());
    }
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::System::{
        LibraryLoader::{
            LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
        },
        Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
    };
    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }
    let name = wide("InstallDir");
    let mut installed_library_error = None;
    let mut registry_error = None;
    for key in ["SOFTWARE\\WinFsp", "SOFTWARE\\WOW6432Node\\WinFsp"] {
        let key = wide(key);
        let mut length = 0;
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut length,
            )
        };
        if status != 0 {
            if !matches!(status, 2 | 3) { registry_error = Some(std::io::Error::from_raw_os_error(status as i32)); }
            continue;
        }
        let mut value = vec![0u16; length as usize / 2];
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                value.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != 0 {
            if !matches!(status, 2 | 3) { registry_error = Some(std::io::Error::from_raw_os_error(status as i32)); }
            continue;
        }
        value.truncate(value.iter().position(|c| *c == 0).unwrap_or(value.len()));
        let mut path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&value));
        if !path.is_absolute() {
            return Err(crate::workspace_backend::unavailable("dependency_incompatible", "WinFsp installation registry has no absolute system component directory"));
        }
        path.push("bin");
        path.push(if cfg!(target_arch = "aarch64") {
            "winfsp-a64.dll"
        } else if cfg!(target_arch = "x86") {
            "winfsp-x86.dll"
        } else {
            "winfsp-x64.dll"
        });
        let encoded = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if !unsafe {
            LoadLibraryExW(
                encoded.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        }
        .is_null()
        {
            // The validated installed DLL is now in the module list. The
            // binding's basename initialization reuses this loaded module.
            winfsp::winfsp_init()
                .map_err(|error| crate::workspace_backend::unavailable("dependency_incompatible", format!("Installed WinFsp could not initialize ({error:?}); repair or update it on this Host")))?;
            let _ = LOADED.set(());
            return Ok(());
        }
        installed_library_error = Some(std::io::Error::last_os_error());
    }
    if let Some(error) = installed_library_error {
        return Err(crate::workspace_backend::unavailable(
            if error.kind() == std::io::ErrorKind::PermissionDenied { "permission_denied" } else { "dependency_incompatible" },
            format!("Installed WinFsp native library could not load: {error}; repair or update the component on this Host")));
    }
    if let Some(error) = registry_error {
        return Err(crate::workspace_backend::unavailable(
            if error.kind() == std::io::ErrorKind::PermissionDenied { "permission_denied" } else { "dependency_unavailable" },
            format!("Cannot inspect WinFsp installation on this Host: {error}")));
    }
    Err(crate::workspace_backend::unavailable("dependency_missing", "WinFsp is not installed on this Host"))
}

/// Inspect the driver selected by the loaded library, including SxS installs.
/// Unlike FspFsctlPreflight this neither starts a service nor waits for it.
pub(super) fn check_driver() -> Result<(), KernelError> {
    use windows_sys::Win32::System::Services::*;
    struct Service(SC_HANDLE);
    impl Drop for Service {
        fn drop(&mut self) { if !self.0.is_null() { unsafe { CloseServiceHandle(self.0); } } }
    }
    fn failure(error: std::io::Error) -> KernelError {
        crate::workspace_backend::unavailable(match error.raw_os_error() {
            Some(5) => "permission_denied",
            Some(1060) => "dependency_missing",
            Some(1058) => "dependency_disabled",
            _ => "dependency_unavailable",
        }, format!("WinFsp driver is unavailable on this Host: {error}; repair or enable the installed system component"))
    }
    let manager = Service(unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) });
    if manager.0.is_null() { return Err(failure(std::io::Error::last_os_error())); }
    // FspSxsIdent returns a library-owned, NUL-terminated identifier. The '+'
    // separator is WinFsp's documented side-by-side service naming contract.
    let suffix = unsafe { U16CStr::from_ptr_str(winfsp_sys::FspSxsIdent()) }.to_string_lossy();
    let service = if suffix.is_empty() { "WinFsp".to_string() } else { format!("WinFsp+{suffix}") };
    let name = service.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    // These are the exact rights WinFsp's own StartService path requests,
    // including when the driver is already running. Do not start it here.
    let driver = Service(unsafe { OpenServiceW(manager.0, name.as_ptr(), SERVICE_QUERY_STATUS | SERVICE_START) });
    if driver.0.is_null() { return Err(failure(std::io::Error::last_os_error())); }
    // Configuration-query rights are additional to mounting. Use them when
    // available to diagnose disabled drivers without adding another prerequisite.
    let configuration = Service(unsafe { OpenServiceW(manager.0, name.as_ptr(), SERVICE_QUERY_CONFIG) });
    if !configuration.0.is_null() {
        let mut required = 0;
        unsafe { QueryServiceConfigW(configuration.0, std::ptr::null_mut(), 0, &mut required); }
        if required > 0 {
            let mut config = vec![std::mem::MaybeUninit::<QUERY_SERVICE_CONFIGW>::uninit();
                (required as usize).div_ceil(std::mem::size_of::<QUERY_SERVICE_CONFIGW>())];
            let config_ptr = config.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>();
            if unsafe { QueryServiceConfigW(configuration.0, config_ptr, required, &mut required) } != 0
                && unsafe { (*config_ptr).dwStartType } == SERVICE_DISABLED {
                return Err(failure(std::io::Error::from_raw_os_error(1058)));
            }
        }
    }
    Ok(())
}

fn native(error: KernelError) -> FspError {
    let status = match kind_error(&error) {
        "denied" => 0xc0000022u32,
        "cancelled" => 0xc0000120,
        "namespace_missing" | "namespace_not_found" | "namespace_parent_missing" => 0xc0000034,
        "namespace_exists" => 0xc0000035,
        "namespace_not_directory" => 0xc0000103,
        "namespace_is_directory" | "namespace_not_file" => 0xc00000ba,
        "namespace_not_empty" => 0xc0000101,
        "namespace_conflict" | "namespace_stale_cursor" => 0xc0000054,
        "workspace_backend_unsupported" => 0xc00000bb,
        "workspace_not_reparse" => 0xc0000275,
        "workspace_reparse_invalid"
        | "workspace_reparse_nonempty"
        | "workspace_reparse_hardlinks" => 0xc000000d,
        _ => 0xc0000185,
    };
    FspError::NTSTATUS(status as i32)
}
fn path(name: &U16CStr) -> winfsp::Result<String> {
    let value = name
        .to_string()
        .map_err(|_| FspError::NTSTATUS(0xc0000033u32 as i32))?;
    let value = value
        .strip_prefix('\\')
        .unwrap_or(&value)
        .replace('\\', "/");
    if !value.is_empty() {
        for segment in value.split('/') {
            component(std::ffi::OsStr::new(segment)).map_err(native)?;
        }
    }
    Ok(value)
}
type Writers = Arc<Mutex<BTreeMap<u64, (std::sync::Weak<Node>, usize)>>>;
pub(super) struct Handle {
    node: Arc<Node>,
    _content: Option<Arc<PrivateFile>>,
    writer: Option<Writers>,
    opens: Arc<std::sync::atomic::AtomicUsize>,
}
impl Drop for Handle {
    fn drop(&mut self) {
        if let Some(writers) = &self.writer {
            let mut writers = writers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some((_, count)) = writers.get_mut(&self.node.id) {
                *count -= 1;
                if *count == 0 {
                    writers.remove(&self.node.id);
                }
            }
        }
        self.opens.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
struct PendingCleanup {
    node: Arc<Node>,
    delete: bool,
    error: String,
}
type Pending = Arc<Mutex<BTreeMap<(u64, bool), PendingCleanup>>>;
pub(super) struct Backend {
    session: Arc<Session>,
    errors: Pending,
    writers: Writers,
    open_boundary: Arc<std::sync::RwLock<()>>,
    opens: Arc<std::sync::atomic::AtomicUsize>,
    closing: Arc<std::sync::atomic::AtomicBool>,
    inodes: namespace::Inodes,
}
impl Backend {
    fn retain_writer(&self, node: &Arc<Node>, writable: bool) -> winfsp::Result<Option<Writers>> {
        if !writable {
            return Ok(None);
        }
        let mut writers = self
            .writers
            .lock()
            .map_err(|_| FspError::NTSTATUS(0xc00000e5u32 as i32))?;
        writers
            .entry(node.id)
            .or_insert_with(|| (Arc::downgrade(node), 0))
            .1 += 1;
        Ok(Some(self.writers.clone()))
    }

    fn info(&self, node: &Node, out: &mut FileInfo) -> winfsp::Result<()> {
        self.session.check_open().map_err(native)?;
        let state = node.state().map_err(native)?;
        let metadata = node.attributes().map_err(native)?;
        *out = FileInfo::default();
        out.index_number = self.inodes.get(node.id)?;
        out.creation_time = metadata.created.filetime().map_err(native)?;
        out.last_access_time = metadata.accessed.filetime().map_err(native)?;
        out.last_write_time = metadata.modified.filetime().map_err(native)?;
        out.change_time = metadata.changed.filetime().map_err(native)?;
        out.file_attributes = metadata.windows_attributes;
        match state {
            PathState::RegularFile {
                byte_length, mode, ..
            } => {
                out.file_attributes &= !0x10;
                if mode & 0o222 == 0 {
                    out.file_attributes |= 1;
                }
                out.file_size = byte_length;
                out.allocation_size = byte_length.div_ceil(4096) * 4096;
            }
            PathState::Directory { .. } => out.file_attributes |= 0x10,
            PathState::Symlink { symlink_target, .. } => {
                let data = match &metadata.reparse_data {
                    Some(data) => data.clone(),
                    None => crate::reparse_data::symlink(&symlink_target).map_err(native)?,
                };
                out.reparse_tag = crate::reparse_data::parse(&data).map_err(native)?.tag;
                out.file_attributes |= 0x400;
            }
            _ => return Err(native(unsupported(
                "WinFsp reparse/metadata qualification is not implemented for this source entry",
            ))),
        }
        Ok(())
    }
    fn security(&self, node: &Node, buffer: Option<&mut [c_void]>) -> winfsp::Result<u64> {
        self.session.check_open().map_err(native)?;
        let descriptor = node
            .attributes()
            .map_err(native)?
            .security
            .unwrap_or_default();
        if let Some(buffer) = buffer {
            if buffer.len() < descriptor.len() {
                return Err(FspError::NTSTATUS(0x80000005u32 as i32));
            }
            // Native buffers and the persisted descriptor contain bytes, not
            // Rust objects. Their size is supplied by the WinFsp callback.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    descriptor.as_ptr(),
                    buffer.as_mut_ptr().cast::<u8>(),
                    descriptor.len(),
                );
            }
        }
        Ok(descriptor.len() as u64)
    }
    fn reparse(&self, node: &Node, buffer: &mut [u8]) -> winfsp::Result<u64> {
        self.session.check_open().map_err(native)?;
        let PathState::Symlink { symlink_target, .. } = node.state().map_err(native)? else {
            return Err(FspError::NTSTATUS(0xc0000275u32 as i32));
        };
        let data = match node.attributes().map_err(native)?.reparse_data {
            Some(data) => data,
            None => crate::reparse_data::symlink(&symlink_target).map_err(native)?,
        };
        if buffer.len() < data.len() {
            return Err(FspError::NTSTATUS(0xc0000023u32 as i32));
        }
        buffer[..data.len()].copy_from_slice(&data);
        Ok(data.len() as u64)
    }
    fn directory_path(&self, handle: &Handle) -> winfsp::Result<String> {
        if !handle.node.state().map_err(native)?.is_directory() {
            return Err(FspError::NTSTATUS(0xc0000103u32 as i32));
        }
        handle
            .node
            .path()
            .map_err(native)?
            .ok_or(FspError::NTSTATUS(0xc0000056u32 as i32))
    }
    fn remember(&self, node: &Arc<Node>, delete: bool, result: &Result<(), KernelError>) {
        let mut pending = self.errors.lock().unwrap_or_else(|p| p.into_inner());
        match result {
            Err(error) => {
                pending.insert(
                    (node.id, delete),
                    PendingCleanup {
                        node: node.clone(),
                        delete,
                        error: error.to_string(),
                    },
                );
            }
            Ok(()) => {
                pending.remove(&(node.id, delete));
            }
        }
    }
}
impl FileSystemContext for Backend {
    fn dispatcher_stopped(&self,_normally:bool){self.session.mount_disconnected();}
    type FileContext = Handle;
    fn get_security_by_name(
        &self,
        name: &U16CStr,
        descriptor: Option<&mut [c_void]>,
        resolve: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
    ) -> winfsp::Result<FileSecurity> {
        if let Some(security) = resolve(name) {
            return Ok(security);
        }
        let node = self.session.lookup(&path(name)?).map_err(native)?;
        let mut info = FileInfo::default();
        self.info(&node, &mut info)?;
        let result = FileSecurity {
            reparse: false,
            sz_security_descriptor: self.security(&node, descriptor)?,
            attributes: info.file_attributes,
        };
        self.session.forget_cached(&node).map_err(native)?;
        Ok(result)
    }
    fn open(
        &self,
        name: &U16CStr,
        options: u32,
        access: u32,
        info: &mut OpenFileInfo,
    ) -> winfsp::Result<Handle> {
        let _open = self
            .open_boundary
            .read()
            .map_err(|_| FspError::NTSTATUS(0xc00000e5u32 as i32))?;
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(FspError::NTSTATUS(0xc00000a3u32 as i32));
        }
        let node = self.session.lookup(&path(name)?).map_err(native)?;
        let state = node.state().map_err(native)?;
        let directory = state.is_directory()
            || node.attributes().map_err(native)?.windows_attributes & 0x10 != 0;
        if (options & 1 != 0 && !directory) || (options & 0x40 != 0 && directory) {
            return Err(FspError::NTSTATUS(0xc0000103u32 as i32));
        }
        self.info(&node, info.as_mut())?;
        let content = if matches!(state, PathState::RegularFile { .. }) {
            Some(self.session.open_file(&node).map_err(native)?)
        } else {
            None
        };
        let writer = self.retain_writer(&node, !directory && access & 6 != 0)?;
        self.opens.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Ok(Handle {
            node,
            _content: content,
            opens: self.opens.clone(),
            writer,
        })
    }
    fn create(
        &self,
        name: &U16CStr,
        options: u32,
        access: u32,
        attributes: u32,
        security: Option<&[c_void]>,
        _allocation: u64,
        extra: Option<&[u8]>,
        reparse: bool,
        info: &mut OpenFileInfo,
    ) -> winfsp::Result<Handle> {
        let _open = self
            .open_boundary
            .read()
            .map_err(|_| FspError::NTSTATUS(0xc00000e5u32 as i32))?;
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(FspError::NTSTATUS(0xc00000a3u32 as i32));
        }
        let point = if reparse {
            let bytes = extra.ok_or(FspError::NTSTATUS(0xc0000278u32 as i32))?;
            Some((
                crate::reparse_data::parse(bytes)
                    .map_err(|_| FspError::NTSTATUS(0xc0000278u32 as i32))?,
                bytes.to_vec(),
            ))
        } else {
            None
        };
        let target = point.as_ref().map(|(point, _)| point.target.clone());
        let descriptor = security.map(|value| unsafe {
            std::slice::from_raw_parts(value.as_ptr().cast::<u8>(), value.len()).to_vec()
        });
        let configure = |attrs: &mut crate::storage::workspace_metadata::Attributes| {
            attrs.windows_attributes = attributes | if options & 1 != 0 { 0x10 } else { 0 };
            if let Some((_, data)) = point {
                attrs.windows_attributes |= 0x400;
                attrs.reparse_data = Some(data);
            }
            if let Some(descriptor) = descriptor {
                attrs.security = Some(descriptor);
            }
            if attributes & 1 != 0 {
                attrs.mode &= !0o222;
            }
            Ok(())
        };
        let directory = options & 1 != 0;
        let node = if let Some(target) = target {
            self.session.create_with_attributes(
                &path(name)?,
                PathState::Symlink {
                    symlink_target: target,
                    mode: Some(0o777),
                },
                configure,
            )
        } else if options & 1 != 0 {
            self.session.create_with_attributes(
                &path(name)?,
                PathState::Directory { mode: Some(0o755) },
                configure,
            )
        } else {
            self.session
                .create_file_with_attributes(&path(name)?, 0o644, configure)
        }
        .map_err(native)?;
        self.info(&node, info.as_mut())?;
        let content = if matches!(node.state().map_err(native)?, PathState::RegularFile { .. }) {
            Some(self.session.open_file(&node).map_err(native)?)
        } else {
            None
        };
        let writer = self.retain_writer(&node, !directory && access & 6 != 0)?;
        self.opens.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Ok(Handle {
            node,
            _content: content,
            opens: self.opens.clone(),
            writer,
        })
    }
    fn close(&self, context: Handle) {
        self.remember(&context.node, false, &self.session.flush(&context.node));
        let node = context.node.clone();
        drop(context);
        if let Err(error) = self.session.forget_cached(&node) {
            eprintln!("Native lookup release remains pending: {error}");
        }
        self.session.notify_native_idle();
    }
    fn get_reparse_point_by_name(
        &self,
        name: &U16CStr,
        _: bool,
        buffer: &mut [u8],
    ) -> winfsp::Result<u64> {
        let node = self.session.lookup(&path(name)?).map_err(native)?;
        let result = self.reparse(&node, buffer);
        self.session.forget_cached(&node).map_err(native)?;
        result
    }
    fn get_reparse_point(
        &self,
        context: &Handle,
        _: &U16CStr,
        buffer: &mut [u8],
    ) -> winfsp::Result<u64> {
        self.reparse(&context.node, buffer)
    }
    fn set_reparse_point(
        &self,
        context: &Handle,
        _: &U16CStr,
        buffer: &[u8],
    ) -> winfsp::Result<()> {
        let incoming = crate::reparse_data::parse(buffer)
            .map_err(|_| FspError::NTSTATUS(0xc0000278u32 as i32))?;
        if matches!(
            context.node.state().map_err(native)?,
            PathState::Symlink { .. }
        ) {
            let current = context
                .node
                .attributes()
                .map_err(native)?
                .reparse_data
                .map(|data| crate::reparse_data::parse(&data).map(|point| point.tag))
                .transpose()
                .map_err(native)?
                .unwrap_or(crate::reparse_data::SYMLINK);
            if current != incoming.tag {
                return Err(FspError::NTSTATUS(0xc0000277u32 as i32));
            }
        }
        self.session
            .set_reparse_data(&context.node, Some(buffer.to_vec()))
            .map_err(native)
    }
    fn delete_reparse_point(
        &self,
        context: &Handle,
        _: &U16CStr,
        buffer: &[u8],
    ) -> winfsp::Result<()> {
        let tag = buffer
            .get(..4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
            .ok_or(FspError::NTSTATUS(0xc0000278u32 as i32))?;
        if !matches!(
            context.node.state().map_err(native)?,
            PathState::Symlink { .. }
        ) {
            return Err(FspError::NTSTATUS(0xc0000275u32 as i32));
        }
        let current = context
            .node
            .attributes()
            .map_err(native)?
            .reparse_data
            .map(|data| crate::reparse_data::parse(&data).map(|point| point.tag))
            .transpose()
            .map_err(native)?
            .unwrap_or(crate::reparse_data::SYMLINK);
        if current != tag {
            return Err(FspError::NTSTATUS(0xc0000277u32 as i32));
        }
        self.session
            .set_reparse_data(&context.node, None)
            .map_err(native)
    }
    fn cleanup(&self, context: &Handle, name: Option<&U16CStr>, flags: u32) {
        if flags & 1 != 0 {
            let result = (|| {
                let Some(path) = name
                    .map(path)
                    .transpose()
                    .map_err(|e| KernelError::Storage(format!("Native delete name failed: {e}")))?
                    .or(context.node.path()?)
                else {
                    return Ok(());
                };
                self.session
                    .remove(&path, context.node.state()?.is_directory())
            })();
            self.remember(&context.node, true, &result);
        } else {
            self.remember(&context.node, false, &self.session.flush(&context.node));
        }
    }
    fn flush(&self, context: Option<&Handle>, info: &mut FileInfo) -> winfsp::Result<()> {
        if let Some(context) = context {
            let result = self.session.flush(&context.node);
            self.remember(&context.node, false, &result);
            result.map_err(native)?;
            self.info(&context.node, info)
        } else {
            self.session.flush_all().map_err(native)
        }
    }
    fn get_file_info(&self, context: &Handle, info: &mut FileInfo) -> winfsp::Result<()> {
        self.info(&context.node, info)
    }
    fn set_basic_info(
        &self,
        context: &Handle,
        attributes: u32,
        creation: u64,
        access: u64,
        write: u64,
        change: u64,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        self.session
            .set_attributes(&context.node, |attrs| {
                if attributes != u32::MAX {
                    // Directory/reparse type changes use their own native
                    // operations. SetBasicInfo cannot silently change the inode.
                    attrs.windows_attributes = (attributes & !(0x10 | 0x400))
                        | (attrs.windows_attributes & (0x10 | 0x400));
                    if attributes & 1 != 0 {
                        attrs.mode &= !0o222;
                    } else {
                        attrs.mode |= 0o200;
                    }
                }
                if creation != 0 {
                    attrs.created = Timestamp::from_filetime(creation);
                    attrs.creation_exported = true;
                }
                if access != 0 {
                    attrs.accessed = Timestamp::from_filetime(access);
                }
                if write != 0 {
                    attrs.modified = Timestamp::from_filetime(write);
                }
                if change != 0 {
                    attrs.changed = Timestamp::from_filetime(change);
                }
                Ok(())
            })
            .map_err(native)?;
        self.info(&context.node, info)
    }
    fn get_security(
        &self,
        context: &Handle,
        descriptor: Option<&mut [c_void]>,
    ) -> winfsp::Result<u64> {
        self.security(&context.node, descriptor)
    }
    fn set_security(
        &self,
        context: &Handle,
        information: u32,
        modification: ModificationDescriptor,
    ) -> winfsp::Result<()> {
        // WinFsp merges the requested owner/group/DACL/SACL portions. Applying
        // the incoming descriptor wholesale would drop unrelated security data.
        self.session
            .set_attributes(&context.node, |attrs| {
                let input = attrs.security.as_mut().ok_or_else(|| {
                    unsupported("This source has no captured Windows security descriptor")
                })?;
                let mut output = std::ptr::null_mut();
                let status = unsafe {
                    winfsp_sys::FspSetSecurityDescriptor(
                        input.as_mut_ptr().cast(),
                        information,
                        modification.as_mut_ptr(),
                        &mut output,
                    )
                };
                if status < 0 {
                    return Err(KernelError::Storage(format!(
                        "Security descriptor update failed: NTSTATUS {status:#x}"
                    )));
                }
                struct Descriptor(*mut c_void);
                impl Drop for Descriptor {
                    fn drop(&mut self) {
                        unsafe {
                            winfsp_sys::FspDeleteSecurityDescriptor(
                                self.0,
                                Some(std::mem::transmute::<
                                    unsafe extern "C" fn(
                                        *mut c_void,
                                        u32,
                                        *mut c_void,
                                        *mut *mut c_void,
                                    )
                                        -> i32,
                                    unsafe extern "C" fn() -> i32,
                                >(
                                    winfsp_sys::FspSetSecurityDescriptor
                                )),
                            );
                        }
                    }
                }
                let output = Descriptor(output);
                let length =
                    unsafe { windows_sys::Win32::Security::GetSecurityDescriptorLength(output.0) }
                        as usize;
                attrs.security = Some(unsafe {
                    std::slice::from_raw_parts(output.0.cast::<u8>(), length).to_vec()
                });
                Ok(())
            })
            .map_err(native)
    }
    fn overwrite(
        &self,
        context: &Handle,
        attributes: u32,
        replace: bool,
        _allocation: u64,
        _extra: Option<&[u8]>,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        self.session.truncate(&context.node, 0).map_err(native)?;
        self.session
            .set_attributes(&context.node, |attrs| {
                if replace {
                    attrs.windows_attributes = attributes;
                } else {
                    attrs.windows_attributes |= attributes;
                }
                Ok(())
            })
            .map_err(native)?;
        self.info(&context.node, info)
    }
    fn read(&self, context: &Handle, bytes: &mut [u8], offset: u64) -> winfsp::Result<u32> {
        self.session
            .read(&context.node, offset, bytes)
            .map(|n| n as u32)
            .map_err(native)
    }
    fn write(
        &self,
        context: &Handle,
        bytes: &[u8],
        offset: u64,
        append: bool,
        constrained: bool,
        info: &mut FileInfo,
    ) -> winfsp::Result<u32> {
        let bytes = if constrained {
            let length = match context.node.state().map_err(native)? {
                PathState::RegularFile { byte_length, .. } => byte_length,
                _ => 0,
            };
            &bytes[..bytes.len().min(length.saturating_sub(offset) as usize)]
        } else {
            bytes
        };
        let (_, count) = self
            .session
            .write(&context.node, (!append).then_some(offset), bytes)
            .map_err(native)?;
        self.info(&context.node, info)?;
        Ok(count as u32)
    }
    fn set_file_size(
        &self,
        context: &Handle,
        size: u64,
        allocation: bool,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        // Allocation growth is not EOF growth; a smaller allocation truncates.
        let length = match context.node.state().map_err(native)? {
            PathState::RegularFile { byte_length, .. } => byte_length,
            _ => 0,
        };
        if !allocation || size < length {
            self.session.truncate(&context.node, size).map_err(native)?;
        }
        self.info(&context.node, info)
    }
    fn set_delete(&self, context: &Handle, _name: &U16CStr, delete: bool) -> winfsp::Result<()> {
        if delete && context.node.state().map_err(native)?.is_directory() {
            let path = self.directory_path(context)?;
            if !self
                .session
                .directory_page(&path, None, 1)
                .map_err(native)?
                .entries
                .is_empty()
            {
                return Err(FspError::NTSTATUS(0xc0000101u32 as i32));
            }
        }
        Ok(())
    }
    fn rename(
        &self,
        _context: &Handle,
        from: &U16CStr,
        to: &U16CStr,
        replace: bool,
    ) -> winfsp::Result<()> {
        self.session
            .rename(&path(from)?, &path(to)?, replace)
            .map_err(native)
    }
    fn read_directory(
        &self,
        context: &Handle,
        _pattern: Option<&U16CStr>,
        marker: DirMarker,
        buffer: &mut [u8],
    ) -> winfsp::Result<u32> {
        let directory = self.directory_path(context)?;
        let after = marker
            .inner_as_cstr()
            .map(|value| {
                value
                    .to_string()
                    .map_err(|_| FspError::NTSTATUS(0xc0000033u32 as i32))
            })
            .transpose()?;
        let count = (buffer.len() / std::mem::size_of::<DirInfo<0>>()).max(1);
        let page = self
            .session
            .directory_after(&directory, after, count)
            .map_err(native)?;
        let mut written = 0;
        let mut complete = page.next.is_none();
        for item in page.entries {
            let selected = if directory.is_empty() {
                item.name.clone()
            } else {
                format!("{directory}/{}", item.name)
            };
            let node = self.session.lookup(&selected).map_err(native)?;
            let mut entry = DirInfo::<256>::new();
            entry.set_name(&item.name)?;
            self.info(&node, entry.file_info_mut())?;
            self.session.forget_cached(&node).map_err(native)?;
            if !entry.append_to_buffer(buffer, &mut written) {
                complete = false;
                break;
            }
        }
        if complete {
            DirInfo::<256>::finalize_buffer(buffer, &mut written);
        }
        Ok(written)
    }
    fn get_volume_info(&self, info: &mut VolumeInfo) -> winfsp::Result<()> {
        let (total, free) = self.session.capacity().map_err(native)?;
        info.total_size = total;
        info.free_size = free;
        info.set_volume_label("Varin Workspace");
        Ok(())
    }
}

pub(crate) struct Mount {
    namespace: Option<Arc<namespace::Volume>>,
    name: String,
    path: std::path::PathBuf,
    session: Arc<Session>,
    errors: Pending,
    writers: Writers,
    open_boundary: Arc<std::sync::RwLock<()>>,
    opens: Arc<std::sync::atomic::AtomicUsize>,
    closing: Arc<std::sync::atomic::AtomicBool>,
}
impl Mount {
    pub(crate) fn start(session: Arc<Session>, _target: &Path) -> Result<Self, KernelError> {
        session.mount_started();
        initialize()?;
        let root = session.lookup("")?;
        let security = root.attributes()?.security.unwrap_or_default();
        session.forget_cached(&root)?;
        let namespace = namespace::Volume::acquire(security)?;
        let name = uuid::Uuid::new_v4().to_string();
        let path = namespace.path(&name);
        let errors = Arc::new(Mutex::new(BTreeMap::new()));
        let writers = Arc::new(Mutex::new(BTreeMap::new()));
        let open_boundary = Arc::new(std::sync::RwLock::new(()));
        let opens = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let closing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        namespace.insert(&name, Arc::new(Backend {
                session: session.clone(),
                errors: errors.clone(),
                writers: writers.clone(),
                open_boundary: open_boundary.clone(),
                opens: opens.clone(),
                closing: closing.clone(),
                inodes: namespace.inodes(),
            }))?;
        Ok(Self {
            namespace: Some(namespace),
            name,
            path,
            session,
            errors,
            writers,
            open_boundary,
            opens,
            closing,
        })
    }
    pub(crate) fn path(&self) -> &Path { &self.path }
    pub(crate) fn wait_ready(&self) -> Result<(), KernelError> {
        self.session.check_mounted()
    }
    pub(crate) fn wait_ready_cancelled(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<(), KernelError> {
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        self.wait_ready()
    }
    pub(crate) fn checkpoint(
        &self,
    ) -> Result<crate::storage::workspace_session::Checkpoint, KernelError> {
        self.checkpoint_at("")
    }
    pub(crate) fn checkpoint_at(
        &self,
        selected: &str,
    ) -> Result<crate::storage::workspace_session::Checkpoint, KernelError> {
        let _opens = self
            .open_boundary
            .write()
            .map_err(|_| unsupported("Native open boundary failed"))?;
        let writers = self
            .writers
            .lock()
            .map_err(|_| unsupported("Native writer registry failed"))?
            .values()
            .filter_map(|(node, _)| node.upgrade())
            .collect::<Vec<_>>();
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(unsupported("The original native mount is closing"));
        }
        let unsettled = self
            .errors
            .lock()
            .map_err(|_| unsupported("Native cleanup registry failed"))?
            .values()
            .map(|work| work.node.clone())
            .collect::<Vec<_>>();
        self.session
            .checkpoint_native(selected, &writers, &unsettled)
    }

    /// Seal new opens and retain the dispatcher until native Close drains the
    /// original references. Callback joins stay outside Storage control.
    pub(crate) fn stop(&mut self) -> Result<(), KernelError> {
        {
            let _opens = self
                .open_boundary
                .write()
                .map_err(|_| unsupported("Native open boundary failed"))?;
            self.closing
                .store(true, std::sync::atomic::Ordering::Release);
            let remaining = self.opens.load(std::sync::atomic::Ordering::Acquire);
            if remaining != 0&&!self.session.is_mount_disconnected() {
                return Err(KernelError::Execution(varin_runtime::execution::ExecutionError::new("workspace_native_handles_active",format!("Waiting for {remaining} original native file/directory handles to close before detaching the workspace"))));
            }
        }
        // The volume is shared, but each source retains its own open boundary,
        // native handles and cleanup. Closing one source cannot unmount siblings.
        if self.session.revoked() {
            self.errors
                .lock()
                .map_err(|_| unsupported("Native cleanup registry failed"))?
                .clear();
            self.session.close()?;
            return self.detach();
        }
        let pending = std::mem::take(&mut *self.errors.lock().unwrap_or_else(|p| p.into_inner()));
        for (key, mut work) in pending {
            let result = if work.delete {
                (|| {
                    if let Some(path) = work.node.path()? {
                        self.session
                            .remove(&path, work.node.state()?.is_directory())
                    } else {
                        Ok(())
                    }
                })()
            } else {
                self.session.flush(&work.node)
            };
            if let Err(error) = result {
                work.error = error.to_string();
                self.errors
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(key, work);
            }
        }
        let errors = self.errors.lock().unwrap_or_else(|p| p.into_inner());
        if !errors.is_empty() {
            return Err(KernelError::Storage(format!(
                "Native workspace cleanup failed: {}",
                errors
                    .values()
                    .map(|work| work.error.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            )));
        }
        drop(errors);
        self.session.close()?;
        self.detach()
    }
    fn detach(&mut self) -> Result<(), KernelError> {
        if let Some(namespace) = &self.namespace { namespace.remove(&self.name)?; }
        self.namespace.take();
        Ok(())
    }
}
impl Drop for Mount {
    fn drop(&mut self) {
        if let Some(namespace) = self.namespace.take() {
            // A lost mount worker must not leave a routable, ownerless source
            // in a sibling's volume. Existing handles retain their Backend and
            // the original Session for cleanup; no replacement writer is made.
            self.closing.store(true, std::sync::atomic::Ordering::Release);
            self.session.mount_disconnected();
            let _ = namespace.remove(&self.name);
        }
    }
}
