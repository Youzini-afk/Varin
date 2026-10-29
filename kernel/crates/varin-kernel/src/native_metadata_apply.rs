//! Attribute effects run on the original file worker, after admission and before
//! its original receipt is committed. Native mounts use Session::import_attributes;
//! these functions are the explicit ordinary-filesystem export path.
use super::*;
use varin_runtime::catalog::followups::FileMetadata;

pub(crate) fn validate_apply(path: &Path, value: &FileMetadata) -> Result<(), KernelError> {
    crate::storage::workspace_metadata::validate_file_metadata(value)?;
    #[cfg(unix)]
    {
        if value.security.is_some()
            || value.reparse_data.is_some()
            || value.windows_attributes & !0x30 != 0
        {
            return Err(KernelError::Operation("native_attributes_unsupported: Windows security or reparse attributes require a native workspace or Windows target".into()));
        }
        #[cfg(not(target_os = "macos"))]
        if value.created.is_some() || value.backup.is_some() {
            return Err(KernelError::Operation("native_attributes_unsupported: ordinary Unix targets cannot restore this recorded creation or backup time; use a native workspace".into()));
        }
        #[cfg(not(target_os = "macos"))]
        if value.bsd_flags != 0 {
            return Err(KernelError::Operation("native_attributes_unsupported: BSD flags require a native workspace or macOS target".into()));
        }
    }
    #[cfg(windows)]
    {
        if value.uid != 0
            || value.gid != 0
            || value.bsd_flags != 0
            || !value.xattrs.is_empty()
            || value.backup.is_some()
        {
            return Err(KernelError::Operation("native_attributes_unsupported: Unix ownership, xattrs or backup time require a native workspace or supporting Unix target".into()));
        }
    }
    let _ = path;
    Ok(())
}

pub(crate) fn apply(
    path: &Path,
    mode: Option<u32>,
    value: &FileMetadata,
) -> Result<(), KernelError> {
    validate_apply(path, value)?;
    #[cfg(unix)]
    {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let name = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| KernelError::Operation("NUL in file path".into()))?;
        let prior = observe(path)?;
        #[cfg(target_os = "macos")]
        {
            // Darwin's attribute list restores birth/backup times without
            // following a symlink. Linux has no equivalent birth-time setter.
            let mut attributes = libc::attrlist {
                bitmapcount: 5,
                reserved: 0,
                commonattr: 0,
                volattr: 0,
                dirattr: 0,
                fileattr: 0,
                forkattr: 0,
            };
            let mut times = Vec::<libc::timespec>::new();
            if let Some(created) = value.created {
                attributes.commonattr |= libc::ATTR_CMN_CRTIME;
                times.push(libc::timespec {
                    tv_sec: created.seconds,
                    tv_nsec: created.nanos.into(),
                });
            }
            if value.backup != prior.attributes.file_metadata()?.backup {
                attributes.commonattr |= libc::ATTR_CMN_BKUPTIME;
                let backup =
                    value
                        .backup
                        .unwrap_or(varin_runtime::catalog::followups::FileTimestamp {
                            seconds: 0,
                            nanos: 0,
                        });
                times.push(libc::timespec {
                    tv_sec: backup.seconds,
                    tv_nsec: backup.nanos.into(),
                });
            }
            if !times.is_empty()
                && unsafe {
                    libc::setattrlist(
                        name.as_ptr(),
                        (&mut attributes as *mut libc::attrlist).cast(),
                        times.as_mut_ptr().cast(),
                        times.len() * std::mem::size_of::<libc::timespec>(),
                        libc::FSOPT_NOFOLLOW,
                    )
                } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        if prior.attributes.uid != value.uid || prior.attributes.gid != value.gid {
            if unsafe { libc::lchown(name.as_ptr(), value.uid, value.gid) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        // Exact set, including removal. Xattr bytes never pass through UTF-8.
        for key in prior
            .attributes
            .xattrs
            .keys()
            .filter(|key| !value.xattrs.contains_key(*key))
        {
            let key = CString::new(
                URL_SAFE_NO_PAD
                    .decode(key)
                    .map_err(|_| KernelError::Operation("Invalid xattr name".into()))?,
            )
            .map_err(|_| KernelError::Operation("NUL in xattr name".into()))?;
            #[cfg(target_os = "macos")]
            let result =
                unsafe { libc::removexattr(name.as_ptr(), key.as_ptr(), libc::XATTR_NOFOLLOW) };
            #[cfg(not(target_os = "macos"))]
            let result = unsafe { libc::lremovexattr(name.as_ptr(), key.as_ptr()) };
            if result != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        for (key, bytes) in &value.xattrs {
            if prior.attributes.xattrs.get(key) == Some(bytes) {
                continue;
            }
            let key = CString::new(
                URL_SAFE_NO_PAD
                    .decode(key)
                    .map_err(|_| KernelError::Operation("Invalid xattr name".into()))?,
            )
            .map_err(|_| KernelError::Operation("NUL in xattr name".into()))?;
            #[cfg(target_os = "macos")]
            let result = unsafe {
                libc::setxattr(
                    name.as_ptr(),
                    key.as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                    libc::XATTR_NOFOLLOW,
                )
            };
            #[cfg(not(target_os = "macos"))]
            let result = unsafe {
                libc::lsetxattr(
                    name.as_ptr(),
                    key.as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            };
            if result != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        if !matches!(prior.kind, Kind::Symlink(_)) {
            crate::storage::file_resources::apply_mode(path, mode)?;
        }
        let modified = libc::timespec {
            tv_sec: value
                .modified
                .seconds
                .try_into()
                .map_err(|_| KernelError::Operation("Timestamp outside native range".into()))?,
            tv_nsec: value.modified.nanos.into(),
        };
        let times = [
            libc::timespec {
                tv_sec: 0,
                tv_nsec: libc::UTIME_OMIT,
            },
            modified,
        ];
        if unsafe {
            libc::utimensat(
                libc::AT_FDCWD,
                name.as_ptr(),
                times.as_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        #[cfg(target_os = "macos")]
        if prior.attributes.bsd_flags != value.bsd_flags
            && unsafe { libc::lchflags(name.as_ptr(), value.bsd_flags) } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::{
            Security::{
                DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
                SetKernelObjectSecurity,
            },
            Storage::FileSystem::{
                FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
                FILE_WRITE_ATTRIBUTES, FileBasicInfo, SetFileInformationByHandle,
            },
            System::{IO::DeviceIoControl, Ioctl::FSCTL_SET_REPARSE_POINT},
        };
        let previous = observe(path)?;
        let security_changed = value.security != previous.attributes.security;
        let reparse_changed = value.reparse_data != previous.attributes.reparse_data;
        let access = FILE_WRITE_ATTRIBUTES
            | if security_changed && value.security.is_some() {
                0x40000 | 0x80000
            } else {
                0
            }
            | if reparse_changed && value.reparse_data.is_some() {
                0x40000000
            } else {
                0
            };
        let file = fs::OpenOptions::new()
            .access_mode(access)
            .share_mode(7)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        if let Some(bytes) = value.reparse_data.as_ref().filter(|_| reparse_changed) {
            let mut returned = 0;
            if unsafe {
                DeviceIoControl(
                    file.as_raw_handle().cast(),
                    FSCTL_SET_REPARSE_POINT,
                    bytes.as_ptr().cast(),
                    bytes
                        .len()
                        .try_into()
                        .map_err(|_| KernelError::Operation("Reparse data is too large".into()))?,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        if let Some(bytes) = value.security.as_ref().filter(|_| security_changed) {
            if unsafe {
                SetKernelObjectSecurity(
                    file.as_raw_handle().cast(),
                    OWNER_SECURITY_INFORMATION
                        | GROUP_SECURITY_INFORMATION
                        | DACL_SECURITY_INFORMATION,
                    bytes.as_ptr().cast_mut().cast(),
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        let mut flags = value.windows_attributes;
        if let Some(mode) = mode {
            if mode & 0o222 == 0 {
                flags |= 1;
            } else {
                flags &= !1;
            }
        }
        // Zero means "leave attributes unchanged" to FileBasicInfo. NORMAL
        // explicitly clears ARCHIVE/HIDDEN/etc. for an empty requested set.
        if flags == 0 { flags = 0x80; }
        let mut basic = FILE_BASIC_INFO {
            CreationTime: value
                .created
                .map(|v| {
                    Timestamp {
                        seconds: v.seconds,
                        nanos: v.nanos,
                    }
                    .filetime()
                })
                .transpose()?
                .unwrap_or(0) as i64,
            LastAccessTime: 0,
            LastWriteTime: Timestamp {
                seconds: value.modified.seconds,
                nanos: value.modified.nanos,
            }
            .filetime()? as i64,
            ChangeTime: 0,
            FileAttributes: flags,
        };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle().cast(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err(KernelError::Operation(
        "Native attributes are unsupported on this platform".into(),
    ));
    Ok(())
}
