//! One-shot access to the original settings owner. A frontend-only desktop does
//! not keep a Node coordinator or an Application Host running while idle.
use crate::manifest::{RuntimePaths, contained_file};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub fn data_directory() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("VARIN_DATA_DIR").filter(|p| !p.is_empty()) {
        let path = PathBuf::from(path);
        return if path.is_absolute() {
            Ok(path)
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .map_err(|_| "Working directory is unavailable".into())
        };
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("Home directory is unavailable")?;
    #[cfg(target_os = "windows")]
    {
        Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Varin"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(home.join("Library/Application Support/Varin"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("varin"))
    }
}

#[derive(Clone)]
pub struct Owner {
    state: Arc<Mutex<(bool, usize)>>,
    changed: tokio::sync::watch::Sender<usize>,
}
impl Default for Owner {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            changed: tokio::sync::watch::channel(0).0,
        }
    }
}
struct Lease(Owner);
impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.1 -= 1;
        self.0.changed.send_replace(state.1);
    }
}
impl Owner {
    pub async fn call(
        &self,
        runtime: &RuntimePaths,
        data_dir: &Path,
        method: &str,
        args: Value,
        context: Value,
    ) -> Result<Value, String> {
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Settings process owner unavailable")?;
            if state.0 {
                return Err("Settings owner is shutting down".into());
            }
            if state.1 >= 32 {
                return Err("Settings operation capacity reached".into());
            }
            state.1 += 1;
            self.changed.send_replace(state.1);
        }
        let lease = Lease(self.clone());
        let runtime = runtime.clone();
        let data_dir = data_dir.to_owned();
        let method = method.to_owned();
        // Losing a renderer waiter must not abandon an atomic settings write or
        // its process. The native owner keeps this task and its child to exit.
        tokio::spawn(async move {
            let _lease = lease;
            call(&runtime, &data_dir, &method, args, context).await
        })
        .await
        .map_err(|_| "Settings task ended; write outcome is unknown".to_owned())?
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Settings process owner unavailable")?
            .0 = true;
        let mut observed = self.changed.subscribe();
        loop {
            if *observed.borrow_and_update() == 0 {
                return Ok(());
            }
            observed
                .changed()
                .await
                .map_err(|_| "Settings process drain is unknown")?;
        }
    }
    pub fn resume(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.0 = false;
        }
    }
}

async fn call(
    runtime: &RuntimePaths,
    data_dir: &Path,
    method: &str,
    args: Value,
    context: Value,
) -> Result<Value, String> {
    let relative = &runtime.manifest.host.settings_entry;
    runtime.verify_file(relative).map_err(|e| e.to_string())?;
    let entry = contained_file(&runtime.root, relative).map_err(|e| e.to_string())?;
    let request =
        serde_json::to_vec(&json!({"version":1,"method":method,"args":args,"context":context}))
            .map_err(|_| "Settings request could not be encoded")?;
    if request.len() > 16 * 1024 * 1024 {
        return Err("Settings request exceeds its byte budget".into());
    }
    let mut command = Command::new(&runtime.node);
    command
        .arg(entry)
        .env("VARIN_DATA_DIR", data_dir)
        .env("VARIN_NODE_PATH", &runtime.node)
        .env_remove("NODE_OPTIONS")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "Desktop settings owner could not start")?;
    let mut stdin = child.stdin.take().expect("piped settings stdin");
    let mut stdout = child.stdout.take().expect("piped settings stdout");
    let write = async move {
        let result = stdin.write_all(&request).await;
        drop(stdin);
        result
    };
    let read = async move {
        const LIMIT: u64 = 64 * 1024 * 1024;
        let mut bytes = Vec::new();
        (&mut stdout)
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Settings response was lost")?;
        if bytes.len() as u64 > LIMIT {
            // Drain without retaining further secret bytes, allowing the original
            // helper to exit rather than leave it blocked on a full stdout pipe.
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
            return Err("Settings response exceeds its byte budget");
        }
        Ok(bytes)
    };
    let (written, output, status) = tokio::join!(write, read, child.wait());
    written.map_err(|_| "Desktop settings request failed; effect outcome is unknown")?;
    let output = output?;
    let status = status.map_err(|_| "Desktop settings termination is unknown")?;
    // Never include stdout/stderr in diagnostic strings: both can carry secrets.
    let response: Value =
        serde_json::from_slice(&output).map_err(|_| "Desktop settings response is malformed")?;
    if response["version"] != 1 || response["ok"] != true || !status.success() {
        return Err(
            "Desktop settings could not be read or changed; original data was retained".into(),
        );
    }
    Ok(response["result"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn shutdown_waits_for_the_original_lease_and_can_resume_after_cancelled_quit() {
        let owner = Owner::default();
        {
            let mut state = owner.state.lock().unwrap();
            state.1 = 1;
            owner.changed.send_replace(1);
        }
        let lease = Lease(owner.clone());
        let waiting = owner.clone();
        let shutdown = tokio::spawn(async move { waiting.shutdown().await });
        tokio::task::yield_now().await;
        assert!(!shutdown.is_finished());
        assert!(owner.state.lock().unwrap().0);
        drop(lease);
        shutdown.await.unwrap().unwrap();
        owner.resume();
        assert!(!owner.state.lock().unwrap().0);
    }
    #[tokio::test]
    async fn cancelled_waiter_keeps_the_original_settings_write_and_child_owned_until_exit() {
        use crate::manifest::*;
        use sha2::{Digest, Sha256};
        use std::time::Duration;
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join("settings.mjs");
        let script = r#"import fs from 'node:fs';import path from 'node:path';
let input='';for await(const chunk of process.stdin)input+=chunk;JSON.parse(input);
const root=process.env.VARIN_DATA_DIR;fs.writeFileSync(path.join(root,'started'),String(process.pid));
await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(root,'committed'),'original-write');
process.stdout.write(JSON.stringify({version:1,ok:true,result:{saved:true}}));
await new Promise(r=>setTimeout(r,200));
"#;
        std::fs::write(&entry, script).unwrap();
        let node = PathBuf::from(
            std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into()),
        );
        let runtime = RuntimePaths {
            root: root.path().into(),
            node: node.clone(),
            host: entry.clone(),
            kernel: entry.clone(),
            frontend: entry.clone(),
            manifest: RuntimeManifest {
                schema: 1,
                product: "varin-tauri-desktop".into(),
                channel: "development".into(),
                platform: platform().into(),
                architecture: architecture().into(),
                node: NodeRuntime {
                    version: "test".into(),
                    executable: "unused".into(),
                },
                host: HostRuntime {
                    entry: "settings.mjs".into(),
                    settings_entry: "settings.mjs".into(),
                    browser_entry: "settings.mjs".into(),
                },
                kernel: KernelRuntime {
                    executable: "settings.mjs".into(),
                    manifest: "settings.mjs".into(),
                },
                frontend: FrontendRuntime {
                    entry: "settings.mjs".into(),
                },
                legacy_electron: None,
                files: vec![FileReceipt {
                    path: "settings.mjs".into(),
                    size: script.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(script.as_bytes())),
                    executable: false,
                }],
            },
        };
        let owner = Owner::default();
        let calling = owner.clone();
        let data = root.path().to_owned();
        let waiter = tokio::spawn(async move {
            calling
                .call(&runtime, &data, "save", json!({}), json!({}))
                .await
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !root.path().join("started").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let pid = std::fs::read_to_string(root.path().join("started")).unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        let draining = owner.clone();
        let drained = tokio::spawn(async move { draining.shutdown().await });
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(!drained.is_finished());
        tokio::time::timeout(Duration::from_secs(10), drained)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("committed")).unwrap(),
            "original-write"
        );
        let status=Command::new(node).args(["-e","try{process.kill(Number(process.argv[1]),0);process.exit(9)}catch(e){process.exit(e.code==='ESRCH'?0:10)}",&pid]).status().await.unwrap();
        assert!(
            status.success(),
            "settings shutdown must wait for the original PID, not merely stdout or the saved value"
        );
    }
}
