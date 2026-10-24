//! Volatile capture reuse uses a file identity and the filesystem's change time,
//! never just user-restorable mtime/length. Unsupported identities force a read.
use super::*;

pub(super) fn capture_identity(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!("{}:{}:{}:{}:{}:{}:{}:{}", metadata.dev(), metadata.ino(),
            metadata.ctime(), metadata.ctime_nsec(), metadata.mtime(), metadata.mtime_nsec(), metadata.len(), metadata.mode()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, GetFileInformationByHandleEx,
            BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};
        let file = OpenOptions::new().access_mode(0).custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(path).ok()?;
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        let mut identity: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let handle = file.as_raw_handle();
        if unsafe { GetFileInformationByHandle(handle, &mut identity) } == 0
            || unsafe { GetFileInformationByHandleEx(handle, FileBasicInfo, (&mut basic as *mut FILE_BASIC_INFO).cast(), std::mem::size_of::<FILE_BASIC_INFO>() as u32) } == 0 { return None; }
        if basic.ChangeTime <= 0 || identity.nFileIndexHigh == 0 && identity.nFileIndexLow == 0 { return None; }
        Some(format!("{}:{}:{}:{}:{}:{}:{}:{}", identity.dwVolumeSerialNumber, identity.nFileIndexHigh,
            identity.nFileIndexLow, basic.CreationTime, basic.ChangeTime, basic.LastWriteTime, metadata.len(), basic.FileAttributes))
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = metadata; None }
}
