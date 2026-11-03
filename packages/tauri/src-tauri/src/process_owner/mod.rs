//! Launch-bound ownership for native acceptance and performance tooling.
//!
//! This is deliberately independent of product desktop leases. Only receipts
//! from this original private guardian stream can release a launch's files.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows;

const MAX_FRAME: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Launch {
    pub nonce: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub windows_verbatim_arguments: bool,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RootExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub success: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Control {
    Stop {
        nonce: String,
        #[serde(rename = "forceAfterMs")]
        force_after_ms: u64,
    },
    Settle {
        nonce: String,
    },
}

pub fn read_frame(input: &mut impl Read) -> Result<Vec<u8>, String> {
    // Never buffer beyond the first frame: platform control owns the same pipe.
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        match input.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => return Ok(bytes),
            Ok(1) if bytes.len() < MAX_FRAME => bytes.push(byte[0]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            _ => return Err("Process owner control is unavailable or invalid".into()),
        }
    }
}

fn launch_frame() -> Result<Vec<u8>, String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::FromRawFd;
        // StdinLock has its own read-ahead buffer. Linux's subsequent poll loop
        // reads the raw pipe, so admission must not strand an early stop command
        // in stdio's private buffer. File performs unbuffered reads on this dup.
        let fd = unsafe { libc::fcntl(0, libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err("Process owner launch pipe is unavailable".into());
        }
        read_frame(&mut unsafe { std::fs::File::from_raw_fd(fd) })
    }
    #[cfg(not(target_os = "linux"))]
    {
        // The Windows control reader continues through the same Stdin buffer.
        read_frame(&mut std::io::stdin().lock())
    }
}

pub fn emit(nonce: &str, event: &str, fields: serde_json::Value) -> Result<(), String> {
    let mut object = fields.as_object().cloned().ok_or("Invalid owner receipt")?;
    object.insert("schema".into(), 1.into());
    object.insert("nonce".into(), nonce.into());
    object.insert("type".into(), event.into());
    let mut bytes = serde_json::to_vec(&object).map_err(|_| "Invalid owner receipt")?;
    bytes.push(b'\n');
    std::io::stdout()
        .lock()
        .write_all(&bytes)
        .map_err(|_| "Process owner receipt was not delivered".into())
}

/// The binary calls this before starting any runtime or other threads.
pub fn run() -> Result<(), String> {
    let launch: Launch =
        serde_json::from_slice(&launch_frame()?).map_err(|_| "Invalid process owner launch")?;
    if launch.nonce.is_empty()
        || launch.nonce.len() > 128
        || !launch
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        || !std::path::Path::new(&launch.executable).is_absolute()
        || launch
            .cwd
            .as_ref()
            .is_some_and(|cwd| !std::path::Path::new(cwd).is_absolute())
        || launch
            .env
            .keys()
            .any(|key| key.is_empty() || key.contains('='))
    {
        return Err("Invalid process owner launch".into());
    }
    if launch.windows_verbatim_arguments && !cfg!(windows) {
        return Err("Verbatim Windows arguments are unsupported on this platform".into());
    }
    #[cfg(target_os = "linux")]
    return linux::run(launch);
    #[cfg(windows)]
    return windows::run(launch);
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = launch;
        Err("Launch-bound descendant ownership is unsupported on this platform".into())
    }
}
