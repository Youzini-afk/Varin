//! One-shot migration using only a manifest-fixed, signed transition engine.
//! Secrets remain in inherited pipes and native CDP, never renderer IPC or logs.
use crate::{
    desktop_lock::Lease,
    host_scope::ProcessScope,
    legacy_migration_data as data,
    manifest::{RuntimePaths, contained_file},
    settings,
};
use base64::Engine as _;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_runtime_cef::{
    AsCefWebviewAttributes, DevToolsProtocol, FrameEventKind, WebviewCefExt,
    WebviewWindowBuilderCefExt, allocate_devtools_message_id,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{oneshot, watch},
};
type Reply = Result<Value, String>;
#[path = "smoke/migration.rs"]
mod smoke_observation;
pub(crate) use smoke_observation::observe as observe_smoke;
type Pending = Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>;
const INERT: &str = "<!doctype html><html><head><meta charset='utf-8'><title>Varin private migration</title></head><body></body></html>";
#[derive(Clone)]
struct NativeCdp {
    view: Webview,
    pending: Pending,
    terminal: watch::Receiver<Option<&'static str>>,
}
impl NativeCdp {
    async fn request(&self, method: &str, params: Value) -> Reply {
        if self.terminal.borrow().is_some() {
            return Err("Migration native document is unavailable".into());
        }
        let id = allocate_devtools_message_id()
            .map_err(|_| "Migration native message identity unavailable")?;
        let message = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|_| "Migration native request is invalid")?;
        if message.len() > data::MAX_BYTES {
            return Err("Migration native request exceeds its byte budget".into());
        }
        let (send, receive) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Migration native observer unavailable")?
            .insert(id, send);
        if self.terminal.borrow().is_some() || self.view.send_dev_tools_message(&message).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("Migration native dispatch is unconfirmed".into());
        }
        // A crash/close may have drained the response map immediately before
        // insertion. Keep this original page's sticky terminal receipt so that
        // late registration cannot create an unresolvable secret-write waiter.
        let mut terminal = self.terminal.clone();
        let result = crate::cdp_settlement::settle(receive, async move {
            loop {
                if let Some(reason) = *terminal.borrow_and_update() {
                    break Err(reason.to_owned());
                }
                terminal.changed().await.map_err(|_| {
                    "Migration native observation was lost; termination is unknown".to_owned()
                })?;
            }
        })
        .await;
        self.pending
            .lock()
            .map_err(|_| "Migration native observer unavailable")?
            .remove(&id);
        result
    }
    async fn entries(&self, origin: &str) -> Result<HashMap<String, String>, String> {
        let result = self
            .request(
                "DOMStorage.getDOMStorageItems",
                json!({"storageId":{"securityOrigin":origin,"isLocalStorage":true}}),
            )
            .await?;
        data::storage_entries(&result["entries"])
    }
    async fn put(&self, origin: &str, key: &str, value: &str) -> Result<(), String> {
        self.request("DOMStorage.setDOMStorageItem",json!({"storageId":{"securityOrigin":origin,"isLocalStorage":true},"key":key,"value":value})).await?;
        if self.entries(origin).await?.get(key).map(String::as_str) != Some(value) {
            return Err("Migration target storage write was not retained".into());
        }
        Ok(())
    }
}
struct HiddenPage {
    window: WebviewWindow,
    cdp: NativeCdp,
    close: crate::lifecycle::CloseReceipt,
    committed: watch::Receiver<Option<Result<String, String>>>,
    allowed: Arc<Mutex<Option<String>>>,
}
impl HiddenPage {
    async fn open(
        app: &AppHandle,
        data_dir: &Path,
        application: bool,
        admission: Option<&crate::desktop_admission::Permit>,
    ) -> Result<Self, String> {
        if !application && !crate::smoke::requested() {
            return Err("The migration reader only admits the application profile".into());
        }
        let label = format!("migration-{}", uuid::Uuid::new_v4());
        let allowed: Arc<Mutex<Option<String>>> = Arc::default();
        let navigation = allowed.clone();
        let pending: Pending = Arc::default();
        let crashed = pending.clone();
        let (terminal, terminal_receipt) = watch::channel(None);
        let frame_terminal = terminal.clone();
        let (loaded, committed) = watch::channel(None);
        let page_load = loaded.clone();
        let initial = if application {
            WebviewUrl::App("desktop-migration.html".into())
        } else {
            WebviewUrl::External("about:blank".parse().unwrap())
        };
        let mut builder = WebviewWindowBuilder::new(app, &label, initial)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .data_directory(data_dir.join(if application {
                "cef/application"
            } else {
                "cef/browser"
            }))
            .on_navigation(move |url| {
                if application {
                    crate::security::application_origin(url)
                        && url.path() == "/desktop-migration.html"
                } else {
                    url.as_str() == "about:blank"
                        || navigation.lock().ok().and_then(|v| v.clone()).as_deref()
                            == Some(url.as_str())
                }
            })
            .on_frame_event(move |event| {
                if matches!(event.kind, FrameEventKind::RendererTerminated) {
                    frame_terminal.send_replace(Some(
                        "Migration renderer terminated; effect outcome is unknown",
                    ));
                    page_load.send_replace(Some(Err(
                        "Migration renderer terminated; write outcome is unknown".into(),
                    )));
                    for (_, reply) in crashed.lock().unwrap().drain() {
                        let _ = reply.send(Err(
                            "Migration renderer terminated; write outcome is unknown".into(),
                        ));
                    }
                } else if event.is_main && frame_terminal.borrow().is_none() {
                    if let FrameEventKind::DocumentCommitted { url } = event.kind {
                        page_load.send_replace(Some(Ok(url.to_string())));
                    }
                }
            });
        let close = crate::lifecycle::attach(&mut builder, app, &label)?;
        builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("Migration requires the bundled CEF runtime")?
            .native_only = true;
        let window = builder
            .build()
            .map_err(|_| "Migration native surface could not be created")?;
        let cdp = NativeCdp {
            view: window.as_ref().clone(),
            pending: pending.clone(),
            terminal: terminal_receipt,
        };
        let observer = cdp.clone();
        let responses = pending.clone();
        let permitted = allowed.clone();
        let failed_navigation = loaded.clone();
        let invalid_response = terminal.clone();
        let attached = window.on_dev_tools_protocol(move|message|if let DevToolsProtocol::Message(bytes)=message{
            if bytes.len()>data::MAX_BYTES{invalid_response.send_replace(Some("Migration native response exceeds its byte budget; effect outcome is unknown"));for(_,reply)in responses.lock().unwrap().drain(){let _=reply.send(Err("Migration native response exceeds its byte budget".into()));}return;}
            if let Ok(value)=serde_json::from_slice::<Value>(&bytes){
                if let Some(id)=value["id"].as_i64().and_then(|id|i32::try_from(id).ok()){
                    if let Some(reply)=responses.lock().unwrap().remove(&id){let _=reply.send(if value["error"].is_object(){Err("Migration native operation was rejected".into())}else{Ok(value["result"].clone())});}
                }else if value["method"]=="Fetch.requestPaused"{
                    let expected=permitted.lock().ok().and_then(|v|v.clone());let accepted=value["params"]["resourceType"]=="Document"&&value["params"]["request"]["url"].as_str()==expected.as_deref();
                    let id=value["params"]["requestId"].clone();let native=observer.clone();let outcome=failed_navigation.clone();
                    tauri::async_runtime::spawn(async move{
                        let result=if accepted{native.request("Fetch.fulfillRequest",json!({"requestId":id,"responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html"},{"name":"Content-Security-Policy","value":"default-src 'none'; script-src 'none'; connect-src 'none'; worker-src 'none'; frame-src 'none'"}],"body":base64::engine::general_purpose::STANDARD.encode(INERT)})).await}else{native.request("Fetch.failRequest",json!({"requestId":id,"errorReason":"BlockedByClient"})).await};
                        if result.is_err(){outcome.send_replace(Some(Err("Migration offline interception was not confirmed".into())));}
                    });
                }
            }
        });
        if attached.is_err() {
            let cleanup = close.request(window.as_ref()).await;
            if !close.closed() {
                if let Some(admission) = admission {
                    admission.retain_cleanup_failure(format!(
                        "Original application migration page closure is unconfirmed after observer attachment failed: {}",
                        cleanup.as_ref().err().map(String::as_str).unwrap_or("missing close receipt")
                    ));
                }
            }
            cleanup?;
            return Err("Migration native observer could not attach".into());
        }
        let stopped = close.clone();
        tauri::async_runtime::spawn(async move {
            stopped.wait_termination().await;
            terminal.send_replace(Some(
                "Migration native surface closed; effect outcome is unknown",
            ));
            loaded.send_replace(Some(Err("Migration native surface closed".into())));
            for (_, reply) in pending.lock().unwrap().drain() {
                let _ = reply.send(Err(
                    "Migration native surface closed; write outcome is unknown".into(),
                ));
            }
        });
        Ok(Self {
            window,
            cdp,
            close,
            committed,
            allowed,
        })
    }
    async fn wait_origin(&mut self, origin: &str) -> Result<(), String> {
        // A committed frame is required for DOMStorage. Native method dispatch
        // alone is not a document-readiness or persistence receipt.
        loop {
            if let Some(value) = self.committed.borrow_and_update().clone() {
                let url = value?;
                if url::Url::parse(&url)
                    .ok()
                    .is_some_and(|u| u.origin().ascii_serialization() == origin)
                {
                    return Ok(());
                }
            }
            self.committed
                .changed()
                .await
                .map_err(|_| "Migration document commitment was lost")?;
        }
    }
    async fn offline(&self) -> Result<(), String> {
        self.cdp.request("Network.enable", json!({})).await?;
        self.cdp
            .request("Network.setBypassServiceWorker", json!({"bypass":true}))
            .await?;
        self.cdp
            .request(
                "Fetch.enable",
                json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
            )
            .await?;
        Ok(())
    }
    async fn origin(&mut self, origin: &str) -> Result<(), String> {
        if !crate::smoke::requested() || origin != "https://migration-fixture.invalid" {
            return Err("Only the fixed browser-isolation smoke origin is admitted".into());
        }
        let url = format!("{origin}/.varin-migration.html");
        *self
            .allowed
            .lock()
            .map_err(|_| "Migration navigation scope unavailable")? = Some(url.clone());
        let result = self
            .cdp
            .request("Page.navigate", json!({"url":url}))
            .await?;
        if result["errorText"].is_string() {
            return Err("Migration inert document navigation failed".into());
        }
        self.wait_origin(origin).await
    }
    async fn close(&self) -> Result<(), String> {
        self.close.request(self.window.as_ref()).await
    }
}
impl Drop for HiddenPage {
    fn drop(&mut self) {
        // Exceptional unwinding still requests closure. Only close().await can
        // certify completion and allow the caller to commit a migration receipt.
        if !self.close.closed() {
            let _ = self.window.close();
        }
    }
}
async fn read_frame(input: &mut (impl AsyncRead + Unpin), first_response: bool) -> Reply {
    let mut header = [0; 4];
    input
        .read_exact(&mut header)
        .await
        .map_err(|_| "Legacy exporter pipe ended before its receipt")?;
    // The Windows Electron launcher can emit one CRLF before JS runs. A valid
    // length prefix cannot begin with these bytes. Keep subsequent frames strict.
    if cfg!(windows) && first_response && header.starts_with(b"\r\n") {
        header.copy_within(2..4, 0);
        input
            .read_exact(&mut header[2..])
            .await
            .map_err(|_| "Legacy exporter pipe ended before its receipt")?;
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > data::MAX_BYTES {
        return Err("Legacy exporter record exceeds its private pipe budget".into());
    }
    let mut bytes = vec![0; length];
    input
        .read_exact(&mut bytes)
        .await
        .map_err(|_| "Legacy exporter record was truncated")?;
    serde_json::from_slice(&bytes).map_err(|_| "Legacy exporter record is malformed".into())
}
async fn write_frame(output: &mut (impl AsyncWrite + Unpin), value: Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(&value).map_err(|_| "Legacy parent record is invalid")?;
    if bytes.len() > data::MAX_BYTES {
        return Err("Legacy parent record exceeds its private pipe budget".into());
    }
    output
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|_| "Legacy parent pipe was lost")?;
    for part in bytes.chunks(64 * 1024) {
        output
            .write_all(part)
            .await
            .map_err(|_| "Legacy parent pipe was lost")?;
    }
    output
        .flush()
        .await
        .map_err(|_| "Legacy parent record was not delivered".into())
}
fn check_frame(frame: &Value, nonce: &str) -> Result<(), String> {
    if frame["protocol"] != data::PROTOCOL || frame["version"] != 1 || frame["nonce"] != nonce {
        return Err("Legacy exporter identity does not match its private parent".into());
    }
    Ok(())
}
struct ScopeGuard(ProcessScope);
impl Drop for ScopeGuard {
    fn drop(&mut self) {
        let _ = self.0.terminate();
    }
}
/// Call before releasing the main window's bootstrap. `lease` remains held by
/// the shell across export, native import and every process/native close receipt.
pub async fn prepare(
    app: &AppHandle,
    runtime: &RuntimePaths,
    settings: &settings::Owner,
    data_dir: &Path,
    lease: &Lease,
    admission: &crate::desktop_admission::Permit,
) -> Reply {
    lease.verify()?;
    // The acceptance fixture never inspects a pre-existing user's profile.
    // Validate its native OS location and creation marker before the old reader.
    smoke_observation::verify_source(app, data_dir)?;
    let existing = settings
        .call(
            runtime,
            data_dir,
            "nativeMigrationRead",
            json!({}),
            json!({}),
        )
        .await?;
    let original = app
        .path()
        .config_dir()
        .map_err(|_| "Previous desktop profile location is unavailable")?
        .join("Varin");
    let profile = original.clone();
    let present = tokio::task::spawn_blocking(move || data::legacy_profile_present(&profile))
        .await
        .map_err(|_| "Previous desktop profile inspection stopped")??;
    let Some(legacy) = runtime.manifest.legacy_electron.as_ref() else {
        if data::transition_required(&existing, present) {
            return Err(data::TRANSITION_REQUIRED.into());
        }
        return Ok(if existing["attemptComplete"] == true {
            existing
        } else {
            json!({"available":false})
        });
    };
    if existing["sourceSha"] == legacy.source_sha
        && existing["protocol"] == 1
        && existing["attemptComplete"] == true
        && existing["browserStatus"] == "not-migrated"
    {
        return Ok(existing);
    }
    if !present {
        return Ok(json!({"available":false}));
    }
    let expected = match crate::manifest::platform() {
        "win32" => "legacy-electron/Varin.exe",
        "darwin" => "legacy-electron/Varin.app/Contents/MacOS/Varin",
        _ => "legacy-electron/varin",
    };
    if legacy.schema != 1
        || legacy.protocol != 1
        || legacy.directory != "legacy-electron"
        || legacy.executable != expected
        || legacy.source_sha.len() != 40
        || !legacy.source_sha.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Legacy exporter manifest identity is incompatible".into());
    }
    let verify = runtime.clone();
    tokio::task::spawn_blocking(move || {
        verify
            .verify_legacy()
            .map_err(|_| "Legacy exporter bundle integrity check failed")?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "Legacy exporter validation stopped")??;
    let executable = contained_file(&runtime.root, &legacy.executable)
        .map_err(|_| "Legacy exporter is not a contained native binary")?;
    let mut command = Command::new(executable);
    // Read the same profile the native owner inspected, including when the OS
    // config directory differs from Chromium's default user data directory.
    let mut profile_argument = OsString::from("--user-data-dir=");
    profile_argument.push(&original);
    command
        .arg("--varin-export-private-state")
        .arg(profile_argument)
        .env("VARIN_DATA_DIR", data_dir)
        .env_remove("NODE_OPTIONS")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("VARIN_ELECTRON_DEV")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // The exporter owns private Chromium children as well as its main process.
    // Use the same guardian/Job from admission, never attach after execution.
    let (mut child, process_scope) =
        ProcessScope::spawn_with_stderr(command, data_dir, Stdio::null())?;
    let scope = ScopeGuard(process_scope);
    let mut input = child
        .stdout
        .take()
        .ok_or("Legacy private output unavailable")?;
    let mut output = child
        .stdin
        .take()
        .ok_or("Legacy private input unavailable")?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut application: Option<HiddenPage> = None;
    let outcome:Reply=async{
        // Quit cancels private-reader waits, but not construction/cleanup of an
        // already-admitted native page. The outer owner still joins both original
        // process termination and page closure before releasing admission.
        let ready = admission.until_shutdown(async {
            write_frame(&mut output,json!({"protocol":data::PROTOCOL,"version":1,"kind":"begin","nonce":nonce,"lease":lease.record()})).await?;
            read_frame(&mut input,true).await
        }).await?;
        check_frame(&ready,&nonce)?;
        if ready["kind"]!="ready" || ready["sourceVersion"]!=legacy.version || ready["browserStatus"]!="not-migrated"
            || ready["credentialCount"].as_u64().is_none_or(|count| count > 6) {
            return Err("Legacy exporter version or scope was not confirmed".into());
        }
        application=Some(HiddenPage::open(app,data_dir,true,Some(admission)).await?);
        admission.until_shutdown(async {
            let ui=application.as_mut().unwrap();ui.wait_origin("http://tauri.localhost").await?;
            let staged=settings.call(runtime,data_dir,"frontendMigrationRead",json!({}),json!({})).await?;
            let staged_config=staged["payload"]["entries"]["config-store"].as_str();
            let mut target=ui.cdp.entries("http://tauri.localhost").await?;
            let mut credentials=Vec::new();let mut sequence=0u64;
            loop{
                let record=read_frame(&mut input,false).await?;check_frame(&record,&nonce)?;
                if record["kind"]=="done"{if record["records"].as_u64()!=Some(sequence)||ready["credentialCount"].as_u64()!=Some(credentials.len()as u64){return Err("Legacy export receipt omitted original items".into())}break}
                sequence+=1;if record["sequence"].as_u64()!=Some(sequence){return Err("Legacy private record ordering is invalid".into())}
                let status=match record["kind"].as_str(){
                    Some("credential")=>{
                        let slot=record["slot"].as_str().ok_or("Legacy credential slot is invalid")?;let value=record["value"].as_str();
                        if !data::credential_slot(slot) || credentials.iter().any(|item:&Value|item["slot"]==slot){return Err("Legacy credential inventory is invalid".into())}
                        let status=if record["sourceStatus"]=="unavailable" {"failed"} else {match data::credential_change(slot,value.ok_or("Legacy credential value is invalid")?,&target,staged_config){Ok(Some((key,value)))=>{ui.cdp.put("http://tauri.localhost",&key,&value).await?;target.insert(key,value);"imported"},Ok(None)=>"retained",Err(_)=>"failed"}};
                        credentials.push(json!({"slot":slot,"status":status}));status
                    }
                    _=>return Err("Legacy private record kind is not allowed".into())
                };
                write_frame(&mut output,json!({"protocol":data::PROTOCOL,"version":1,"kind":"ack","nonce":nonce,"sequence":sequence,"status":status})).await?;
            }
            let receipt=json!({"schema":1,"protocol":1,"sourceSha":legacy.source_sha,"sourceVersion":legacy.version,"attemptComplete":true,
                "browserStatus":"not-migrated","browserRequiresLogin":true,
                "companionFailures":ready["uiReceipt"]["companions"]["failures"].as_array().cloned().unwrap_or_default(),
                "credentials":credentials,"sourceRetained":true});
            ui.cdp.put("http://tauri.localhost",data::RECOVERY_KEY,&serde_json::to_string(&data::safe_recovery(&receipt)).map_err(|_|"Migration recovery status could not be encoded")?).await?;
            write_frame(&mut output,json!({"protocol":data::PROTOCOL,"version":1,"kind":"complete","nonce":nonce,"records":sequence})).await?;
            Ok(receipt)
        }).await
    }.await;
    drop(output);
    // Native close and process cleanup proceed independently. A stuck/lost
    // process observation cannot prevent closure of the original CEF page.
    let process_cleanup = async {
        let mut cleanup_error = None;
        if outcome.is_err() {
            if let Err(error) = scope.0.terminate() {
                cleanup_error = Some(error);
            }
        }
        if outcome.is_ok() {
            // Complete private protocol + pipe EOF, not mere byte receipt. The
            // exporter must close its original native readers before exit.
            let mut trailing = [0];
            match input.read(&mut trailing).await {
                Ok(0) => {
                    if let Err(error) = scope.0.confirm_owner_drained() {
                        cleanup_error.get_or_insert(error);
                    }
                }
                _ => {
                    cleanup_error
                        .get_or_insert("Legacy exporter emitted incomplete trailing data".into());
                    let _ = scope.0.terminate();
                }
            }
        }
        let status = child.wait().await;
        drop(child);
        let settled = scope.0.settle_after_node_exit(&status).await;
        let scope_ended = settled.is_ok();
        let result = match settled {
            Err(error) => Err(error),
            Ok(_) if cleanup_error.is_some() => Err(cleanup_error.unwrap()),
            Ok(settled) if !settled.clean || !settled.success => {
                Err("Legacy exporter did not finish successfully".into())
            }
            Ok(_) => Ok(()),
        };
        (scope_ended, result)
    };
    let (process, app_close) = tokio::join!(
        admission.finish_on_shutdown(process_cleanup, || scope.0.terminate()),
        async {
            if let Some(page) = application.as_ref() {
                page.close().await
            } else {
                Ok(())
            }
        }
    );
    let ((scope_ended, mut status), interrupted) = process;
    let mut unconfirmed = Vec::new();
    if !scope_ended {
        unconfirmed.push(format!(
            "Original application migration process termination is unconfirmed: {}",
            status.as_ref().unwrap_err()
        ));
    }
    let page_ended = application.as_ref().is_none_or(|page| page.close.closed());
    if !page_ended {
        unconfirmed.push(format!(
            "Original application migration page closure is unconfirmed: {}",
            app_close.as_ref().err().map(String::as_str).unwrap_or("missing close receipt")
        ));
    }
    if !unconfirmed.is_empty() {
        for error in &unconfirmed {
            admission.retain_cleanup_failure(error.clone());
        }
        return Err(unconfirmed.join("; "));
    }
    if let Some(interrupted) = interrupted {
        // Even if termination subsequently succeeds, Quit interrupted the
        // successful exporter handshake. Never commit a successful migration.
        status = status.and(interrupted).and(Err("Desktop shutdown interrupted application migration".into()));
    }
    app_close?;
    status?;
    let receipt = outcome?;
    lease.verify()?;
    settings
        .call(
            runtime,
            data_dir,
            "nativeMigrationComplete",
            receipt.clone(),
            json!({}),
        )
        .await?;
    Ok(receipt)
}
