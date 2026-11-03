//! Read the running renderers' OS enforcement state, never the requested config.
use super::{BrowserViews, Reply};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
#[derive(Clone)]
struct Process {
    pid: u32,
    parent: u32,
    renderer: bool,
    no_sandbox: bool,
}
fn descendants(processes: &[Process]) -> Vec<Process> {
    let mut owned = HashSet::from([std::process::id()]);
    loop {
        let before = owned.len();
        for p in processes {
            if owned.contains(&p.parent) {
                owned.insert(p.pid);
            }
        }
        if owned.len() == before {
            break;
        }
    }
    processes
        .iter()
        .filter(|p| p.renderer && owned.contains(&p.pid))
        .cloned()
        .collect()
}
pub async fn observe(_app: &tauri::AppHandle, browser: &BrowserViews, page: &str) -> Reply {
    let page = super::wait_page(browser, page).await?;
    let observed = native().await?;
    if observed.as_array().is_none_or(|a| a.is_empty()) {
        return Err("No actual sandboxed renderer could be observed".into());
    }
    Ok(json!({"livePage":page,"renderers":observed,"source":"operating-system"}))
}
#[cfg(target_os = "linux")]
async fn native() -> Reply {
    use std::fs;
    fn status(pid: u32) -> Result<HashMap<String, String>, String> {
        Ok(fs::read_to_string(format!("/proc/{pid}/status"))
            .map_err(|e| format!("Renderer status is not observable: {e}"))?
            .lines()
            .filter_map(|l| l.split_once(':').map(|(k, v)| (k.into(), v.trim().into())))
            .collect())
    }
    let mut processes = Vec::new();
    for entry in fs::read_dir("/proc").map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = status(pid) else { continue };
        let Some(parent) = stat.get("PPid").and_then(|s| s.parse().ok()) else {
            continue;
        };
        let bytes = fs::read(entry.path().join("cmdline")).unwrap_or_default();
        let args: Vec<_> = bytes.split(|b| *b == 0).collect();
        processes.push(Process {
            pid,
            parent,
            renderer: args.iter().any(|s| *s == b"--type=renderer"),
            no_sandbox: args.iter().any(|s| *s == b"--no-sandbox"),
        });
    }
    let own = status(std::process::id())?;
    let depth = |s: &HashMap<String, String>| {
        s.get("NSpid")
            .map(|v| v.split_whitespace().count())
            .unwrap_or(0)
    };
    let mut facts = Vec::new();
    for process in descendants(&processes) {
        let s = status(process.pid)?;
        let valid = !process.no_sandbox
            && s.get("Seccomp").map(String::as_str) == Some("2")
            && s.get("NoNewPrivs").map(String::as_str) == Some("1")
            && s.get("CapEff")
                .and_then(|s| u64::from_str_radix(s, 16).ok())
                == Some(0)
            && depth(&s) > depth(&own);
        if !valid {
            return Err(format!(
                "Renderer {} lacks observable seccomp, no-new-privileges, zero capabilities or its own PID namespace",
                process.pid
            ));
        }
        facts.push(json!({"pid":process.pid,"seccomp":s.get("Seccomp"),"seccompFilters":s.get("Seccomp_filters"),"noNewPrivileges":s.get("NoNewPrivs"),"effectiveCapabilities":s.get("CapEff"),"pidNamespaceDepth":depth(&s),"brokerNamespaceDepth":depth(&own),"noSandboxSwitch":false}));
    }
    Ok(json!(facts))
}
#[cfg(target_os = "macos")]
async fn native() -> Reply {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    // sandbox_check is the same native seatbelt diagnostic used by WebKit.
    // https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/spi/darwin/SandboxSPI.h
    #[link(name = "sandbox")]
    unsafe extern "C" {
        fn sandbox_check(pid: i32, operation: *const std::ffi::c_char, kind: i32, ...) -> i32;
    }
    let output = tokio::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,args="])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Native process ancestry could not be observed".into());
    }
    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut words = line.split_whitespace();
        let (Some(pid), Some(parent)) = (
            words.next().and_then(|s| s.parse().ok()),
            words.next().and_then(|s| s.parse().ok()),
        ) else {
            continue;
        };
        let args: Vec<_> = words.collect();
        processes.push(Process {
            pid,
            parent,
            renderer: args.contains(&"--type=renderer"),
            no_sandbox: args.contains(&"--no-sandbox"),
        });
    }
    let path = std::env::var_os("VARIN_DATA_DIR").ok_or("Smoke data root missing")?;
    let path = CString::new(
        std::path::PathBuf::from(path)
            .join("sandbox-write-probe")
            .as_os_str()
            .as_bytes(),
    )
    .map_err(|_| "Invalid smoke root")?;
    let own = unsafe {
        sandbox_check(
            std::process::id() as i32,
            c"file-write-create".as_ptr(),
            1,
            path.as_ptr(),
        )
    };
    if own != 0 {
        return Err("Broker access to the fixed sandbox probe is not observable".into());
    }
    let mut facts = Vec::new();
    for p in descendants(&processes) {
        let denied = unsafe {
            sandbox_check(
                p.pid as i32,
                c"file-write-create".as_ptr(),
                1,
                path.as_ptr(),
            )
        };
        if denied <= 0 || p.no_sandbox {
            return Err(format!(
                "Renderer {} did not have an observable seatbelt write restriction",
                p.pid
            ));
        }
        facts.push(json!({"pid":p.pid,"seatbeltWriteDenied":true,"brokerWriteAllowed":true,"noSandboxSwitch":false}));
    }
    Ok(json!(facts))
}
#[cfg(windows)]
async fn native() -> Reply {
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Security::*,
        System::{JobObjects::IsProcessInJob, Threading::*},
    };
    // CIM exposes the actual command line and parent PID. Return only booleans and
    // PIDs, never command lines that might contain another process's secrets.
    let executable = std::path::PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?,
    )
    .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let script = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;renderer=[bool]($_.CommandLine -match '(?:^|\\s)--type=renderer(?:\\s|$)');noSandbox=[bool]($_.CommandLine -match '(?:^|\\s)--no-sandbox(?:\\s|$)')} }) | ConvertTo-Json -Compress";
    let output = tokio::process::Command::new(executable)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Native renderer process ancestry could not be observed".into());
    }
    let records: Vec<Value> =
        serde_json::from_slice(&output.stdout).map_err(|_| "Invalid native process observation")?;
    let processes: Vec<_> = records
        .into_iter()
        .filter_map(|v| {
            Some(Process {
                pid: v["pid"].as_u64()? as u32,
                parent: v["parent"].as_u64()? as u32,
                renderer: v["renderer"].as_bool()?,
                no_sandbox: v["noSandbox"].as_bool()?,
            })
        })
        .collect();
    let mut facts = Vec::new();
    for p in descendants(&processes) {
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, p.pid) };
        if raw.is_null() {
            return Err(format!("Renderer {} token is not observable", p.pid));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut token) } == 0 {
            return Err("Renderer token query failed".into());
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let restricted = unsafe { IsTokenRestricted(token.as_raw_handle()) } != 0;
        let mut returned = 0;
        let mut buffer = [0usize; 512];
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenIntegrityLevel,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer) as u32,
                &mut returned,
            )
        } == 0
        {
            return Err("Renderer integrity level is not observable".into());
        }
        let label = unsafe { &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
        let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) };
        if count == 0 {
            return Err("Invalid native integrity SID".into());
        }
        let integrity = unsafe { *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)) };
        let mut container = 0u32;
        if unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenIsAppContainer,
                (&mut container as *mut u32).cast(),
                4,
                &mut returned,
            )
        } == 0
        {
            return Err("Renderer app container state is not observable".into());
        }
        let mut in_job = 0;
        if unsafe { IsProcessInJob(process.as_raw_handle(), ptr::null_mut(), &mut in_job) } == 0 {
            return Err("Renderer job membership is not observable".into());
        }
        if p.no_sandbox || (!restricted && container == 0) || integrity > 0x1000 || in_job == 0 {
            return Err(format!(
                "Renderer {} lacks a restricted token, low integrity or job confinement",
                p.pid
            ));
        }
        facts.push(json!({"pid":p.pid,"restrictedToken":restricted,"appContainer":container!=0,"integrityRid":integrity,"inJob":true,"noSandboxSwitch":false}));
    }
    Ok(json!(facts))
}
