//! WinFsp callback adapter over the native Storage session. The optional DLL is
//! loaded only when a caller explicitly starts a qualification mount.
use super::*;
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::sync::Mutex;
use winfsp::{
    filesystem::{
        DirInfo, DirMarker, FileInfo, FileSecurity, FileSystemContext, OpenFileInfo, VolumeInfo,
        WideNameInfo,
    },
    host::{FileSystemHost, VolumeParams},
    FspError, U16CStr,
};

fn initialize() -> Result<(), KernelError> {
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
    for key in ["SOFTWARE\\WinFsp", "SOFTWARE\\WOW6432Node\\WinFsp"] {
        let key = wide(key);
        let mut length = 0;
        if unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut length,
            )
        } != 0
        {
            continue;
        }
        let mut value = vec![0u16; length as usize / 2];
        if unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                value.as_mut_ptr().cast(),
                &mut length,
            )
        } != 0
        {
            continue;
        }
        value.truncate(value.iter().position(|c| *c == 0).unwrap_or(value.len()));
        let mut path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&value));
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
                .map_err(|_| unsupported("Installed WinFsp could not initialize"))?;
            let _ = LOADED.set(());
            return Ok(());
        }
    }
    Err(unsupported("WinFsp is not installed or its native library cannot be loaded; no system component was changed"))
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
pub(super) struct Handle {
    node: Arc<Node>,
    _content: Option<Arc<PrivateFile>>,
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
    created: u64,
}
impl Backend {
    fn info(&self, node: &Node, out: &mut FileInfo) -> winfsp::Result<()> {
        let state = node.state().map_err(native)?;
        *out = FileInfo::default();
        out.index_number = node.id;
        out.creation_time = self.created;
        out.last_access_time = self.created;
        out.last_write_time = self.created;
        out.change_time = self.created;
        match state {
            PathState::RegularFile {
                byte_length, mode, ..
            } => {
                out.file_attributes = if mode & 0o222 == 0 { 1 } else { 0x20 };
                out.file_size = byte_length;
                out.allocation_size = byte_length.div_ceil(4096) * 4096;
            }
            PathState::Directory { .. } => out.file_attributes = 0x10,
            _ => return Err(native(unsupported(
                "WinFsp reparse/metadata qualification is not implemented for this source entry",
            ))),
        }
        Ok(())
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
    type FileContext = Handle;
    fn get_security_by_name(
        &self,
        name: &U16CStr,
        _descriptor: Option<&mut [c_void]>,
        _resolve: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
    ) -> winfsp::Result<FileSecurity> {
        let node = self.session.lookup(&path(name)?).map_err(native)?;
        let mut info = FileInfo::default();
        self.info(&node, &mut info)?;
        // The prototype does not advertise persistent ACL support. Do not
        // manufacture or broaden an original source security descriptor.
        Ok(FileSecurity {
            reparse: false,
            sz_security_descriptor: 0,
            attributes: info.file_attributes,
        })
    }
    fn open(
        &self,
        name: &U16CStr,
        options: u32,
        _access: u32,
        info: &mut OpenFileInfo,
    ) -> winfsp::Result<Handle> {
        let node = self.session.lookup(&path(name)?).map_err(native)?;
        let directory = node.state().map_err(native)?.is_directory();
        if (options & 1 != 0 && !directory) || (options & 0x40 != 0 && directory) {
            return Err(FspError::NTSTATUS(0xc0000103u32 as i32));
        }
        self.info(&node, info.as_mut())?;
        let content = if !directory {
            Some(self.session.open_file(&node).map_err(native)?)
        } else {
            None
        };
        Ok(Handle {
            node,
            _content: content,
        })
    }
    fn create(
        &self,
        name: &U16CStr,
        options: u32,
        _access: u32,
        _attributes: u32,
        _security: Option<&[c_void]>,
        _allocation: u64,
        _extra: Option<&[u8]>,
        reparse: bool,
        info: &mut OpenFileInfo,
    ) -> winfsp::Result<Handle> {
        if reparse {
            return Err(native(unsupported(
                "Native reparse points require metadata qualification",
            )));
        }
        let node = if options & 1 != 0 {
            self.session
                .create(&path(name)?, PathState::Directory { mode: Some(0o755) })
        } else {
            self.session.create_file(&path(name)?, 0o644)
        }
        .map_err(native)?;
        self.info(&node, info.as_mut())?;
        let content = if options & 1 == 0 {
            Some(self.session.open_file(&node).map_err(native)?)
        } else {
            None
        };
        Ok(Handle {
            node,
            _content: content,
        })
    }
    fn close(&self, context: Handle) {
        self.remember(&context.node, false, &self.session.flush(&context.node));
    }
    fn cleanup(&self, context: &Handle, _name: Option<&U16CStr>, flags: u32) {
        if flags & 1 != 0 {
            let result = (|| {
                let Some(path) = context.node.path()? else {
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
    fn overwrite(
        &self,
        context: &Handle,
        _attributes: u32,
        _replace: bool,
        _allocation: u64,
        _extra: Option<&[u8]>,
        info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        self.session.truncate(&context.node, 0).map_err(native)?;
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
    host: FileSystemHost<Backend>,
    session: Arc<Session>,
    errors: Pending,
}
impl Mount {
    pub(crate) fn start(session: Arc<Session>, target: &Path) -> Result<Self, KernelError> {
        admit_target(target)?;
        initialize()?;
        session.lookup("")?;
        let mut params = VolumeParams::new();
        params
            .filesystem_name("Varin")
            .sector_size(4096)
            .sectors_per_allocation_unit(1)
            .max_component_length(255)
            .case_sensitive_search(true)
            .case_preserved_names(true)
            .unicode_on_disk(true)
            .flush_and_purge_on_cleanup(true);
        let errors = Arc::new(Mutex::new(BTreeMap::new()));
        let created = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            / 100
            + 116444736000000000) as u64;
        let mut host = FileSystemHost::<Backend>::new(
            params,
            Backend {
                session: session.clone(),
                errors: errors.clone(),
                created,
            },
        )
        .map_err(|e| KernelError::Storage(format!("WinFsp filesystem creation failed: {e}")))?;
        host.mount(target)
            .map_err(|e| KernelError::Storage(format!("WinFsp mount failed: {e}")))?;
        if let Err(error) = host.start() {
            host.unmount();
            return Err(KernelError::Storage(format!(
                "WinFsp dispatcher failed: {error}"
            )));
        }
        Ok(Self {
            host,
            session,
            errors,
        })
    }
    pub(crate) fn wait_ready(&self) -> Result<(), KernelError> {
        self.session.check_open()
    }
    /// Caller must first close/stop native users. Stopping dispatcher callbacks
    /// is outside Storage control and cannot deadlock the metadata port.
    pub(crate) fn stop(&mut self) -> Result<(), KernelError> {
        self.host.unmount();
        self.host.stop();
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
        Ok(())
    }
}
