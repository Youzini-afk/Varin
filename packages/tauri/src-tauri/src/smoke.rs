//! Fixed, opt-in native acceptance suite. Never a production remote-debug API.
//! Runs only in an explicitly prepared temporary data directory. A fixture
//! restart additionally requires the previous complete native drain receipt.
mod fixture;
mod http;
mod http_body;
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
    pub legacy_fixture_nonce: Option<String>,
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
    if !fs::symlink_metadata(data_dir.join("smoke-request.json"))
        .map_err(|_| "Smoke marker cannot be inspected")?.is_file() {
        return Err("Smoke request must be a regular file".into());
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
    let legacy_fixture_nonce = match marker.get("legacyFixtureNonce") {
        None => None,
        Some(value) => {
            let fixture = value.as_str().filter(|v| uuid::Uuid::parse_str(v).is_ok())
                .ok_or("Invalid synthetic legacy fixture identity")?;
            if marker["disposableOsUser"] != true
                || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
                || std::env::var("RUNNER_ENVIRONMENT").as_deref() != Ok("github-hosted") {
                return Err("Legacy smoke requires an explicit disposable GitHub-hosted OS user".into());
            }
            Some(fixture.to_owned())
        }
    };
    if let Some(previous) = marker.get("previousNonce") {
        if legacy_fixture_nonce.is_none() {
            return Err("Only the fixed legacy fixture can reopen a smoke data directory".into());
        }
        let file = data_dir.join("smoke-report.json");
        let stat = fs::symlink_metadata(&file).map_err(|_| "Previous native report is unavailable")?;
        if !stat.is_file() || stat.len() > 1024 * 1024 {
            return Err("Previous native report is not a bounded regular file".into());
        }
        let prior: Value = serde_json::from_slice(&fs::read(file).map_err(|_| "Previous native report cannot be read")?)
            .map_err(|_| "Previous native report is malformed")?;
        let cases = prior["cases"].as_array().ok_or("Previous native cases are missing")?;
        if prior["schema"] != 1 || prior["product"] != "varin-desktop-native-smoke"
            || prior["nonce"] != *previous || prior["complete"] != true
            || prior["legacyFixtureNonce"] != marker["legacyFixtureNonce"]
            || prior["platform"] != crate::manifest::platform()
            || prior["architecture"] != crate::manifest::architecture()
            || cases.iter().any(|case| case["status"] != "passed")
            || ["native-drain", "legacy-native-migration"].iter().any(|name| !cases.iter().any(|case| case["name"] == *name)) {
            return Err("Previous fixture did not confirm successful native migration and drain".into());
        }
    } else {
        let entries = fs::read_dir(&data_dir)
            .map_err(|_| "Smoke directory cannot be inspected")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Smoke directory entries cannot be inspected")?;
        if entries.len() != 1 || entries[0].file_name() != "smoke-request.json" {
            return Err("Smoke directory must contain only its request marker".into());
        }
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
        legacy_fixture_nonce,
    }))
}
fn report(request: &SmokeRequest, cases: &[Value], complete: bool) -> Result<(), String> {
    let output = json!({"schema":1,"product":"varin-desktop-native-smoke","platform":crate::manifest::platform(),
        "architecture":crate::manifest::architecture(),"version":env!("CARGO_PKG_VERSION"),"nonce":request.nonce,
        "legacyFixtureNonce":request.legacy_fixture_nonce,"cases":cases,"complete":complete});
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
        .chain(request.protocol_warm.then_some("protocol-warm-activation"))
        .chain(request.legacy_fixture_nonce.as_ref().map(|_| "legacy-native-migration"));
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
    let service = match crate::desktop::smoke_browser_service(&app).await {
        Ok(service) => service,
        Err(error) => {
            let _ = crate::desktop::smoke_shutdown(&app).await;
            let _ = startup_failed(&request, &error);
            return false;
        }
    };
    let browser = service.browser.clone();
    let _observer = match browser.smoke_observe(event_sink(events.clone())) {
        Ok(observer) => observer,
        Err(error) => {
            let _ = crate::desktop::smoke_shutdown(&app).await;
            let _ = startup_failed(&request, &error);
            return false;
        }
    };
    let http = http::Client::new(service.process.snapshot());
    let mut cases = Vec::new();
    let server = match fixture::Server::start() {
        Ok(server) => server,
        Err(error) => {
            let _ = crate::desktop::smoke_shutdown(&app).await;
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
                let window=app.get_webview_window("main").ok_or("Original application window is missing")?;
                // Exercise the same original-window restoration used by Dock
                // and second-instance activation, without reloading its page.
                main.request("Runtime.evaluate",json!({"expression":"window.__varinSmokeReactivation=crypto.randomUUID()","returnByValue":true})).await?;
                let before=main.request("Runtime.evaluate",json!({"expression":"window.__varinSmokeReactivation","returnByValue":true})).await?;
                window.hide().map_err(|_|"Original application window could not hide")?;
                if crate::desktop::show_last_conversation(&app)?!="main"||!window.is_visible().map_err(|_|"Restored visibility is unknown")? {
                    return Err("Reactivation did not restore the original conversation window".into());
                }
                let after=main.request("Runtime.evaluate",json!({"expression":"window.__varinSmokeReactivation","returnByValue":true})).await?;
                if before["result"]["value"]!=after["result"]["value"] { return Err("Window reactivation replaced the original document".into()); }
                ready(&request)?;
                return Ok(json!({"renderer":value,"toolkit":toolkit,"originalWindowRestored":true,"bootTarget":bootstrap["bootOutcome"]["target"],"bootStatus":bootstrap["bootOutcome"]["status"]}))
            }
            if Instant::now()>deadline{return Err("The packaged application did not complete a real bridge round trip".into())}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await);
    if let Some(nonce) = &request.legacy_fixture_nonce {
        cases.push(checked("legacy-native-migration", crate::legacy_migration::observe_smoke(
            &app, &request.data_dir, &main, &bootstrap["migration"], nonce,
        )).await);
    }
    let page = "native-smoke-page";
    cases.push(checked("browser-same-page",async{
        let present=|visible|json!({"pageId":page,"viewId":"native-smoke-view","url":"about:blank","visible":visible,"bounds":{"x":40,"y":80,"width":640,"height":480}});
        let created=node(&service,"desktop_browser_present",present(true)).await?;
        if created["pageId"]!=page{return Err("The Node Browser owner did not preserve the requested page identity".into())}
        node(&service,"desktop_browser_action",json!({"pageId":page,"action":{"action":"navigate","url":format!("{origin}/page")}})).await?;
        let before=wait_node_page(&service,page).await?;
        let shown=wait_presentation(&browser,page,"main",true).await?;
        node(&service,"desktop_browser_layout",present(false)).await?;
        let hidden=wait_presentation(&browser,page,"browser-parking",false).await?;
        let hidden_stream=hidden_screencast(&browser,page,http.as_ref().map_err(Clone::clone)?).await?;
        node(&service,"desktop_browser_layout",present(true)).await?;
        let reshown=wait_presentation(&browser,page,"main",true).await?;
        node(&service,"desktop_browser_detach",json!({"pageId":page,"viewId":"native-smoke-view"})).await?;
        let detached=wait_presentation(&browser,page,"browser-parking",false).await?;
        node(&service,"desktop_browser_present",present(true)).await?;
        let remounted=wait_presentation(&browser,page,"main",true).await?;
        if [hidden["browserId"].clone(),reshown["browserId"].clone(),detached["browserId"].clone(),remounted["browserId"].clone()].iter().any(|id|*id!=shown["browserId"]){return Err("Presentation replaced the original native Browser".into())}
        let bounds=&remounted["bounds"];
        let(x,y)=(bounds["x"].as_f64().ok_or("Actual embedded x coordinate missing")?,bounds["y"].as_f64().ok_or("Actual embedded y coordinate missing")?);
        let native_input=input::click(&app,x+80.,y+80.).await?;
        let deadline=Instant::now()+Duration::from_secs(10);
        let after=loop{let value=wait_node_page(&service,page).await?;if value["clicks"]==1{break value}if Instant::now()>deadline{return Err("The actual native mouse click did not reach the embedded page".into())}tokio::time::sleep(Duration::from_millis(25)).await;};
        if before["marker"]!=after["marker"]{return Err("Embedding or hide/show/remount reloaded the original page".into())}
        Ok(json!({"owner":"production-node-puppeteer-native-transport","before":before,"after":after,"nativeInput":native_input,"shown":shown,"hidden":hidden,"hiddenScreencast":hidden_stream,"reshown":reshown,"detached":detached,"remounted":remounted}))
    }).await);
    cases.push(checked("browser-authority-isolation",async{
        let value=node_eval(&service,page,"({ipc:typeof window.ipc,tauri:typeof window.__TAURI_INTERNALS__,desktop:typeof window.__VARIN_DESKTOP__,token:typeof window.__VARIN_CLIENT_TOKEN__})").await?;
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
        let captured=node(&service,"desktop_browser_read",json!({"pageId":page,"view":"screenshot"})).await?;
        let image=&captured["image"];
        let pixels=image["base64"].as_str().filter(|value|value.len()<=16*1024*1024).ok_or("Original Node capture omitted bounded pixels")?;
        let bytes=base64::engine::general_purpose::STANDARD.decode(pixels).map_err(|_|"Node capture encoding is malformed")?;
        if bytes.len()<24||&bytes[..8]!=b"\x89PNG\r\n\x1a\n"||image["mimeType"]!="image/png"||image["width"].as_u64().unwrap_or(0)==0||captured["page"]["pageId"]!=page{return Err("Original Node capture is not a nonempty PNG from the same page".into())}
        Ok(json!({"owner":"production-node-browser-read","sha256":format!("{:x}",Sha256::digest(&bytes)),"size":bytes.len(),"width":image["width"],"height":image["height"],"observationId":captured["observationId"]}))
    }).await);
    cases.push(
        checked("browser-download-terminal", async {
            node_eval(
                &service,
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
                .ok_or("Original native download identity missing")?;
            let terminal = wait_event(&events, |e| {
                e["kind"] == "download-progress"
                    && e["downloadId"] == id
                    && e["state"] == "completed"
                    && e["terminal"] == true
            })
            .await?;
            // The real Node owner owns saveTo, writer completion, bytes and release.
            // A second save callback here would steal authority from that owner.
            let client = http.as_ref().map_err(Clone::clone)?.clone();
            let url = format!("{origin}/download");
            let download =
                tokio::task::spawn_blocking(move || client.download("native-smoke-page", &url))
                    .await
                    .map_err(|_| "Original Node download observation ended")??;
            Ok(json!({"terminal":terminal,"download":download,"exactBytes":true}))
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
        let pending=node_eval(&service,page,"(()=>{varinSmoke.pending=true;return new Promise(()=>{})})()");
        tokio::pin!(pending);
        let deadline=Instant::now()+Duration::from_secs(5);
        loop {
            tokio::select!{value=&mut pending=>return Err(format!("Original Node page effect unexpectedly finished: {}",value.is_ok())),_=tokio::time::sleep(Duration::from_millis(25))=>{}}
            if eval(&browser,page,"window.varinSmoke.pending===true").await?==true{break}
            if Instant::now()>deadline{return Err("The original Puppeteer effect was not actually dispatched".into())}
        }
        node(&service,"desktop_browser_action",json!({"pageId":page,"action":{"action":"close"}})).await?;
        wait_event(&events,|e|e["kind"]=="closed"&&e["pageId"]==page).await?;
        if pending.await.is_ok(){return Err("Closing the page fabricated success for the pending Puppeteer effect".into())}
        Ok(json!({"owner":"production-node-puppeteer-native-transport","effectDispatched":true,"nativeCloseObserved":true,"pendingEffectRejected":true}))
    }).await);
    if request.protocol_warm {
        cases.push(checked("protocol-warm-activation", protocol(&request)).await);
    }
    let drained: Reply = async {
        let mut failures = Vec::new();
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
    let passed = cases.len() == CASES.len() + usize::from(request.protocol_warm) + usize::from(request.legacy_fixture_nonce.is_some())
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

/// The same authenticated Host stream used by real Browser clients. The Node
/// owner, rather than this suite, owns ACKs and the activity/capture lease.
async fn hidden_screencast(browser: &BrowserViews, page: &str, http: &http::Client) -> Reply {
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before=eval(browser,page,"({marker:varinSmoke.marker,frames:varinSmoke.frames,visibility:document.visibilityState,focus:document.hasFocus()})").await?;
    let client = http.clone();
    let id = page.to_owned();
    let frames = tokio::task::spawn_blocking(move || client.frames(&id))
        .await
        .map_err(|_| "Original production frame observer ended")??;
    let deadline = Instant::now() + Duration::from_secs(10);
    let state = loop {
        let client = http.clone();
        let catalog = tokio::task::spawn_blocking(move || client.pages())
            .await
            .map_err(|_| "Original Browser catalog observer ended")??;
        let current = catalog["pages"]
            .as_array()
            .and_then(|pages| pages.iter().find(|item| item["pageId"] == page))
            .cloned()
            .ok_or("Stopping the stream closed or replaced its original Browser page")?;
        if current["viewers"] == 0 {
            let owner = catalog["devices"]
                .as_array()
                .and_then(|devices| {
                    devices
                        .iter()
                        .find(|device| device["browserId"] == current["browserId"])
                })
                .ok_or("Original Browser device disappeared after stream stop")?;
            if owner["ownerGeneration"] != frames["identity"]["ownerGeneration"] {
                return Err(
                    "The production stream changed its original Browser owner generation".into(),
                );
            }
            break current;
        }
        if Instant::now() > deadline {
            return Err(
                "The production stream did not release its original viewer/activity lease".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    };
    let after=eval(browser,page,"({marker:varinSmoke.marker,frames:varinSmoke.frames,visibility:document.visibilityState,focus:document.hasFocus()})").await?;
    if before["marker"] != after["marker"]
        || after["frames"].as_u64().unwrap_or(0) <= before["frames"].as_u64().unwrap_or(u64::MAX)
    {
        return Err(
            "The hidden production stream did not animate and retain the original page".into(),
        );
    }
    let identity = &frames["identity"];
    if state["browserId"] != identity["browserId"]
        || state["generation"] != identity["pageGeneration"]
    {
        return Err("The production stream changed its original Browser/page generation".into());
    }
    if before["visibility"] != after["visibility"] || before["focus"] != after["focus"] {
        return Err(
            "The production capture lease did not restore the original page visibility/focus state"
                .into(),
        );
    }
    let presentation = wait_presentation(browser, page, "browser-parking", false).await?;
    Ok(
        json!({"before":before,"after":after,"stream":frames,"presentation":presentation,"viewersAfterStop":state["viewers"],"originalPageRetained":true}),
    )
}

async fn node(service: &crate::service::NativeService, command: &str, args: Value) -> Reply {
    service
        .process
        .request(
            "browserInvoke",
            json!({"command":command,"args":args,"windowLabel":"main"}),
        )
        .await
}
async fn node_eval(service: &crate::service::NativeService, page: &str, script: &str) -> Reply {
    let result = node(
        service,
        "desktop_browser_action",
        json!({"pageId":page,"action":{"action":"evaluate","script":script}}),
    )
    .await?;
    if result["page"]["pageId"] != page || result["method"] != "page-script" {
        return Err("The original Node page-script receipt was not returned".into());
    }
    Ok(result["value"].clone())
}
async fn wait_node_page(service: &crate::service::NativeService, page: &str) -> Reply {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(value)=node_eval(service,page,"({ready:document.readyState==='complete'&&!!window.varinSmoke,marker:window.varinSmoke?.marker,clicks:window.varinSmoke?.clicks,frames:window.varinSmoke?.frames})").await {
            if value["ready"]==true{return Ok(value)}
        }
        if Instant::now() > deadline {
            return Err("The original Node/Puppeteer page did not finish loading".into());
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
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
