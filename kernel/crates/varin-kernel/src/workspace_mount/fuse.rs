//! Linux FUSE / macOS macFUSE adapter. The native session and byte engine are
//! shared with WinFsp; OS handles, inode replies and mount lifetime stay here.
use super::*;
use crate::storage::workspace_metadata::Timestamp;
use crate::storage::workspace_session::Session as WorkspaceSession;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use fuser::*;
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

fn attribute_error(code: &str, message: &str) -> KernelError {
    KernelError::Execution(varin_runtime::execution::ExecutionError::new(code, message))
}
fn attribute_reply(value: Result<Vec<u8>, KernelError>, size: u32, reply: ReplyXattr) {
    match value {
        Ok(bytes) if size == 0 => match u32::try_from(bytes.len()) {
            Ok(length) => reply.size(length),
            Err(_) => reply.error(Errno::E2BIG),
        },
        Ok(bytes) if bytes.len() <= size as usize => reply.data(&bytes),
        Ok(_) => reply.error(Errno::ERANGE),
        Err(error) => reply.error(native(error)),
    }
}

fn native(error: KernelError) -> Errno {
    match kind_error(&error) {
        "denied" => Errno::EACCES,
        "cancelled" => Errno::EINTR,
        "namespace_missing" | "namespace_not_found" | "namespace_parent_missing" => Errno::ENOENT,
        "namespace_exists" => Errno::EEXIST,
        "namespace_not_directory" => Errno::ENOTDIR,
        "namespace_is_directory" | "namespace_not_file" => Errno::EISDIR,
        "namespace_not_empty" => Errno::ENOTEMPTY,
        "namespace_conflict" | "namespace_stale_cursor" => Errno::ESTALE,
        "workspace_backend_unsupported" => Errno::ENOTSUP,
        "namespace_xattr_missing" => {
            #[cfg(target_os = "macos")]
            {
                Errno::from_i32(libc::ENOATTR)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Errno::from_i32(libc::ENODATA)
            }
        }
        "namespace_xattr_exists" => Errno::EEXIST,
        "namespace_xattr_invalid" => Errno::EINVAL,
        _ => Errno::EIO,
    }
}
struct Handle {
    node: Arc<Node>,
    _content: Option<Arc<PrivateFile>>,
    flags: i32,
    cookies: BTreeMap<u64, Option<String>>,
}
struct Handles {
    next: u64,
    nodes: HashMap<u64, Arc<Node>>,
    handles: HashMap<u64, Handle>,
    lookups: HashMap<u64, u64>,
}
struct Backend {
    session: Arc<WorkspaceSession>,
    handles: Arc<Mutex<Handles>>,
    open_boundary: Arc<std::sync::RwLock<()>>,
    closing: Arc<std::sync::atomic::AtomicBool>,
}
impl Backend {
    fn node(&self, id: INodeNo) -> Result<Arc<Node>, KernelError> {
        self.session.check_open()?;
        self.handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?
            .nodes
            .get(&id.0)
            .cloned()
            .ok_or_else(|| crate::error::KernelError::NotFound("native inode".into()))
    }
    fn remember(&self, node: Arc<Node>) -> Result<Arc<Node>, KernelError> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?;
        let count = handles.lookups.entry(node.id).or_default();
        *count = count
            .checked_add(1)
            .ok_or_else(|| unsupported("Native lookup reference space exhausted"))?;
        handles.nodes.insert(node.id, node.clone());
        Ok(node)
    }
    fn retire(&self, ino: u64) -> Result<(), KernelError> {
        let node = {
            let mut handles = self
                .handles
                .lock()
                .map_err(|_| unsupported("Native handle registry failed"))?;
            if ino == 1
                || handles.lookups.get(&ino).copied().unwrap_or(0) != 0
                || handles.handles.values().any(|handle| handle.node.id == ino)
            {
                return Ok(());
            }
            handles.lookups.remove(&ino);
            handles.nodes.remove(&ino)
        };
        if let Some(node) = node {
            self.session.forget_cached(&node)?;
        }
        Ok(())
    }
    fn release_handle(&self, fh: FileHandle) -> Result<(), KernelError> {
        let handle = self
            .handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?
            .handles
            .remove(&fh.0);
        if let Some(handle) = handle {
            let id = handle.node.id;
            drop(handle);
            self.retire(id)?;
        }
        self.session.notify_native_idle();
        Ok(())
    }
    fn selected(&self, parent: INodeNo, name: &OsStr) -> Result<String, KernelError> {
        let parent = self
            .node(parent)?
            .path()?
            .ok_or_else(|| crate::error::KernelError::NotFound("unlinked directory".into()))?;
        let name = component(name)?;
        Ok(if parent.is_empty() {
            name.into()
        } else {
            format!("{parent}/{name}")
        })
    }
    fn attr(&self, node: &Node) -> Result<FileAttr, KernelError> {
        self.session.check_open()?;
        let (size, kind, _mode) = match node.state()? {
            PathState::RegularFile {
                byte_length, mode, ..
            } => (byte_length, FileType::RegularFile, mode),
            PathState::Directory { mode } => (0, FileType::Directory, mode.unwrap_or(0o755)),
            PathState::Symlink {
                symlink_target,
                mode,
            } => (
                symlink_target.len() as u64,
                FileType::Symlink,
                mode.unwrap_or(0o777),
            ),
            _ => {
                return Err(unsupported(
                    "Source entry has no supported native file type",
                ))
            }
        };
        let metadata = node.attributes()?;
        Ok(FileAttr {
            ino: INodeNo(node.id),
            size,
            blocks: size.div_ceil(512),
            atime: metadata.accessed.time()?,
            mtime: metadata.modified.time()?,
            ctime: metadata.changed.time()?,
            crtime: metadata.created.time()?,
            kind,
            perm: metadata.mode as u16,
            nlink: node.link_count()?,
            uid: metadata.uid,
            gid: metadata.gid,
            rdev: 0,
            blksize: 4096,
            flags: metadata.bsd_flags,
        })
    }
    fn handle(&self, node: Arc<Node>, flags: i32) -> Result<FileHandle, KernelError> {
        let _open = self
            .open_boundary
            .read()
            .map_err(|_| unsupported("Native open boundary failed"))?;
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(unsupported("The original native mount is closing"));
        }
        self.register_handle(node, flags)
    }
    fn register_handle(&self, node: Arc<Node>, flags: i32) -> Result<FileHandle, KernelError> {
        let content = if matches!(node.state()?, PathState::RegularFile { .. }) {
            Some(self.session.open_file(&node)?)
        } else {
            None
        };
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?;
        let id = handles.next;
        handles.next = id
            .checked_add(1)
            .ok_or_else(|| unsupported("Native handle identity exhausted"))?;
        handles.nodes.insert(node.id, node.clone());
        handles.handles.insert(
            id,
            Handle {
                node,
                _content: content,
                flags,
                cookies: BTreeMap::from([(2, None)]),
            },
        );
        Ok(FileHandle(id))
    }
    fn file(&self, handle: FileHandle, write: bool) -> Result<(Arc<Node>, i32), KernelError> {
        let handles = self
            .handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?;
        let handle = handles
            .handles
            .get(&handle.0)
            .ok_or_else(|| crate::error::KernelError::NotFound("native open handle".into()))?;
        let access = handle.flags & libc::O_ACCMODE;
        if (write && access == libc::O_RDONLY) || (!write && access == libc::O_WRONLY) {
            return Err(KernelError::Authorization(
                "native handle has different access".into(),
            ));
        }
        Ok((handle.node.clone(), handle.flags))
    }
    fn sync(&self, handle: FileHandle) -> Result<(), KernelError> {
        let node = self
            .handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?
            .handles
            .get(&handle.0)
            .map(|h| h.node.clone())
            .ok_or_else(|| KernelError::NotFound("native open handle".into()))?;
        self.session.flush(&node)
    }
}
impl Filesystem for Backend {
    fn destroy(&mut self){self.session.mount_disconnected();}
    fn forget(&self, _: &Request, ino: INodeNo, nlookup: u64) {
        if let Ok(mut handles) = self.handles.lock() {
            if let Some(count) = handles.lookups.get_mut(&ino.0) {
                *count = count.saturating_sub(nlookup);
            }
        }
        if let Err(error) = self.retire(ino.0) {
            eprintln!("Native lookup release remains pending: {error}");
        }
        self.session.notify_native_idle();
    }
    fn init(&mut self, _: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
        #[cfg(target_os = "macos")]
        config.remove_capabilities(
            InitFlags::FUSE_CASE_INSENSITIVE | InitFlags::FUSE_VOL_RENAME | InitFlags::FUSE_XTIMES,
        );
        #[cfg(not(target_os = "macos"))]
        let _ = config;
        Ok(())
    }
    fn lookup(&self, _: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let result = self
            .selected(parent, name)
            .and_then(|p| self.session.lookup(&p))
            .and_then(|node| {
                let attr = self.attr(&node)?;
                self.remember(node)?;
                Ok(attr)
            });
        match result {
            Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(1)),
            Err(error) => reply.error(native(error)),
        }
    }
    fn getattr(&self, _: &Request, ino: INodeNo, _: Option<FileHandle>, reply: ReplyAttr) {
        match self.node(ino).and_then(|node| self.attr(&node)) {
            Ok(attr) => reply.attr(&Duration::ZERO, &attr),
            Err(error) => reply.error(native(error)),
        }
    }
    fn open(&self, _: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let result = self.node(ino).and_then(|node| {
            if !matches!(node.state()?, PathState::RegularFile { .. }) {
                return Err(unsupported("Open target is not a regular file"));
            }
            self.handle(node, flags.0)
        });
        match result {
            Ok(handle) => reply.opened(handle, FopenFlags::empty()),
            Err(error) => reply.error(native(error)),
        }
    }
    fn read(
        &self,
        _: &Request,
        _: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _: OpenFlags,
        _: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let mut bytes = vec![0; size as usize];
        match self
            .file(fh, false)
            .and_then(|(node, _)| self.session.read(&node, offset, &mut bytes))
        {
            Ok(count) => reply.data(&bytes[..count]),
            Err(error) => reply.error(native(error)),
        }
    }
    fn write(
        &self,
        _: &Request,
        _: INodeNo,
        fh: FileHandle,
        offset: u64,
        bytes: &[u8],
        write_flags: WriteFlags,
        _: OpenFlags,
        _: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let result = self.file(fh, true).and_then(|(node, flags)| {
            let append =
                flags & libc::O_APPEND != 0 && !write_flags.contains(WriteFlags::FUSE_WRITE_CACHE);
            let (_, count) = self
                .session
                .write(&node, (!append).then_some(offset), bytes)?;
            if flags & (libc::O_SYNC | libc::O_DSYNC) != 0 {
                self.session.flush(&node)?;
            }
            Ok(count)
        });
        match result {
            Ok(count) => reply.written(count as u32),
            Err(error) => reply.error(native(error)),
        }
    }
    fn flush(&self, _: &Request, _: INodeNo, fh: FileHandle, _: LockOwner, reply: ReplyEmpty) {
        match self.sync(fh) {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn fsync(&self, _: &Request, _: INodeNo, fh: FileHandle, _: bool, reply: ReplyEmpty) {
        match self.sync(fh) {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn release(
        &self,
        _: &Request,
        _: INodeNo,
        fh: FileHandle,
        _: OpenFlags,
        _: Option<LockOwner>,
        _: bool,
        reply: ReplyEmpty,
    ) {
        let result = self.sync(fh);
        // Release ended this descriptor even on a flush error. Unsaved bytes
        // remain owned by the session's dirty inode set.
        let retired = self.release_handle(fh);
        let result = result.and(retired);
        match result {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn create(
        &self,
        request: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        umask: u32,
        flags: i32,
        reply: ReplyCreate,
    ) {
        let result = (|| {
            let _open = self
                .open_boundary
                .read()
                .map_err(|_| unsupported("Native open boundary failed"))?;
            if self.closing.load(std::sync::atomic::Ordering::Acquire) {
                return Err(unsupported("The original native mount is closing"));
            }
            let node = self.session.create_file_with_attributes(
                &self.selected(parent, name)?,
                mode & 0o7777 & !umask,
                |attrs| {
                    attrs.uid = request.uid();
                    attrs.gid = request.gid();
                    Ok(())
                },
            )?;
            let attr = self.attr(&node)?;
            let handle = self.register_handle(node.clone(), flags)?;
            self.remember(node)?;
            Ok((attr, handle))
        })();
        match result {
            Ok((attr, handle)) => reply.created(
                &Duration::ZERO,
                &attr,
                Generation(1),
                handle,
                FopenFlags::empty(),
            ),
            Err(error) => reply.error(native(error)),
        }
    }
    fn mkdir(
        &self,
        request: &Request,
        parent: INodeNo,
        name: &OsStr,
        mode: u32,
        umask: u32,
        reply: ReplyEntry,
    ) {
        let result = (|| {
            let node = self.session.create_with_attributes(
                &self.selected(parent, name)?,
                PathState::Directory {
                    mode: Some(mode & 0o7777 & !umask),
                },
                |attrs| {
                    attrs.uid = request.uid();
                    attrs.gid = request.gid();
                    Ok(())
                },
            )?;
            let attr = self.attr(&node)?;
            self.remember(node)?;
            Ok(attr)
        })();
        match result {
            Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(1)),
            Err(error) => reply.error(native(error)),
        }
    }
    fn unlink(&self, _: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self
            .selected(parent, name)
            .and_then(|p| self.session.remove(&p, false))
        {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn link(
        &self,
        _: &Request,
        ino: INodeNo,
        newparent: INodeNo,
        newname: &OsStr,
        reply: ReplyEntry,
    ) {
        let result = (|| {
            let source = self.node(ino)?;
            let node = self
                .session
                .link(&source, &self.selected(newparent, newname)?)?;
            let attr = self.attr(&node)?;
            self.remember(node)?;
            Ok(attr)
        })();
        match result {
            Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(1)),
            Err(error) => reply.error(native(error)),
        }
    }
    fn rmdir(&self, _: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self
            .selected(parent, name)
            .and_then(|p| self.session.remove(&p, true))
        {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn rename(
        &self,
        _: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let result = (|| {
            #[cfg(target_os = "linux")]
            let allowed = libc::RENAME_NOREPLACE as u32;
            #[cfg(not(target_os = "linux"))]
            let allowed = 0;
            if flags.bits() & !allowed != 0 {
                return Err(unsupported(
                    "Native rename exchange/whiteout is not implemented",
                ));
            }
            self.session.rename(
                &self.selected(parent, name)?,
                &self.selected(newparent, newname)?,
                flags.bits() == 0,
            )
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn readlink(&self, _: &Request, ino: INodeNo, reply: ReplyData) {
        match self.node(ino).and_then(|node| node.state()) {
            Ok(PathState::Symlink { symlink_target, .. }) => reply.data(symlink_target.as_bytes()),
            Ok(_) => reply.error(Errno::EINVAL),
            Err(error) => reply.error(native(error)),
        }
    }
    fn symlink(
        &self,
        request: &Request,
        parent: INodeNo,
        name: &OsStr,
        target: &Path,
        reply: ReplyEntry,
    ) {
        let result = (|| {
            let target = target.to_str().ok_or_else(|| {
                unsupported("Symlink target cannot be represented by current Storage names")
            })?;
            let node = self.session.create_with_attributes(
                &self.selected(parent, name)?,
                PathState::Symlink {
                    symlink_target: target.into(),
                    mode: Some(0o777),
                },
                |attrs| {
                    attrs.uid = request.uid();
                    attrs.gid = request.gid();
                    Ok(())
                },
            )?;
            let attr = self.attr(&node)?;
            self.remember(node)?;
            Ok(attr)
        })();
        match result {
            Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(1)),
            Err(error) => reply.error(native(error)),
        }
    }
    fn setattr(
        &self,
        _: &Request,
        ino: INodeNo,
        mode: Option<u32>,
        uid: Option<u32>,
        gid: Option<u32>,
        size: Option<u64>,
        atime: Option<TimeOrNow>,
        mtime: Option<TimeOrNow>,
        ctime: Option<SystemTime>,
        fh: Option<FileHandle>,
        crtime: Option<SystemTime>,
        chgtime: Option<SystemTime>,
        bkuptime: Option<SystemTime>,
        flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let result = (|| {
            let node = if let Some(handle) = fh {
                self.file(handle, true)?.0
            } else {
                self.node(ino)?
            };
            if let Some(size) = size {
                self.session.truncate(&node, size)?;
            }
            self.session.set_attributes(&node, |attrs| {
                if let Some(value) = mode {
                    attrs.mode = value & 0o7777;
                }
                if let Some(value) = uid {
                    attrs.uid = value;
                }
                if let Some(value) = gid {
                    attrs.gid = value;
                }
                let stamp = |value| match value {
                    TimeOrNow::SpecificTime(time) => Timestamp::from_time(time),
                    TimeOrNow::Now => Timestamp::now(),
                };
                if let Some(value) = atime {
                    attrs.accessed = stamp(value);
                }
                if let Some(value) = mtime {
                    attrs.modified = stamp(value);
                }
                if let Some(value) = ctime.or(chgtime) {
                    attrs.changed = Timestamp::from_time(value);
                }
                if let Some(value) = crtime {
                    attrs.created = Timestamp::from_time(value);
                    attrs.creation_exported = true;
                }
                if let Some(value) = bkuptime {
                    attrs.backup = Some(Timestamp::from_time(value));
                }
                if let Some(value) = flags {
                    attrs.bsd_flags = value.bits();
                }
                Ok(())
            })?;
            self.attr(&node)
        })();
        match result {
            Ok(attr) => reply.attr(&Duration::ZERO, &attr),
            Err(error) => reply.error(native(error)),
        }
    }
    fn opendir(&self, _: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let result = self.node(ino).and_then(|node| {
            if !node.state()?.is_directory() {
                return Err(KernelError::Execution(
                    varin_runtime::execution::ExecutionError::new(
                        "namespace_not_directory",
                        "Directory open target is not a directory",
                    ),
                ));
            }
            self.handle(node, flags.0)
        });
        match result {
            Ok(handle) => reply.opened(handle, FopenFlags::empty()),
            Err(error) => reply.error(native(error)),
        }
    }
    fn setxattr(
        &self,
        _: &Request,
        ino: INodeNo,
        name: &OsStr,
        value: &[u8],
        flags: i32,
        position: u32,
        reply: ReplyEmpty,
    ) {
        use std::os::unix::ffi::OsStrExt;
        let name = URL_SAFE_NO_PAD.encode(name.as_bytes());
        let result = self.node(ino).and_then(|node| {
            self.session.set_attributes(&node, |attrs| {
                if flags & !(libc::XATTR_CREATE | libc::XATTR_REPLACE) != 0
                    || flags & (libc::XATTR_CREATE | libc::XATTR_REPLACE)
                        == (libc::XATTR_CREATE | libc::XATTR_REPLACE)
                {
                    return Err(attribute_error(
                        "namespace_xattr_invalid",
                        "Invalid extended attribute flags",
                    ));
                }
                let exists = attrs.xattrs.contains_key(&name);
                if exists && flags & libc::XATTR_CREATE != 0 {
                    return Err(attribute_error(
                        "namespace_xattr_exists",
                        "Extended attribute already exists",
                    ));
                }
                if !exists && flags & libc::XATTR_REPLACE != 0 {
                    return Err(attribute_error(
                        "namespace_xattr_missing",
                        "Extended attribute does not exist",
                    ));
                }
                if position != 0 {
                    return Err(unsupported(
                        "Positioned resource-fork I/O has not been implemented",
                    ));
                }
                attrs.xattrs.insert(name, value.to_vec());
                Ok(())
            })
        });
        match result {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn getxattr(&self, _: &Request, ino: INodeNo, name: &OsStr, size: u32, reply: ReplyXattr) {
        use std::os::unix::ffi::OsStrExt;
        let result = self
            .node(ino)
            .and_then(|node| node.attributes())
            .and_then(|attrs| {
                attrs
                    .xattrs
                    .get(&URL_SAFE_NO_PAD.encode(name.as_bytes()))
                    .cloned()
                    .ok_or_else(|| {
                        attribute_error(
                            "namespace_xattr_missing",
                            "Extended attribute does not exist",
                        )
                    })
            });
        attribute_reply(result, size, reply);
    }
    fn listxattr(&self, _: &Request, ino: INodeNo, size: u32, reply: ReplyXattr) {
        let result = self
            .node(ino)
            .and_then(|node| node.attributes())
            .and_then(|attrs| {
                let mut names = Vec::new();
                for key in attrs.xattrs.keys() {
                    names.extend(URL_SAFE_NO_PAD.decode(key).map_err(|_| {
                        KernelError::Storage("Invalid stored native attribute name".into())
                    })?);
                    names.push(0);
                }
                Ok(names)
            });
        attribute_reply(result, size, reply);
    }
    fn removexattr(&self, _: &Request, ino: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        use std::os::unix::ffi::OsStrExt;
        let name = URL_SAFE_NO_PAD.encode(name.as_bytes());
        let result = self.node(ino).and_then(|node| {
            self.session.set_attributes(&node, |attrs| {
                attrs.xattrs.remove(&name).ok_or_else(|| {
                    attribute_error(
                        "namespace_xattr_missing",
                        "Extended attribute does not exist",
                    )
                })?;
                Ok(())
            })
        });
        match result {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn readdir(
        &self,
        _: &Request,
        ino: INodeNo,
        fh: FileHandle,
        mut offset: u64,
        mut reply: ReplyDirectory,
    ) {
        let result = (|| {
            let node = self.node(ino)?;
            let directory = node
                .path()?
                .ok_or_else(|| KernelError::NotFound("unlinked directory".into()))?;
            if offset == 0 {
                if reply.add(ino, 1, FileType::Directory, ".") {
                    return Ok(());
                }
                offset = 1;
            }
            if offset == 1 {
                let parent = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
                let parent = self.session.lookup(parent)?;
                let full = reply.add(INodeNo(parent.id), 2, FileType::Directory, "..");
                self.session.forget_cached(&parent)?;
                if full {
                    return Ok(());
                }
                offset = 2;
            }
            let mut after = self
                .handles
                .lock()
                .map_err(|_| unsupported("Native handle registry failed"))?
                .handles
                .get(&fh.0)
                .and_then(|h| h.cookies.get(&offset))
                .cloned()
                .ok_or_else(|| unsupported("Directory position is not from this native handle"))?;
            loop {
                // Batching is an internal metadata transfer, not an enumeration
                // limit. Stop only when the actual kernel reply buffer is full.
                let page = self
                    .session
                    .directory_after(&directory, after.take(), 128)?;
                for entry in page.entries {
                    let selected = if directory.is_empty() {
                        entry.name.clone()
                    } else {
                        format!("{directory}/{}", entry.name)
                    };
                    // Plain readdir does not establish a FUSE lookup reference.
                    let node = self.session.lookup(&selected)?;
                    let kind = self.attr(&node)?.kind;
                    let next = offset
                        .checked_add(1)
                        .ok_or_else(|| unsupported("Native directory cookie space exhausted"))?;
                    let full = reply.add(INodeNo(node.id), next, kind, &entry.name);
                    self.session.forget_cached(&node)?;
                    if full {
                        return Ok(());
                    }
                    self.handles
                        .lock()
                        .map_err(|_| unsupported("Native handle registry failed"))?
                        .handles
                        .get_mut(&fh.0)
                        .ok_or_else(|| unsupported("Directory handle was released"))?
                        .cookies
                        .insert(next, Some(entry.name.clone()));
                    after = Some(entry.name);
                    offset = next;
                }
                if page.next.is_none() {
                    return Ok(());
                }
            }
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn releasedir(&self, _: &Request, _: INodeNo, fh: FileHandle, _: OpenFlags, reply: ReplyEmpty) {
        match self.release_handle(fh) {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn fsyncdir(&self, _: &Request, _: INodeNo, _: FileHandle, _: bool, reply: ReplyEmpty) {
        match self.session.flush_all() {
            Ok(()) => reply.ok(),
            Err(error) => reply.error(native(error)),
        }
    }
    fn statfs(&self, _: &Request, _: INodeNo, reply: ReplyStatfs) {
        match self.session.capacity() {
            Ok((total, free)) => reply.statfs(
                total / 4096,
                free / 4096,
                free / 4096,
                0,
                0,
                4096,
                255,
                4096,
            ),
            Err(error) => reply.error(native(error)),
        }
    }
}
pub(crate) struct Mount {
    native: Option<BackgroundSession>,
    session: Arc<WorkspaceSession>,
    target: std::path::PathBuf,
    previous_device: u64,
    handles: Arc<Mutex<Handles>>,
    open_boundary: Arc<std::sync::RwLock<()>>,
    closing: Arc<std::sync::atomic::AtomicBool>,
}
impl Mount {
    pub(crate) fn start(
        session: Arc<WorkspaceSession>,
        target: &Path,
    ) -> Result<Self, KernelError> {
        admit_target(target)?;
        session.mount_started();
        use std::os::unix::fs::MetadataExt;
        let previous_device = std::fs::metadata(target)?.dev();
        let root = session.lookup("")?;
        let handles = Arc::new(Mutex::new(Handles {
            next: 1,
            nodes: HashMap::from([(root.id, root)]),
            handles: HashMap::new(),
            lookups: HashMap::from([(1, 1)]),
        }));
        let open_boundary = Arc::new(std::sync::RwLock::new(()));
        let closing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let backend = Backend {
            session: session.clone(),
            handles: handles.clone(),
            open_boundary: open_boundary.clone(),
            closing: closing.clone(),
        };
        let mut options = Config::default();
        options.mount_options = vec![
            MountOption::FSName("Varin Workspace".into()),
            MountOption::RW,
            MountOption::DefaultPermissions,
        ];
        #[cfg(target_os = "linux")]
        {
            options.n_threads = Some(
                std::thread::available_parallelism()
                    .map(usize::from)
                    .unwrap_or(1),
            );
        }
        let native = spawn_mount(backend, target, &options).map_err(|error| {
            KernelError::Storage(format!("Workspace FUSE mount failed: {error}"))
        })?;
        Ok(Self {
            native: Some(native),
            session,
            target: target.to_owned(),
            previous_device,
            handles,
            open_boundary,
            closing,
        })
    }
    /// A running dispatcher is not yet a ready macOS mount. Keep the Mount
    /// object while waiting, so cancellation/failure retains cleanup ownership.
    pub(crate) fn wait_ready(&self) -> Result<(), KernelError> {
        self.wait_ready_cancelled(&std::sync::atomic::AtomicBool::new(false))
    }
    pub(crate) fn wait_ready_cancelled(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<(), KernelError> {
        use std::os::unix::fs::MetadataExt;
        loop {
            if cancelled.load(std::sync::atomic::Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            self.session.check_open()?;
            let native = self
                .native
                .as_ref()
                .ok_or_else(|| unsupported("Workspace mount is detached"))?;
            if native.guard.is_finished() {
                return Err(KernelError::Storage(
                    "Workspace dispatcher stopped before mount readiness".into(),
                ));
            }
            match std::fs::metadata(&self.target) {
                Ok(metadata) if metadata.dev() != self.previous_device && metadata.ino() == 1 => {
                    return Ok(())
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotConnected
                    ) => {}
                Err(error) => return Err(error.into()),
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    /// FUSE does not identify which writable opens still own an mmap. A final
    /// release drains that file reference, including its mappings. Reject an
    /// unfenceable active writer explicitly; cached reads and mmap stay enabled.
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
        let handles = self
            .handles
            .lock()
            .map_err(|_| unsupported("Native handle registry failed"))?;
        let writers = handles
            .handles
            .values()
            .filter(|handle| {
                handle._content.is_some() && handle.flags & libc::O_ACCMODE != libc::O_RDONLY
            })
            .map(|handle| handle.node.clone())
            .collect::<Vec<_>>();
        if self.closing.load(std::sync::atomic::Ordering::Acquire) {
            return Err(unsupported("The original native mount is closing"));
        }
        drop(handles);
        self.session.checkpoint_native(selected, &writers, &[])
    }

    pub(crate) fn stop(&mut self) -> Result<(), KernelError> {
        if self.native.as_ref().is_some_and(|native|native.guard.is_finished()){
            self.native.take().unwrap().join().map_err(|error|KernelError::Storage(format!("Workspace callback drainage failed: {error}")))?;
            // The dispatcher and all its workers have really stopped. These
            // callbacks can no longer deliver Release; retain dirty namespace
            // state in Session while dropping their unreachable handle cache.
            let mut handles=self.handles.lock().map_err(|_|unsupported("Native handle registry failed"))?;
            handles.handles.clear();handles.nodes.clear();handles.lookups.clear();
            drop(handles);return self.session.close();
        }
        {
            let _opens = self
                .open_boundary
                .write()
                .map_err(|_| unsupported("Native open boundary failed"))?;
            self.closing
                .store(true, std::sync::atomic::Ordering::Release);
            let remaining = self
                .handles
                .lock()
                .map_err(|_| unsupported("Native handle registry failed"))?
                .handles
                .len();
            if remaining != 0 {
                return Err(KernelError::Execution(varin_runtime::execution::ExecutionError::new("workspace_native_handles_active",format!("Waiting for {remaining} original native file/directory handles to close before detaching the workspace"))));
            }
        }
        if let Some(native) = self.native.as_mut() {
            native.unmount().map_err(|error| {
                KernelError::Storage(format!("Workspace FUSE detach failed: {error}"))
            })?;
            self.native.take().unwrap().join().map_err(|error| {
                KernelError::Storage(format!("Workspace FUSE callback drainage failed: {error}"))
            })?;
        }
        self.session.close()
    }
}
