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
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_runtime_cef::{
    AsCefWebviewAttributes, DevToolsProtocol, FrameEventKind, WebviewCefExt,
    WebviewWindowBuilderCefExt, allocate_devtools_message_id,
    cef::{self, rc::*, *},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{oneshot, watch},
};
type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>;
const INERT: &str = "<!doctype html><html><head><meta charset='utf-8'><title>Varin private migration</title></head><body></body></html>";
#[derive(Clone)]
struct NativeCdp {
    view: Webview,
    pending: Pending,
}
impl NativeCdp {
    async fn request(&self, method: &str, params: Value) -> Reply {
        let id = allocate_devtools_message_id()
            .map_err(|_| "Migration native message identity unavailable")?;
        let (send, receive) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Migration native observer unavailable")?
            .insert(id, send);
        let message = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|_| "Migration native request is invalid")?;
        if message.len() > data::MAX_BYTES {
            self.pending.lock().unwrap().remove(&id);
            return Err("Migration native request exceeds its byte budget".into());
        }
        if self.view.send_dev_tools_message(&message).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("Migration native dispatch is unconfirmed".into());
        }
        receive
            .await
            .map_err(|_| "Migration native response was lost; outcome is unknown")?
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
    async fn open(app: &AppHandle, data_dir: &Path, application: bool) -> Result<Self, String> {
        let label = format!("migration-{}", uuid::Uuid::new_v4());
        let allowed: Arc<Mutex<Option<String>>> = Arc::default();
        let navigation = allowed.clone();
        let pending: Pending = Arc::default();
        let crashed = pending.clone();
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
                    page_load.send_replace(Some(Err(
                        "Migration renderer terminated; write outcome is unknown".into(),
                    )));
                    for (_, reply) in crashed.lock().unwrap().drain() {
                        let _ = reply.send(Err(
                            "Migration renderer terminated; write outcome is unknown".into(),
                        ));
                    }
                } else if event.is_main {
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
        };
        let observer = cdp.clone();
        let responses = pending.clone();
        let permitted = allowed.clone();
        let failed_navigation = loaded.clone();
        let attached = window.on_dev_tools_protocol(move|message|if let DevToolsProtocol::Message(bytes)=message{
            if bytes.len()>data::MAX_BYTES{for(_,reply)in responses.lock().unwrap().drain(){let _=reply.send(Err("Migration native response exceeds its byte budget".into()));}return;}
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
            close.request(window.as_ref()).await?;
            return Err("Migration native observer could not attach".into());
        }
        let stopped = close.clone();
        tauri::async_runtime::spawn(async move {
            stopped.wait_termination().await;
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
        data::site_origin(origin)?;
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
    async fn flush_cookies(&self) -> Result<(), String> {
        let (send, receive) = oneshot::channel();
        let result = Arc::new(FlushReceipt(Mutex::new(Some(send))));
        let observer = result.clone();
        self.window
            .with_cef_webview(move |view| {
                let manager = view
                    .browser()
                    .host()
                    .and_then(|host| host.request_context())
                    .and_then(|context| context.cookie_manager(None));
                if let Some(manager) = manager {
                    let mut callback = FlushCookies::new(observer.clone());
                    if manager.flush_store(Some(&mut callback)) == 1 {
                        return;
                    }
                }
                if let Some(reply) = observer.0.lock().unwrap().take() {
                    let _ = reply.send(Err("Migration cookie persistence could not start".into()));
                }
            })
            .map_err(|_| "Migration cookie persistence dispatch failed")?;
        drop(result);
        receive
            .await
            .map_err(|_| "Migration cookie persistence acknowledgement was lost")?
    }
}
struct FlushReceipt(Mutex<Option<oneshot::Sender<Result<(), String>>>>);
impl Drop for FlushReceipt {
    fn drop(&mut self) {
        if let Some(reply) = self.0.lock().unwrap().take() {
            let _ = reply.send(Err(
                "Migration cookie persistence callback ended without a receipt".into(),
            ));
        }
    }
}
wrap_completion_callback! {struct FlushCookies{reply:Arc<FlushReceipt>,}impl CompletionCallback{fn on_complete(&self){if let Some(reply)=self.reply.0.lock().unwrap().take(){let _=reply.send(Ok(()));}}}}
impl Drop for HiddenPage {
    fn drop(&mut self) {
        // Exceptional unwinding still requests closure. Only close().await can
        // certify completion and allow the caller to commit a migration receipt.
        if !self.close.closed() {
            let _ = self.window.close();
        }
    }
}
async fn read_frame(input: &mut (impl AsyncRead + Unpin)) -> Reply {
    let length = input
        .read_u32()
        .await
        .map_err(|_| "Legacy exporter pipe ended before its receipt")? as usize;
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
async fn import_cookie(
    browser: &HiddenPage,
    cookie: &Value,
    original_target: &[Value],
) -> Result<&'static str, String> {
    let identity = data::cookie_identity(cookie)?;
    let Some(params) = data::cookie_parameters(cookie)? else {
        return Ok("unsupported");
    };
    let current = browser.cdp.request("Storage.getCookies", json!({})).await?;
    let before = current["cookies"]
        .as_array()
        .ok_or("Target cookie inventory is invalid")?;
    if before
        .iter()
        .any(|v| data::cookie_identity(v).ok().as_ref() == Some(&identity))
    {
        return Ok("retained");
    }
    if original_target
        .iter()
        .any(|v| data::cookie_scope_related(cookie, v))
    {
        return Ok("unsupported");
    }
    let mut applicable = url::Url::parse(
        params["url"]
            .as_str()
            .ok_or("Cookie probe URL is invalid")?,
    )
    .map_err(|_| "Cookie probe URL is invalid")?;
    applicable.set_path(
        cookie["path"]
            .as_str()
            .ok_or("Cookie probe path is invalid")?,
    );
    let response = browser.cdp.request("Network.setCookie", params).await?;
    if response["success"] != true {
        return Ok("failed");
    }
    let after = browser.cdp.request("Storage.getCookies", json!({})).await?;
    let after = after["cookies"]
        .as_array()
        .ok_or("Target cookie verification is invalid")?;
    // The target page's network view independently verifies the cache context,
    // rather than trusting a browser-level default-context inventory alone.
    let visible = browser
        .cdp
        .request("Network.getCookies", json!({"urls":[applicable.as_str()]}))
        .await?;
    let matches = |values: &Vec<Value>| values.iter().any(|v| data::cookie_matches(cookie, v));
    if matches(after) && visible["cookies"].as_array().is_some_and(matches) {
        return Ok("imported");
    }
    // The entire related namespace was absent at admission. Retract only newly
    // introduced identities, including a lost partition/host-only distinction.
    // Pre-existing target cookies are never candidates for deletion.
    let introduced = after
        .iter()
        .filter(|v| {
            data::cookie_scope_related(cookie, v)
                && !before
                    .iter()
                    .any(|old| data::cookie_identity(old).ok() == data::cookie_identity(v).ok())
        })
        .map(data::cookie_identity)
        .collect::<Result<Vec<_>, _>>()?;
    for created in introduced {
        browser
            .cdp
            .request("Network.deleteCookies", created)
            .await?;
    }
    for old in before
        .iter()
        .filter(|v| data::cookie_scope_related(cookie, v))
    {
        let restore =
            data::cookie_parameters(old)?.ok_or("Original target cookie cannot be restored")?;
        if browser.cdp.request("Network.setCookie", restore).await?["success"] != true {
            return Err("Original target cookie restoration was not confirmed".into());
        }
    }
    let removed = browser.cdp.request("Storage.getCookies", json!({})).await?;
    let remaining = removed["cookies"]
        .as_array()
        .ok_or("Target cookie retraction verification is invalid")?;
    let old_related = before
        .iter()
        .filter(|v| data::cookie_scope_related(cookie, v))
        .collect::<Vec<_>>();
    let new_related = remaining
        .iter()
        .filter(|v| data::cookie_scope_related(cookie, v))
        .collect::<Vec<_>>();
    if old_related.len() != new_related.len()
        || old_related
            .iter()
            .any(|old| !new_related.iter().any(|new| data::cookie_matches(old, new)))
    {
        return Err("Migration could not retract an incompatible new cookie".into());
    }
    Ok("unsupported")
}
async fn recover_cookie_attempt(browser: &HiddenPage, pending: &Value) -> Result<(), String> {
    if pending.is_null() {
        return Ok(());
    }
    if pending["schema"] != 1 {
        return Err("Native cookie recovery journal is incompatible".into());
    }
    let scopes = pending["scopes"]
        .as_array()
        .ok_or("Native cookie recovery namespaces are invalid")?;
    for scope in scopes {
        data::cookie_identity(scope)?;
    }
    let current = browser.cdp.request("Storage.getCookies", json!({})).await?;
    for cookie in current["cookies"]
        .as_array()
        .ok_or("Target cookie recovery inventory is invalid")?
    {
        if scopes
            .iter()
            .any(|scope| data::cookie_scope_related(scope, cookie))
        {
            browser
                .cdp
                .request("Network.deleteCookies", data::cookie_identity(cookie)?)
                .await?;
        }
    }
    let after = browser.cdp.request("Storage.getCookies", json!({})).await?;
    if after["cookies"]
        .as_array()
        .ok_or("Target cookie recovery readback is invalid")?
        .iter()
        .any(|cookie| {
            scopes
                .iter()
                .any(|scope| data::cookie_scope_related(scope, cookie))
        })
    {
        return Err("Previous cookie migration has not been retracted".into());
    }
    browser.flush_cookies().await
}
fn provisional_cookie_scopes(inventory: &[Value], target: &[Value]) -> Result<Vec<Value>, String> {
    let mut scopes = Vec::new();
    let mut seen = HashSet::new();
    for item in inventory {
        let identity = data::cookie_identity(item)?;
        if identity["opaque"] == true || target.iter().any(|v| data::cookie_scope_related(item, v))
        {
            continue;
        }
        let scope = json!({"domain":item["domain"].as_str().unwrap().trim_start_matches('.'),"name":item["name"],"path":item["path"]});
        if seen.insert(scope.to_string()) {
            scopes.push(scope)
        }
    }
    Ok(scopes)
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
) -> Reply {
    lease.verify()?;
    let existing = settings
        .call(
            runtime,
            data_dir,
            "nativeMigrationRead",
            json!({}),
            json!({}),
        )
        .await?;
    let Some(legacy) = runtime.manifest.legacy_electron.as_ref() else {
        let original = app
            .path()
            .config_dir()
            .map_err(|_| "Previous desktop profile location is unavailable")?
            .join("Varin");
        let present = tokio::task::spawn_blocking(move || data::legacy_profile_present(&original))
            .await
            .map_err(|_| "Previous desktop profile inspection stopped")??;
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
        && existing["pendingCookies"].is_null()
    {
        return Ok(existing);
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
    let executable_receipt = legacy.executable.clone();
    tokio::task::spawn_blocking(move || {
        verify
            .verify_file(&executable_receipt)
            .map_err(|_| "Legacy exporter entry integrity check failed")?;
        for file in &verify.manifest.files {
            if file.path.starts_with("legacy-electron/") {
                verify
                    .verify_file(&file.path)
                    .map_err(|_| "Legacy exporter bundle integrity check failed")?;
            }
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "Legacy exporter validation stopped")??;
    let executable = contained_file(&runtime.root, &legacy.executable)
        .map_err(|_| "Legacy exporter is not a contained native binary")?;
    let mut command = Command::new(executable);
    command
        .arg("--varin-export-private-state")
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
    let (mut child, process_scope) = ProcessScope::spawn_with_stderr(command, data_dir, Stdio::null())?;
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
    let mut browser: Option<HiddenPage> = None;
    let outcome:Reply=async{
        write_frame(&mut output,json!({"protocol":data::PROTOCOL,"version":1,"kind":"begin","nonce":nonce,"lease":lease.record()})).await?;
        let ready=read_frame(&mut input).await?;check_frame(&ready,&nonce)?;
        if ready["kind"]!="ready"||ready["sourceVersion"]!=legacy.version||!matches!(ready["browserStatus"].as_str(),Some("available"|"source-unavailable")){return Err("Legacy exporter version was not confirmed".into())}
        application=Some(HiddenPage::open(app,data_dir,true).await?);browser=Some(HiddenPage::open(app,data_dir,false).await?);
        let ui=application.as_mut().unwrap();ui.wait_origin("http://tauri.localhost").await?;
        let browsing=browser.as_mut().unwrap();browsing.offline().await?;
        recover_cookie_attempt(browsing,&existing["pendingCookies"]).await?;
        let inventory=ready["cookieInventory"].as_array().ok_or("Legacy cookie identity inventory is unavailable")?;
        if ready["cookieCount"].as_u64()!=Some(inventory.len()as u64){return Err("Legacy cookie identity inventory is incomplete".into())}
        let identities=inventory.iter().map(data::cookie_identity).collect::<Result<Vec<_>,_>>()?;
        if identities.iter().map(Value::to_string).collect::<HashSet<_>>().len()!=identities.len(){return Err("Legacy cookie identity inventory is duplicated".into())}
        let original=browsing.cdp.request("Storage.getCookies",json!({})).await?;
        let original_target=original["cookies"].as_array().ok_or("Target cookie admission inventory is invalid")?;
        let scopes=provisional_cookie_scopes(inventory,original_target)?;
        settings.call(runtime,data_dir,"nativeMigrationCookiePrepare",json!({"schema":1,"sourceSha":legacy.source_sha,"scopes":scopes}),json!({})).await?;

        let staged=settings.call(runtime,data_dir,"frontendMigrationRead",json!({}),json!({})).await?;
        let staged_config=staged["payload"]["entries"]["config-store"].as_str();
        let mut target=ui.cdp.entries("http://tauri.localhost").await?;
        let mut credentials=Vec::new();let mut cookies=Vec::new();let mut origins=Vec::new();let mut sequence=0u64;
        loop{
            let record=read_frame(&mut input).await?;check_frame(&record,&nonce)?;
            if record["kind"]=="done"{if record["records"].as_u64()!=Some(sequence)||ready["credentialCount"].as_u64()!=Some(credentials.len()as u64)||ready["cookieCount"].as_u64()!=Some(cookies.len()as u64){return Err("Legacy export receipt omitted original items".into())}break}
            sequence+=1;if record["sequence"].as_u64()!=Some(sequence){return Err("Legacy private record ordering is invalid".into())}
            let status=match record["kind"].as_str(){
                Some("credential")=>{
                    let slot=record["slot"].as_str().ok_or("Legacy credential slot is invalid")?;let value=record["value"].as_str();
                    if !data::credential_slot(slot) || credentials.iter().any(|item:&Value|item["slot"]==slot){return Err("Legacy credential inventory is invalid".into())}
                    let status=if record["sourceStatus"]=="unavailable" {"failed"} else {match data::credential_change(slot,value.ok_or("Legacy credential value is invalid")?,&target,staged_config){Ok(Some((key,value)))=>{ui.cdp.put("http://tauri.localhost",&key,&value).await?;target.insert(key,value);"imported"},Ok(None)=>"retained",Err(_)=>"failed"}};
                    credentials.push(json!({"slot":slot,"status":status}));status
                }
                Some("cookie")=>{let cookie=&record["cookie"];let identity=data::cookie_identity(cookie)?;if identities.get(cookies.len())!=Some(&identity){return Err("Legacy cookie record differs from its admitted inventory".into())}let status=import_cookie(browsing,cookie,original_target).await?;cookies.push(json!({"identity":identity,"status":status}));status}
                Some("origin")=>{
                    let origin=record["origin"].as_str().ok_or("Legacy BrowserUse origin is invalid")?;data::site_origin(origin)?;
                    let mut imported=0usize;let mut retained=0usize;
                    let status=if record["localStorage"].is_null(){"unsupported"}else{
                        let source=data::storage_entries(&record["localStorage"])?;browsing.origin(origin).await?;let current=browsing.cdp.entries(origin).await?;
                        for(key,value)in source{if current.contains_key(&key){retained+=1;}else{browsing.cdp.put(origin,&key,&value).await?;imported+=1;}}"imported"
                    };
                    let database_names=record["indexedDbDatabases"].as_array().filter(|values|values.iter().all(Value::is_string)).cloned();
                    origins.push(json!({"origin":origin,"status":status,"localStorageImported":imported,"localStorageRetained":retained,"indexedDbDatabases":database_names,"serviceWorkers":"requires-site-recovery"}));status
                }
                _=>return Err("Legacy private record kind is not allowed".into())
            };
            write_frame(&mut output,json!({"protocol":data::PROTOCOL,"version":1,"kind":"ack","nonce":nonce,"sequence":sequence,"status":status})).await?;
        }
        browsing.flush_cookies().await?;
        let receipt=json!({"schema":1,"protocol":1,"sourceSha":legacy.source_sha,"sourceVersion":legacy.version,"attemptComplete":true,"browserStatus":ready["browserStatus"],"companionFailures":ready["uiReceipt"]["companions"]["failures"].as_array().cloned().unwrap_or_default(),"credentials":credentials,"cookies":cookies,"origins":origins,"siteStorageInventory":"cookies-and-saved-browser-pages","indexedDb":"requires-site-recovery","serviceWorkers":"requires-site-recovery","sourceRetained":true});
        ui.cdp.put("http://tauri.localhost",data::RECOVERY_KEY,&serde_json::to_string(&data::safe_recovery(&receipt)).map_err(|_|"Migration recovery status could not be encoded")?).await?;
        write_frame(&mut output,json!({"protocol":data::PROTOCOL,"version":1,"kind":"complete","nonce":nonce,"records":sequence})).await?;
        Ok(receipt)
    }.await;
    drop(output);
    // Native close and process cleanup proceed independently. A stuck/lost
    // process observation cannot prevent closure of either original CEF page.
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
                    if let Err(error) = scope.0.confirm_owner_drained() { cleanup_error.get_or_insert(error); }
                }
                _ => {
                    cleanup_error.get_or_insert("Legacy exporter emitted incomplete trailing data".into());
                    let _ = scope.0.terminate();
                }
            }
        }
        let status = child.wait().await;
        drop(child);
        let settled = scope.0.settle_after_node_exit(&status).await;
        if let Some(error) = cleanup_error { return Err(error); }
        let settled = settled?;
        if !settled.clean || !settled.success {
            return Err("Legacy exporter did not confirm clean process-scope termination".into());
        }
        Ok::<_, String>(())
    };
    let (status, app_close, browser_close) = tokio::join!(
        process_cleanup,
        async {
            if let Some(page) = application.as_ref() {
                page.close().await
            } else {
                Ok(())
            }
        },
        async {
            if let Some(page) = browser.as_ref() {
                page.close().await
            } else {
                Ok(())
            }
        },
    );
    app_close?;
    browser_close?;
    let receipt = outcome?;
    status?;
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
