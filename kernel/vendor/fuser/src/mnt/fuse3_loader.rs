//! Delayed system-library admission. macFUSE is optional at application startup;
//! its library remains loaded for the complete lifetime of all native sessions.
use super::{fuse2_sys::fuse_args, fuse3_sys::fuse_lowlevel_ops};
use libc::{c_char, c_int, c_void, size_t};
use std::{io, sync::OnceLock};

#[derive(Debug)]
pub(super) struct Api {
    pub new: unsafe extern "C" fn(
        *const fuse_args,
        *const fuse_lowlevel_ops,
        size_t,
        *mut c_void,
    ) -> *mut c_void,
    pub mount: unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int,
    pub fd: unsafe extern "C" fn(*mut c_void) -> c_int,
    pub unmount: unsafe extern "C" fn(*mut c_void),
    pub destroy: unsafe extern "C" fn(*mut c_void),
}
impl Api {
    pub(super) fn load() -> io::Result<&'static Self> {
        static API: OnceLock<Api> = OnceLock::new();
        if let Some(api) = API.get() {
            return Ok(api);
        }
        #[cfg(not(target_os = "macos"))]
        let api = Self {
            new: super::fuse3_sys::fuse_session_new,
            mount: super::fuse3_sys::fuse_session_mount,
            fd: super::fuse3_sys::fuse_session_fd,
            unmount: super::fuse3_sys::fuse_session_unmount,
            destroy: super::fuse3_sys::fuse_session_destroy,
        };
        #[cfg(target_os = "macos")]
        let api = {
            static LOAD: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _load = LOAD
                .lock()
                .map_err(|_| io::Error::other("macFUSE library loader failed"))?;
            if let Some(api) = API.get() {
                return Ok(api);
            }
            let mut library = std::ptr::null_mut();
            for file in [
                c"/usr/local/lib/libfuse3.dylib",
                c"/Library/Filesystems/macfuse.fs/Contents/Frameworks/libfuse3.dylib",
            ] {
                // Only the installed system component is loaded; project cwd,
                // environment search paths and executable neighbors are ignored.
                library = unsafe { libc::dlopen(file.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
                if !library.is_null() {
                    break;
                }
            }
            if library.is_null() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "macFUSE with libfuse3 is unavailable. Install/enable it from https://macfuse.github.io/ before enabling a versioned workspace",
                ));
            }
            macro_rules! symbol {
                ($name:literal,$ty:ty) => {{
                    let value =
                        unsafe { libc::dlsym(library, concat!($name, "\0").as_ptr().cast()) };
                    if value.is_null() {
                        unsafe { libc::dlclose(library) };
                        return Err(io::Error::new(
                            io::ErrorKind::Unsupported,
                            concat!("Installed macFUSE is missing ", $name),
                        ));
                    }
                    unsafe { std::mem::transmute::<*mut c_void, $ty>(value) }
                }};
            }
            let api = Self {
                new: symbol!(
                    "fuse_session_new",
                    unsafe extern "C" fn(
                        *const fuse_args,
                        *const fuse_lowlevel_ops,
                        size_t,
                        *mut c_void,
                    ) -> *mut c_void
                ),
                mount: symbol!(
                    "fuse_session_mount",
                    unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int
                ),
                fd: symbol!(
                    "fuse_session_fd",
                    unsafe extern "C" fn(*mut c_void) -> c_int
                ),
                unmount: symbol!("fuse_session_unmount", unsafe extern "C" fn(*mut c_void)),
                destroy: symbol!("fuse_session_destroy", unsafe extern "C" fn(*mut c_void)),
            };
            // The process-wide API owns this successful dlopen reference.
            API.set(api)
                .map_err(|_| io::Error::other("macFUSE API publication changed"))?;
            return Ok(API.get().expect("published native API"));
        };
        #[cfg(not(target_os = "macos"))]
        {
            let _ = API.set(api);
            Ok(API.get().expect("published native API"))
        }
    }
}
