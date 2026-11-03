//! Fixed, opt-in native acceptance suite. Never a production remote-debug API.
//! Runs only in an explicitly prepared empty temporary data directory.
mod fixture;
mod input;
mod sandbox;
use crate::{
    browser::BrowserViews,
    cdp::Session,
    engine::{network::NetworkService, offscreen},
};
use base64::Engine as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_runtime_cef::{AsCefWebviewAttributes, WebviewWindowBuilderCefExt};

type Reply = Result<Value, String>;
const CASES: &[&str] = &[
    "application-bridge",
    "browser-same-page",
    "browser-authority-isolation",
    "browser-context-isolation",
    "browser-capture",
    "browser-pending-close",
    "browser-download-terminal",
    "osr-alpha-composition",
    "network-stream-cancel",
    "renderer-sandbox",
    "native-drain",
];
#[derive(Clone)]
pub struct SmokeRequest {
    pub data_dir: PathBuf,
    pub nonce: String,
    pub protocol_warm: bool,
}
pub fn requested() -> bool {
    std::env::args_os().any(|arg| arg == "--varin-desktop-smoke")
}
pub fn prepare() -> Result<Option<SmokeRequest>, String> {
    if !requested() {
        return Ok(None);
    }
    let raw = std::env::var_os("VARIN_DATA_DIR")
        .filter(|s| !s.is_empty())
        .ok_or("Native smoke requires explicit VARIN_DATA_DIR")?;
    let raw = PathBuf::from(raw);
    let stat = fs::symlink_metadata(&raw)
        .map_err(|_| "CI must pre-create the isolated smoke directory")?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Err("Smoke data directory must be a real directory".into());
    }
    let data_dir = raw
        .canonicalize()
        .map_err(|_| "Smoke directory cannot be resolved")?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "Native temporary directory is unavailable")?;
    if data_dir == temp || !data_dir.starts_with(&temp) {
        return Err(
            "Smoke data directory must be a new child of the native temporary directory".into(),
        );
    }
    let entries: Vec<_> = fs::read_dir(&data_dir)
        .map_err(|_| "Smoke directory cannot be inspected")?
        .collect::<Result<_, _>>()
        .map_err(|_| "Smoke directory entries cannot be inspected")?;
    if entries.len() != 1
        || entries[0].file_name() != "smoke-request.json"
        || !entries[0]
            .file_type()
            .map_err(|_| "Smoke marker cannot be inspected")?
            .is_file()
    {
        return Err("Smoke directory must contain only its request marker".into());
    }
    let marker =
        fs::read(data_dir.join("smoke-request.json")).map_err(|_| "Smoke marker cannot be read")?;
    if marker.len() > 1024 {
        return Err("Invalid smoke marker size".into());
    }
    let marker: Value = serde_json::from_slice(&marker).map_err(|_| "Invalid smoke marker JSON")?;
    let nonce = marker["nonce"].as_str().ok_or("Smoke nonce is missing")?;
    if marker["schema"] != 1 || uuid::Uuid::parse_str(nonce).is_err() {
        return Err("Invalid smoke marker identity".into());
    }
    let protocol_warm = match marker.get("protocolActivation") {
        None => false,
        Some(value) if value == "warm" => true,
        _ => return Err("Invalid native protocol acceptance mode".into()),
    };
    Ok(Some(SmokeRequest {
        data_dir,
        nonce: nonce.into(),
        protocol_warm,
    }))
}
fn report(request: &SmokeRequest, cases: &[Value], complete: bool) -> Result<(), String> {
    let output = json!({"schema":1,"product":"varin-desktop-native-smoke","platform":crate::manifest::platform(),
        "architecture":crate::manifest::architecture(),"version":env!("CARGO_PKG_VERSION"),"nonce":request.nonce,
        "cases":cases,"complete":complete});
    let temporary = request.data_dir.join(".smoke-report.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&output).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, request.data_dir.join("smoke-report.json")).map_err(|e| e.to_string())
}
pub fn startup_failed(request: &SmokeRequest, error: &str) -> Result<(), String> {
    let names = CASES
        .iter()
        .copied()
        .chain(request.protocol_warm.then_some("protocol-warm-activation"));
    let cases:Vec<_>=names.map(|name|json!({"name":name,"status":"failed","error":format!("Native startup did not complete: {error}")})).collect();
    report(request, &cases, false)
}
async fn checked(name: &str, future: impl std::future::Future<Output = Reply>) -> Value {
    match tokio::time::timeout(Duration::from_secs(35), future).await {
        Ok(Ok(evidence)) => json!({"name":name,"status":"passed","evidence":evidence}),
        Ok(Err(error)) => json!({"name":name,"status":"failed","error":error}),
        Err(_) => {
            json!({"name":name,"status":"failed","error":"Original native operation did not produce a receipt before the observation deadline"})
        }
    }
}
async fn command(browser: &BrowserViews, page: &str, method: &str, params: Value) -> Reply {
    browser
        .request(
            "browser.command",
            json!({"pageId":page,"method":method,"params":params}),
        )
        .await
}
async fn eval(browser: &BrowserViews, page: &str, script: &str) -> Reply {
    let value = command(
        browser,
        page,
        "Runtime.evaluate",
        json!({"expression":script,"awaitPromise":true,"returnByValue":true}),
    )
    .await?;
    if value["exceptionDetails"].is_object() {
        return Err("Fixed smoke expression failed in the actual page".into());
    }
    Ok(value["result"]["value"].clone())
}
async fn wait_page(browser: &BrowserViews, page: &str) -> Reply {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(value)=eval(browser,page,"({ready:document.readyState==='complete'&&!!window.varinSmoke,marker:window.varinSmoke?.marker,clicks:window.varinSmoke?.clicks,frames:window.varinSmoke?.frames})").await{
            if value["ready"]==true{return Ok(value)}
        }
        if Instant::now() > deadline {
            return Err("Fixed page did not finish loading".into());
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}
async fn wait_event(events: &Arc<Mutex<Vec<Value>>>, pred: impl Fn(&Value) -> bool) -> Reply {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        let observed = events
            .lock()
            .map_err(|_| "Native observation buffer unavailable")?
            .clone();
        if observed.iter().any(|v| v["kind"] == "smoke-overflow") {
            return Err("Native observation buffer overflowed".into());
        }
        if let Some(value) = observed.into_iter().find(|v| pred(v)) {
            return Ok(value);
        }
        if Instant::now() > deadline {
            return Err("The original native terminal event was not observed".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn event_sink(events: Arc<Mutex<Vec<Value>>>) -> Arc<dyn Fn(Value) + Send + Sync> {
    Arc::new(move |event| {
        let mut events = events.lock().unwrap();
        if events.len() < 4095 {
            events.push(event)
        } else if events.len() == 4095 {
            events.push(json!({"kind":"smoke-overflow"}))
        }
    })
}

/// Called after ordinary initialization, with the real application's private
/// CDP session. The caller exits only after this returns and the report exists.
pub async fn run(app: AppHandle, request: SmokeRequest, main: Session, bootstrap: Value) -> bool {
    let events = Arc::new(Mutex::new(Vec::new()));
    let browser = BrowserViews::new(
        app.clone(),
        event_sink(events.clone()),
        request.data_dir.clone(),
    );
    let mut cases = Vec::new();
    let server = match fixture::Server::start() {
        Ok(server) => server,
        Err(error) => {
            let _ = startup_failed(&request, &error);
            return false;
        }
    };
    let origin = server.origin();
    cases.push(checked("application-bridge",async{
        let deadline=Instant::now()+Duration::from_secs(20);
        loop{
            if !crate::desktop::smoke_renderer_ready(&app){
                if Instant::now()>deadline{return Err("The application renderer did not acknowledge readiness".into())}
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
            let result=main.request("Runtime.evaluate",json!({"expression":"(async()=>{const b=window.__VARIN_DESKTOP__;if(!b||window.__VARIN_DESKTOP_RUNTIME__?.runtime!=='tauri')return {ready:false};const state=await b.invoke('desktop_get_current_window_state',{});return {ready:true,runtime:'tauri',maximized:state.maximized,document:document.readyState}})()","awaitPromise":true,"returnByValue":true})).await?;
            let value=&result["result"]["value"];
            if value["ready"]==true&&value["document"]=="complete"&&crate::desktop::smoke_renderer_ready(&app){
                let toolkit=toolkit()?;
                ready(&request)?;
                return Ok(json!({"renderer":value,"toolkit":toolkit,"bootTarget":bootstrap["bootOutcome"]["target"],"bootStatus":bootstrap["bootOutcome"]["status"]}))
            }
            if Instant::now()>deadline{return Err("The packaged application did not complete a real bridge round trip".into())}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await);
    let created = browser
        .request(
            "browser.create",
            json!({"pageId":"native-smoke-page","requestContext":"interactive"}),
        )
        .await;
    let page = "native-smoke-page";
    let mut same_page = checked("browser-same-page",async{
        created?;
        browser.request("browser.load",json!({"pageId":page,"url":format!("{origin}/page")})).await?;
        let before=wait_page(&browser,page).await?;
        let present=|visible|json!({"pageId":page,"windowLabel":"main","viewId":"native-smoke-view","visible":visible,"bounds":{"x":40,"y":80,"width":640,"height":480}});
        browser.request("browser.present",present(true)).await?;
        let shown=wait_presentation(&browser,page,"main",true).await?;
        browser.request("browser.layout",present(false)).await?;
        let hidden=wait_presentation(&browser,page,"browser-parking",false).await?;
        let hidden_stream=hidden_screencast(&browser,page,&events).await?;
        browser.request("browser.layout",present(true)).await?;
        let reshown=wait_presentation(&browser,page,"main",true).await?;
        browser.request("browser.detach",json!({"pageId":page,"windowLabel":"main","viewId":"native-smoke-view"})).await?;
        let detached=wait_presentation(&browser,page,"browser-parking",false).await?;
        browser.request("browser.present",present(true)).await?;
        let remounted=wait_presentation(&browser,page,"main",true).await?;
        if [hidden["browserId"].clone(),reshown["browserId"].clone(),detached["browserId"].clone(),remounted["browserId"].clone()].iter().any(|id|*id!=shown["browserId"]){return Err("Presentation replaced the original native Browser".into())}
        let native_input=input::click(&app,120.,160.).await?;
        let deadline=Instant::now()+Duration::from_secs(10);
        let after=loop{let value=wait_page(&browser,page).await?;if value["clicks"]==1{break value}if Instant::now()>deadline{return Err("The actual native mouse click did not reach the embedded page".into())}tokio::time::sleep(Duration::from_millis(25)).await;};
        if before["marker"]!=after["marker"]{return Err("Embedding or hide/show/remount reloaded the original page".into())}
        Ok(json!({"before":before,"after":after,"nativeInput":native_input,"shown":shown,"hidden":hidden,"hiddenScreencast":hidden_stream,"reshown":reshown,"detached":detached,"remounted":remounted}))
    }).await;
    // Even a failed/expired observation must stop its original stream. This is
    // not page closure: later cases and remounts retain the very same document.
    let stop = command(&browser, page, "Page.stopScreencast", json!({})).await;
    if same_page["status"] == "passed" {
        if let Err(error) = stop {
            same_page = json!({"name":"browser-same-page","status":"failed","error":format!("The original screencast did not stop: {error}")});
        }
    }
    cases.push(same_page);
    cases.push(checked("browser-authority-isolation",async{
        let value=eval(&browser,page,"({ipc:typeof window.ipc,tauri:typeof window.__TAURI_INTERNALS__,desktop:typeof window.__VARIN_DESKTOP__,token:typeof window.__VARIN_CLIENT_TOKEN__})").await?;
        if ["ipc","tauri","desktop","token"].iter().any(|key|value[*key]!="undefined"){return Err("Untrusted Browser page received application authority".into())}
        if command(&browser,page,"Target.createTarget",json!({"url":"about:blank"})).await.is_ok(){return Err("Browser lifecycle authority escaped its owner".into())}
        Ok(value)
    }).await);
    cases.push(checked("browser-context-isolation",async{
        command(&browser,page,"Network.setCookie",json!({"name":"varin_smoke_browser","value":"private","url":origin})).await?;
        let own=command(&browser,page,"Network.getCookies",json!({"urls":[origin]})).await?;
        let app_cookies=main.request("Network.getCookies",json!({"urls":[origin]})).await?;
        browser.request("browser.create",json!({"pageId":"native-smoke-isolated","requestContext":"web-render"})).await?;
        let anonymous=command(&browser,"native-smoke-isolated","Network.getCookies",json!({"urls":[origin]})).await?;
        let has=|v:&Value|v["cookies"].as_array().is_some_and(|a|a.iter().any(|c|c["name"]=="varin_smoke_browser"));
        if !has(&own)||has(&app_cookies)||has(&anonymous){return Err("CEF Browser/application/anonymous cookie contexts are not isolated".into())}
        browser.request("browser.close",json!({"pageId":"native-smoke-isolated"})).await?;
        Ok(json!({"browserCookiePresent":true,"applicationCookiePresent":false,"anonymousCookiePresent":false}))
    }).await);
    cases.push(checked("browser-capture",async{
        let captured=browser.request("browser.capture",json!({"pageId":page})).await?;
        let path=captured["file"].as_str().ok_or("Capture path missing")?;
        let bytes=fs::read(path).map_err(|e|e.to_string())?;
        if bytes.len()<24||&bytes[..8]!=b"\x89PNG\r\n\x1a\n"||captured["width"].as_u64().unwrap_or(0)==0{return Err("Actual Browser capture is not a nonempty PNG".into())}
        let evidence=json!({"sha256":captured["sha256"],"size":bytes.len(),"width":captured["width"],"height":captured["height"]});
        browser.request("browser.releaseCapture",json!({"captureId":captured["captureId"]})).await?;
        Ok(evidence)
    }).await);
    cases.push(
        checked("browser-download-terminal", async {
            eval(
                &browser,
                page,
                "document.getElementById('download').click();true",
            )
            .await?;
            let start = wait_event(&events, |e| {
                e["kind"] == "download-start" && e["pageId"] == page
            })
            .await?;
            let id = start["downloadId"]
                .as_str()
                .ok_or("Download identity missing")?;
            let directory = request
                .data_dir
                .join("browser-transfers")
                .join(format!("download-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            browser
                .request(
                    "browser.download.save",
                    json!({"downloadId":id,"filePath":directory.join("content")}),
                )
                .await?;
            let terminal = wait_event(&events, |e| {
                e["kind"] == "download-progress"
                    && e["downloadId"] == id
                    && e["state"] == "completed"
            })
            .await?;
            let bytes = fs::read(directory.join("content")).map_err(|e| e.to_string())?;
            if bytes != fixture::DOWNLOAD {
                return Err("Native download bytes differ from the fixed response".into());
            }
            browser
                .request("browser.download.release", json!({"downloadId":id}))
                .await?;
            Ok(json!({"terminal":terminal,"exactBytes":true}))
        })
        .await,
    );
    // Ownership survives an observation timeout. Every original resource is
    // drained below even when its individual test failed or stopped observing.
    let osr_owned = Arc::new(Mutex::new(None));
    cases.push(checked("osr-alpha-composition", osr(&app, osr_owned.clone())).await);
    let network_events = Arc::new(Mutex::new(Vec::new()));
    let network_owner = NetworkService::new(
        app.clone(),
        request.data_dir.join("network-smoke"),
        event_sink(network_events.clone()),
    );
    cases.push(
        checked("network-stream-cancel", async {
            network(
                network_owner.as_ref().map_err(Clone::clone)?,
                &network_events,
                &origin,
                &server,
            )
            .await
        })
        .await,
    );
    cases.push(checked("renderer-sandbox", sandbox::observe(&app, &browser, page)).await);
    cases.push(checked("browser-pending-close",async{
        let pending=command(&browser,page,"Runtime.evaluate",json!({"expression":"new Promise(()=>{})","awaitPromise":true,"returnByValue":true}));
        tokio::pin!(pending);
        tokio::select!{value=&mut pending=>return Err(format!("Pending page effect unexpectedly finished: {}",value.is_ok())),_=tokio::time::sleep(Duration::from_millis(100))=>{}}
        browser.request("browser.close",json!({"pageId":page})).await?;
        if pending.await.is_ok(){return Err("Closing the page fabricated success for a pending effect".into())}
        Ok(json!({"nativeCloseObserved":true,"pendingEffectRejected":true}))
    }).await);
    if request.protocol_warm {
        cases.push(checked("protocol-warm-activation", protocol(&request)).await);
    }
    let drained: Reply = async {
        let mut failures = Vec::new();
        if let Err(error) = browser.shutdown().await {
            failures.push(error)
        }
        if let Ok(owner) = network_owner {
            if let Err(error) = owner.shutdown().await {
                failures.push(error)
            }
        }
        let owned = osr_owned.lock().unwrap().take();
        if let Some((window, closed)) = owned {
            if let Err(error) = closed.request(window.as_ref()).await {
                failures.push(error)
            }
        }
        if let Err(error) = crate::desktop::smoke_shutdown(&app).await {
            failures.push(error)
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        Ok(json!({"browserOwnerDrained":true,"applicationAndHostScopesEnded":true}))
    }
    .await;
    cases.push(match drained {
        Ok(evidence) => json!({"name":"native-drain","status":"passed","evidence":evidence}),
        Err(error) => json!({"name":"native-drain","status":"failed","error":error}),
    });
    server.stop();
    let passed = cases.len() == CASES.len() + usize::from(request.protocol_warm)
        && cases.iter().all(|c| c["status"] == "passed");
    report(&request, &cases, true).is_ok() && passed
}

type OsrOwned = Arc<Mutex<Option<(tauri::WebviewWindow, crate::lifecycle::CloseReceipt)>>>;
async fn osr(app: &AppHandle, owned: OsrOwned) -> Reply {
    const LABEL: &str = "native-smoke-alpha";
    // A fixed inert page. It receives no IPC, file authority or arbitrary code.
    const HTML: &str = r#"<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';script-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;overflow:hidden}div{position:absolute;top:24px;width:96px;height:96px;background:rgba(255,0,0,.5)}</style><div></div><script>let x=0;function tick(){document.querySelector('div').style.left=(x++%100)+'px';requestAnimationFrame(tick)}tick()</script>"#;
    let url = format!(
        "data:text/html;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(HTML)
    );
    let mut builder = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::External(url.parse().map_err(|_| "Smoke page URL is invalid")?),
    )
    .title("Varin native alpha acceptance")
    .inner_size(256., 180.)
    .decorations(false)
    .visible(true)
    .focused(false);
    builder = offscreen::transparent(builder, LABEL)?;
    builder
        .runtime_specific_attributes_mut()
        .as_cef_webview_attributes_mut()
        .ok_or("CEF attributes unavailable")?
        .native_only = true;
    let close = crate::lifecycle::attach(&mut builder, app, LABEL)?;
    let window = builder.build().map_err(|e| e.to_string())?;
    *owned.lock().unwrap() = Some((window, close));
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let observed = offscreen::observe(app, LABEL).await?;
        if let Some(error) = observed["error"].as_str() {
            return Err(error.to_owned());
        }
        if observed["paints"].as_u64().unwrap_or(0) >= 3
            && observed["presentations"].as_u64().unwrap_or(0) >= 3
        {
            if observed["alphaMin"] != 0
                || observed["alphaMax"]
                    .as_u64()
                    .is_none_or(|a| a == 0 || a == 255)
            {
                return Err(
                    "Actual animated CEF pixels did not preserve partial transparency".into(),
                );
            }
            if !matches!(
                observed["gpu"]["alphaMode"].as_str(),
                Some("PreMultiplied" | "PostMultiplied")
            ) {
                return Err("Native GPU surface did not use alpha composition".into());
            }
            return Ok(observed);
        }
        if Instant::now() > deadline {
            return Err("Animated CEF pixels were not presented by the native GPU surface".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn network(
    owner: &NetworkService,
    events: &Arc<Mutex<Vec<Value>>>,
    origin: &str,
    server: &fixture::Server,
) -> Reply {
    use std::io::Read;
    let transfer = owner.handle("network.allocate", json!({})).await?;
    let id = transfer["requestId"]
        .as_str()
        .ok_or("Native network identity missing")?;
    let path = transfer["responsePath"]
        .as_str()
        .ok_or("Native network spool missing")?;
    owner.handle("network.start",json!({"requestId":id,"url":format!("{origin}/stream"),"method":"GET","headers":[],"hasBody":false})).await?;
    let headers = wait_event(events, |e| e["requestId"] == id && e["kind"] == "headers").await?;
    if headers["status"] != 200 {
        return Err("Native network response status differs from the fixture".into());
    }
    let data = wait_event(events, |e| {
        e["requestId"] == id && e["kind"] == "data" && e["available"].as_u64().unwrap_or(0) >= 14
    })
    .await?;
    let count = data["available"]
        .as_u64()
        .ok_or("Native stream cursor missing")?
        .min(4096) as usize;
    let mut bytes = vec![0; count];
    {
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    }
    if !bytes.starts_with(b"native-stream\n") {
        return Err("Actual streamed response differs from the fixture".into());
    }
    owner
        .handle("network.ack", json!({"requestId":id,"consumed":count}))
        .await?;
    owner
        .handle("network.cancel", json!({"requestId":id}))
        .await?;
    let terminal = wait_event(events, |e| e["requestId"] == id && e["kind"] == "complete").await?;
    if terminal["outcome"] != "cancelled" {
        return Err("Original CEF request did not acknowledge cancellation".into());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while !server.stream_closed() {
        if Instant::now() > deadline {
            return Err("The server did not observe the original stream connection end".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if server.stream_cookie() != Some(false) {
        return Err(
            "Anonymous native network context transmitted Browser cookies or was not observed"
                .into(),
        );
    }
    owner
        .handle("network.release", json!({"requestId":id}))
        .await?;
    Ok(
        json!({"status":headers["status"],"bytesRead":count,"terminal":terminal["outcome"],"connectionEnded":true,"browserCookiesSent":false}),
    )
}

fn toolkit() -> Reply {
    #[cfg(target_os = "linux")]
    {
        let maps = fs::read_to_string("/proc/self/maps")
            .map_err(|_| "Native toolkit modules are not observable")?;
        let gtk4 = maps.lines().any(|line| line.contains("/libgtk-4.so."));
        let gtk3 = maps.lines().any(|line| line.contains("/libgtk-3.so."));
        if !gtk4 || gtk3 {
            return Err("GTK4 was not loaded exclusively in the actual desktop process".into());
        }
        Ok(json!({"gtk4Loaded":true,"gtk3Loaded":false}))
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(json!({"nativeWindowToolkit":crate::manifest::platform()}))
    }
}

/// Observe actual captured pixels while the original native child and parking
/// window are hidden. A configuration flag, advancing JS timer, or repeated
/// screenshot is not evidence that streaming hidden pages produce frames.
async fn hidden_screencast(
    browser: &BrowserViews,
    page: &str,
    events: &Arc<Mutex<Vec<Value>>>,
) -> Reply {
    // Let a pre-hide compositor submission settle before establishing the
    // capture stream. Only newly delivered, acknowledged frames count.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = eval(
        browser,
        page,
        "({marker:varinSmoke.marker,frames:varinSmoke.frames})",
    )
    .await?;
    command(browser,page,"Page.startScreencast",json!({"format":"png","maxWidth":160,"maxHeight":120,"everyNthFrame":1,"maxFramesInFlight":1})).await?;
    let started = Instant::now();
    let result: Reply = async {
        let mut frames = Vec::new();
        let mut hashes = std::collections::HashSet::new();
        loop {
            let frame = {
                let mut queue = events.lock().map_err(|_|"Native frame observation buffer unavailable")?;
                if queue.iter().any(|event|event["kind"]=="smoke-overflow") {
                    return Err("Native frame observation buffer overflowed".into());
                }
                let index = queue.iter().position(|event|event["pageId"]==page && event["kind"]=="cdp" && event["method"]=="Page.screencastFrame");
                index.map(|index|queue.remove(index))
            };
            if let Some(frame) = frame {
                let params = &frame["params"];
                let session = params["sessionId"].as_i64().ok_or("Screencast frame omitted its actual acknowledgement identity")?;
                // Acknowledge this precise observed delivery, never a guessed
                // counter. No PNG pixels or arbitrary page content enter logs.
                command(browser,page,"Page.screencastFrameAck",json!({"sessionId":session})).await?;
                let data = params["data"].as_str().ok_or("Screencast frame omitted pixels")?;
                if data.len()>256*1024 {return Err("Fixed 160px screencast exceeded its bounded pixel budget".into())}
                let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_|"Screencast pixel data is malformed")?;
                if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {return Err("Actual screencast did not deliver PNG pixels".into())}
                let hash = format!("{:x}",Sha256::digest(&bytes));
                if hashes.insert(hash.clone()) {
                    frames.push(json!({"sha256":hash,"bytes":bytes.len(),"timestamp":params["metadata"]["timestamp"],"observedMs":started.elapsed().as_millis() as u64}));
                }
                if frames.len()>=3 && started.elapsed()>=Duration::from_millis(400) {break}
                if frames.len()>120 {return Err("Hidden stream observation exceeded its bounded evidence budget".into())}
            }
            if started.elapsed()>Duration::from_secs(8) {return Err(format!("Hidden native page did not continuously deliver changing screencast pixels ({} distinct frames)",frames.len()))}
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let after = eval(browser,page,"({marker:varinSmoke.marker,frames:varinSmoke.frames})").await?;
        if after["marker"]!=before["marker"] || after["frames"].as_u64().unwrap_or(0)<=before["frames"].as_u64().unwrap_or(u64::MAX) {
            return Err("Hidden capture did not preserve and animate the original document".into());
        }
        let presentation=wait_presentation(browser,page,"browser-parking",false).await?;
        Ok(json!({"before":before,"after":after,"frames":frames,"presentation":presentation,"acknowledged":true}))
    }.await;
    let stopped = command(browser, page, "Page.stopScreencast", json!({})).await;
    match (result, stopped) {
        (Ok(mut evidence), Ok(_)) => {
            evidence["stopped"] = json!(true);
            Ok(evidence)
        }
        (Err(error), Ok(_)) => Err(error),
        (_, Err(error)) => Err(format!(
            "Original hidden-page stream termination was not observed: {error}"
        )),
    }
}

async fn wait_presentation(
    browser: &BrowserViews,
    page: &str,
    label: &str,
    visible: bool,
) -> Reply {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = browser.smoke_presentation(page).await?;
        if value["parentMatches"] == true
            && value["visible"] == visible
            && value["windowLabel"] == label
        {
            return Ok(value);
        }
        if Instant::now() > deadline {
            return Err(format!(
                "Native parent/visibility did not match the requested presentation: {value}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn ready(request: &SmokeRequest) -> Result<(), String> {
    let temporary = request.data_dir.join(".smoke-ready.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(&json!({"schema":1,"nonce":request.nonce,"pid":std::process::id()}))
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, request.data_dir.join("smoke-ready.json")).map_err(|e| e.to_string())
}
async fn protocol(request: &SmokeRequest) -> Reply {
    let file = request.data_dir.join("smoke-protocol-activation.json");
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        match fs::symlink_metadata(&file) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096
                {
                    return Err("Native protocol receipt is not a bounded regular file".into());
                }
                let value: Value =
                    serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                        .map_err(|_| "Native protocol receipt is malformed")?;
                if value["schema"] != 1
                    || value["nonce"] != request.nonce
                    || value["pid"] != std::process::id()
                    || !matches!(value["source"].as_str(), Some("opened" | "single-instance"))
                {
                    return Err("The OS did not activate the original running application through its installed protocol handler".into());
                }
                return Ok(value);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Native protocol receipt cannot be inspected".into()),
        }
        if Instant::now() > deadline {
            return Err("No actual warm OS protocol activation was received".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
