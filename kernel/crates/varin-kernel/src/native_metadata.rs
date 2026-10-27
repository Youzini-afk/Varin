//! Physical source observations used only on an I/O worker. Native identities,
//! permissions and attributes are captured with bytes, never synthesized from
//! the import date. Access time is excluded from verification because reading a
//! source may itself update it.
use crate::{
    error::KernelError,
    storage::workspace_metadata::{Attributes, Timestamp},
};
use std::{collections::BTreeMap, fs, path::Path};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    File,
    Directory,
    Symlink(String),
}
#[derive(Clone, Debug)]
pub(crate) struct Observation {
    pub kind: Kind,
    pub identity: String,
    pub length: u64,
    pub attributes: Attributes,
}
impl Observation {
    pub(crate) fn same(&self, other: &Self) -> bool {
        let mut compared = other.attributes.clone();
        compared.accessed = self.attributes.accessed;
        self.identity == other.identity
            && self.kind == other.kind
            && self.length == other.length
            && self.attributes == compared
    }
}
pub(crate) fn observe(path: &Path) -> Result<Observation, KernelError> {
    let meta = fs::symlink_metadata(path)?;
    #[allow(unused_mut)]
    let mut kind = if meta.file_type().is_symlink() {
        Kind::Symlink(
            fs::read_link(path)?
                .into_os_string()
                .into_string()
                .map_err(|_| {
                    KernelError::Operation(
                        "Source symlink target is outside the native name contract".into(),
                    )
                })?,
        )
    } else if meta.is_file() {
        Kind::File
    } else if meta.is_dir() {
        Kind::Directory
    } else {
        return Err(KernelError::Operation(format!(
            "Source contains an unsupported native file type: {}",
            path.display()
        )));
    };
    let modified = Timestamp::from_time(meta.modified()?);
    let created = meta.created().map(Timestamp::from_time).unwrap_or(modified);
    let accessed = Timestamp::from_time(meta.accessed()?);
    let mut attributes = Attributes {
        file_id: Uuid::nil(),
        mode: if meta.is_dir() {
            0o755
        } else if meta.permissions().readonly() {
            0o444
        } else {
            0o644
        },
        uid: 0,
        gid: 0,
        created,
        accessed,
        modified,
        changed: modified,
        backup: None,
        windows_attributes: if meta.is_dir() { 0x10 } else { 0 },
        bsd_flags: 0,
        security: None,
        reparse_data: None,
        xattrs: BTreeMap::new(),
    };
    let identity;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        identity = format!("{}:{}", meta.dev(), meta.ino());
        attributes.mode = meta.mode() & 0o7777;
        attributes.uid = meta.uid();
        attributes.gid = meta.gid();
        attributes.modified = Timestamp {
            seconds: meta.mtime(),
            nanos: meta.mtime_nsec() as u32,
        };
        attributes.accessed = Timestamp {
            seconds: meta.atime(),
            nanos: meta.atime_nsec() as u32,
        };
        attributes.changed = Timestamp {
            seconds: meta.ctime(),
            nanos: meta.ctime_nsec() as u32,
        };
        if meta.created().is_err() {
            attributes.created = attributes.changed;
        }
        #[cfg(target_os = "macos")]
        {
            use std::os::macos::fs::MetadataExt as _;
            attributes.bsd_flags = meta.st_flags();
        }
        attributes.xattrs = xattrs(path)?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        };
        use windows_sys::Win32::{
            Security::{
                GetKernelObjectSecurity, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION,
                OWNER_SECURITY_INFORMATION,
            },
            Storage::FileSystem::{
                GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            },
        };
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | 0x20000)
            .share_mode(7)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        identity = format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        );
        attributes.created = Timestamp::from_filetime(meta.creation_time());
        attributes.accessed = Timestamp::from_filetime(meta.last_access_time());
        attributes.modified = Timestamp::from_filetime(meta.last_write_time());
        // std exposes no Windows change time. Query the same open identity.
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
        };
        let mut basic = FILE_BASIC_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle().cast(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        attributes.changed = Timestamp::from_filetime(basic.ChangeTime as u64);
        attributes.windows_attributes = meta.file_attributes();
        if attributes.windows_attributes & 0x400 != 0 {
            use windows_sys::Win32::System::{Ioctl::FSCTL_GET_REPARSE_POINT, IO::DeviceIoControl};
            let mut bytes = vec![0u8; crate::reparse_data::MAXIMUM_SIZE];
            let mut returned = 0;
            if unsafe {
                DeviceIoControl(
                    file.as_raw_handle().cast(),
                    FSCTL_GET_REPARSE_POINT,
                    std::ptr::null(),
                    0,
                    bytes.as_mut_ptr().cast(),
                    bytes.len() as u32,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            bytes.truncate(returned as usize);
            let reparse = crate::reparse_data::parse(&bytes)?;
            kind = Kind::Symlink(reparse.target);
            attributes.reparse_data = Some(bytes);
        }
        let information =
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let mut required = 0;
        unsafe {
            GetKernelObjectSecurity(
                file.as_raw_handle().cast(),
                information,
                std::ptr::null_mut(),
                0,
                &mut required,
            )
        };
        if required == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut security = vec![0u8; required as usize];
        if unsafe {
            GetKernelObjectSecurity(
                file.as_raw_handle().cast(),
                information,
                security.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        security.truncate(required as usize);
        attributes.security = Some(security);
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(KernelError::Operation(
            "Native source metadata is unsupported on this platform".into(),
        ));
    }
    attributes.validate()?;
    // A directory's platform-reported storage size is not namespace content.
    let length = if matches!(kind, Kind::File) {
        meta.len()
    } else {
        0
    };
    Ok(Observation {
        kind,
        identity,
        length,
        attributes,
    })
}

#[cfg(unix)]
fn xattrs(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, KernelError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| KernelError::Operation("NUL in source path".into()))?;
    unsafe fn names(
        path: *const libc::c_char,
        out: *mut libc::c_char,
        size: usize,
    ) -> libc::ssize_t {
        #[cfg(target_os = "macos")]
        {
            unsafe { libc::listxattr(path, out, size, libc::XATTR_NOFOLLOW) }
        }
        #[cfg(not(target_os = "macos"))]
        {
            unsafe { libc::llistxattr(path, out, size) }
        }
    }
    unsafe fn value(
        path: *const libc::c_char,
        name: *const libc::c_char,
        out: *mut libc::c_void,
        size: usize,
    ) -> libc::ssize_t {
        #[cfg(target_os = "macos")]
        {
            unsafe { libc::getxattr(path, name, out, size, 0, libc::XATTR_NOFOLLOW) }
        }
        #[cfg(not(target_os = "macos"))]
        {
            unsafe { libc::lgetxattr(path, name, out, size) }
        }
    }
    let count = unsafe { names(path.as_ptr(), std::ptr::null_mut(), 0) };
    if count < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOTSUP) {
            return Ok(BTreeMap::new());
        }
        return Err(error.into());
    }
    let mut list = vec![0u8; count as usize];
    let count = unsafe { names(path.as_ptr(), list.as_mut_ptr().cast(), list.len()) };
    if count < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    list.truncate(count as usize);
    let mut result = BTreeMap::new();
    for name in list
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let encoded = URL_SAFE_NO_PAD.encode(name);
        let name = CString::new(name).unwrap();
        let size = unsafe { value(path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if size < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut data = vec![0; size as usize];
        let size = unsafe {
            value(
                path.as_ptr(),
                name.as_ptr(),
                data.as_mut_ptr().cast(),
                data.len(),
            )
        };
        if size < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        data.truncate(size as usize);
        result.insert(encoded, data);
    }
    Ok(result)
}
