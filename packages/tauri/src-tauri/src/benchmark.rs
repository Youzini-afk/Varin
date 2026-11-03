//! Opt-in full-product measurement. The only executable script is compiled in;
//! the private request contains DOM observations and a bounded input vocabulary.
//! There is no remote debugger, user JavaScript, replacement page or test Host.
use crate::cdp::Session;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::AppHandle;

const PAGE: &str = include_str!("../../scripts/benchmark-page.js");
const SCENARIOS: &[&str] = &[
    "remote-idle",
    "long-chat-stream",
    "workspace-transitions",
    "companion-drag",
    "browser-interaction",
    "local-hybrid-execution",
    "repeated-lifecycle",
];
#[derive(Clone)]
pub struct BenchmarkRequest {
    pub data_dir: PathBuf,
    pub nonce: String,
    document: Value,
}
pub fn prepare() -> Result<Option<BenchmarkRequest>, String> {
    if !std::env::args_os().any(|arg| arg == "--varin-desktop-benchmark") {
        return Ok(None);
    }
    if crate::smoke::requested() {
        return Err("Smoke and performance modes are mutually exclusive".into());
    }
    let raw = PathBuf::from(
        std::env::var_os("VARIN_DATA_DIR")
            .filter(|s| !s.is_empty())
            .ok_or("Benchmark requires explicit VARIN_DATA_DIR")?,
    );
    let stat = fs::symlink_metadata(&raw).map_err(|_| "Benchmark data directory does not exist")?;
    let data_dir = raw
        .canonicalize()
        .map_err(|_| "Benchmark directory is unavailable")?;
    let temporary = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| "Native temporary directory is unavailable")?;
    if !raw.is_absolute()
        || !stat.is_dir()
        || stat.file_type().is_symlink()
        || data_dir == temporary
        || !data_dir.starts_with(temporary)
    {
        return Err("Benchmark must use a new real child of the OS temporary directory".into());
    }
    let marker = data_dir.join("benchmark-request.json");
    let stat = fs::symlink_metadata(&marker).map_err(|_| "Benchmark request marker is missing")?;
    if !stat.is_file() || stat.len() > 1024 * 1024 {
        return Err("Benchmark marker must be a bounded regular file".into());
    }
    let document: Value =
        serde_json::from_slice(&fs::read(marker).map_err(|_| "Benchmark request cannot be read")?)
            .map_err(|_| "Invalid benchmark JSON")?;
    let nonce = document["nonce"]
        .as_str()
        .ok_or("Missing benchmark nonce")?
        .to_owned();
    let workload = &document["workload"];
    if document["schema"] != 1
        || document["product"] != "varin-desktop-benchmark-request"
        || uuid::Uuid::parse_str(&nonce).is_err()
        || document["version"] != env!("CARGO_PKG_VERSION")
        || workload["motion"] != "full"
        || !SCENARIOS.contains(&workload["name"].as_str().unwrap_or(""))
        || !document["sampleIntervalMs"]
            .as_f64()
            .is_some_and(|v| v.is_finite() && v > 0.)
        || !workload["timeoutMs"]
            .as_f64()
            .is_some_and(|v| v.is_finite() && v > 0.)
        || !workload["readyTimeoutMs"]
            .as_f64()
            .is_some_and(|v| v.is_finite() && v > 0.)
        || !workload["ready"].as_array().is_some_and(|v| !v.is_empty())
        || !workload["steps"].as_array().is_some_and(|v| {
            !v.is_empty()
                && v.iter().all(|s| {
                    [
                        "wait",
                        "click",
                        "key",
                        "text",
                        "scroll",
                        "checkpoint",
                        "manual",
                    ]
                    .contains(&s["action"].as_str().unwrap_or(""))
                })
        })
    {
        return Err("Benchmark request does not describe a complete full-product workload".into());
    }
    Ok(Some(BenchmarkRequest {
        data_dir,
        nonce,
        document,
    }))
}
fn write(request: &BenchmarkRequest, name: &str, value: &Value) -> Result<(), String> {
    let temporary = request.data_dir.join(format!(".{name}.tmp"));
    fs::write(
        &temporary,
        serde_json::to_vec(value).map_err(|_| "Benchmark encoding failed")?,
    )
    .map_err(|_| "Benchmark receipt cannot be written")?;
    fs::rename(temporary, request.data_dir.join(name))
        .map_err(|_| "Benchmark receipt cannot be committed".into())
}
fn receipt(
    request: &BenchmarkRequest,
    complete: bool,
    reason: Option<&str>,
    steps: &[Value],
    targets: &[String],
    drain: bool,
) -> Value {
    json!({"schema":1,"product":"varin-desktop-benchmark-receipt","nonce":request.nonce,"shell":"tauri",
        "version":env!("CARGO_PKG_VERSION"),"sourceSha":request.document["sourceSha"],"scenarioSha256":request.document["scenarioSha256"],
        "inputs":request.document["inputs"],"complete":complete,"reason":reason,"steps":steps,"rendererTargets":targets,
        "inputDriver":"chromium-devtools-input","nativeInputVerified":false,"nativeDrain":drain,
        "coverage":["requestAnimationFrame-is-not-display-presentation","event-timing-is-16ms-thresholded","physical-input-and-cross-screen-require-platform-evidence"]})
}
pub fn startup_failed(request: &BenchmarkRequest, error: &str) -> Result<(), String> {
    write(
        request,
        "benchmark-receipt.json",
        &receipt(request, false, Some(error), &[], &[], false),
    )
}
async fn eval(session: &Session, expression: String) -> Result<Value, String> {
    let result = session
        .request(
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
        )
        .await?;
    if result["exceptionDetails"].is_object() || result["result"]["type"] == "undefined" {
        return Err("Fixed product observation failed".into());
    }
    Ok(result["result"]["value"].clone())
}
async fn dispatch(
    session: &Session,
    action: &Value,
    request: &BenchmarkRequest,
) -> Result<(), String> {
    let point = json!({"x":action["x"],"y":action["y"],"button":"left","clickCount":1});
    match action["action"].as_str().unwrap_or("") {
        "file" => {
            let document = session.request("DOM.getDocument", json!({})).await?;
            let node = session
                .request(
                    "DOM.querySelector",
                    json!({"nodeId": document["root"]["nodeId"], "selector":"#upload-input"}),
                )
                .await?;
            if node["nodeId"].as_u64().unwrap_or(0) == 0 {
                return Err("Original fixture file input is unavailable".into());
            }
            let file = request.data_dir.join("benchmark-upload.txt");
            if !file.is_file() {
                return Err("Synthetic upload was not prepared".into());
            }
            session
                .request(
                    "DOM.setFileInputFiles",
                    json!({"nodeId":node["nodeId"],"files":[file]}),
                )
                .await?;
        }
        "click" => {
            for kind in ["mousePressed", "mouseReleased"] {
                let mut p = point.clone();
                p["type"] = json!(kind);
                session.request("Input.dispatchMouseEvent", p).await?;
            }
        }
        "scroll" => {
            session.request("Input.dispatchMouseEvent", json!({"type":"mouseWheel","x":action["x"],"y":action["y"],"deltaX":action["deltaX"],"deltaY":action["deltaY"]})).await?;
        }
        "text" => {
            session
                .request("Input.insertText", json!({"text":action["text"]}))
                .await?;
        }
        "key" => {
            let key = action["key"].as_str().unwrap_or("");
            let code = match key {
                "Enter" => 13,
                "Escape" => 27,
                "Tab" => 9,
                "ArrowDown" => 40,
                "ArrowUp" => 38,
                "ArrowLeft" => 37,
                "ArrowRight" => 39,
                "PageDown" => 34,
                "PageUp" => 33,
                "Home" => 36,
                "End" => 35,
                "Backspace" => 8,
                "Delete" => 46,
                "a" => 65,
                _ => return Err("Unsupported replay key".into()),
            };
            for kind in ["keyDown", "keyUp"] {
                session.request("Input.dispatchKeyEvent", json!({"type":kind,"key":key,"code":if key == "a" { "KeyA" } else { key },"windowsVirtualKeyCode":code,"modifiers":action["modifiers"]})).await?;
            }
        }
        _ => return Err("Unknown replay operation".into()),
    }
    eval(
        session,
        format!(
            "window.__varinDesktopBenchmark.dispatched({})",
            action["id"]
        ),
    )
    .await?;
    Ok(())
}
pub async fn run(app: AppHandle, request: BenchmarkRequest, main: Session) -> bool {
    let mut steps = Vec::new();
    let mut targets = Vec::new();
    let outcome = async {
        let started = Instant::now();
        let deadline = Duration::from_secs_f64((request.document["workload"]["timeoutMs"].as_f64().unwrap() + request.document["workload"]["readyTimeoutMs"].as_f64().unwrap()) / 1000.);
        let interval = Duration::from_secs_f64(request.document["sampleIntervalMs"].as_f64().unwrap() / 1000.);
        while !crate::desktop::smoke_renderer_ready(&app) {
            if started.elapsed() > deadline { return Err("Real application renderer did not become ready".to_string()); }
            tokio::time::sleep(interval).await;
        }
        main.request("Runtime.evaluate", json!({"expression":PAGE})).await?;
        eval(&main, format!("window.__varinDesktopBenchmark.start({})", request.document["workload"])).await?;
        targets.push("application:main".into());
        let mut sequence = 0_u64;
        let mut fixture_label: Option<String> = None; let mut fixture_complete = false;
        let mut remote_label: Option<String> = None; let mut remote_complete = false;
        let mut input_counters: HashMap<String, u64> = HashMap::new(); let mut external_inputs = 0_u64;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(request.data_dir.join("benchmark-renderer.jsonl")).map_err(|_| "Benchmark recording already exists or cannot be created".to_string())?;
        loop {
            if started.elapsed() > deadline { return Err("Workload did not produce its terminal observation".to_string()); }
            let mut samples = Vec::new();
            let mut main_status = String::new(); let mut main_error = None;
            let sessions = crate::desktop::benchmark_sessions(&app).await;
            for (label, session) in sessions {
                let fixture = if label.starts_with("browser:") && request.document["workload"]["browser"].is_object() {
                    eval(&session, format!("location.href === {}", request.document["workload"]["browser"]["url"])).await.unwrap_or(json!(false)) == true
                } else { false };
                // A pending native page may reach the fixture by same-document
                // navigation. Never pre-install a passive observer on that page.
                if label.starts_with("browser:") && request.document["workload"]["browser"].is_object() && !fixture { continue; }
                if fixture {
                    if fixture_label.as_ref().is_some_and(|original| original != &label) { return Err("Original fixture page identity changed or is ambiguous".into()); }
                    fixture_label = Some(label.clone());
                }
                let remote = if label != "application:main" && label.starts_with("application:") && request.document["workload"]["remote"].is_object() {
                    eval(&session, format!("Boolean(window.__VARIN_RUNTIME_APIS__ && window.__VARIN_API_BASE_URL__ && new URL(window.__VARIN_API_BASE_URL__).origin === new URL({}).origin)", request.document["workload"]["remote"]["origin"])).await.unwrap_or(json!(false)) == true
                } else { false };
                if remote {
                    if remote_label.as_ref().is_some_and(|original| original != &label) { return Err("Original remote window identity changed or is ambiguous".into()); }
                    remote_label = Some(label.clone());
                }
                if label != "application:main" && label.starts_with("application:") && request.document["workload"]["remote"].is_object() && !remote { continue; }
                let workload = if label == "application:main" { request.document["workload"].clone() } else if fixture { request.document["workload"]["browser"].clone() } else if remote { request.document["workload"]["remote"].clone() } else { json!({"passive":true}) };
                let installed = eval(&session, "Boolean(window.__varinDesktopBenchmark)".into()).await.unwrap_or(json!(false));
                if installed != true {
                    if label == "application:main" || ((fixture || remote) && targets.contains(&label)) { return Err("The original measured active document ended".to_string()); }
                    session.request("Runtime.evaluate", json!({"expression":PAGE})).await?;
                    eval(&session, format!("window.__varinDesktopBenchmark.start({workload})")).await?;
                }
                if (label == "application:main" || fixture || remote) && eval(&session, format!("window.__varinDesktopBenchmark.matchesWorkload({workload})")).await? != true { return Err("The original active observer workload changed".into()); }
                if !targets.contains(&label) { targets.push(label.clone()); }
                if label == "application:main" {
                    eval(&session, format!("window.__varinDesktopBenchmark.nativeCompletion({fixture_complete})")).await?;
                    eval(&session, format!("window.__varinDesktopBenchmark.remoteCompletion({remote_complete})")).await?;
                }
                if label == "application:main" || remote { eval(&session, "window.__varinDesktopBenchmark.observeOwner()".into()).await?; }
                let observed = eval(&session, "window.__varinDesktopBenchmark.poll()".into()).await;
                let mut value = match observed {
                    Ok(value) => value,
                    Err(_) => { samples.push(json!({"label":label,"status":"document-ended-or-unavailable"})); continue; }
                };
                if label == "application:main" {
                    if let Some(receipts) = value["receipts"].as_array() { steps.extend(receipts.iter().cloned()); }
                    main_status = value["status"].as_str().unwrap_or("").to_owned();
                    main_error = value["error"].as_str().map(str::to_owned);

                } else {
                    let actual = value["trustedInputs"].as_u64().unwrap_or(0);
                    let before = input_counters.insert(label.clone(), actual).unwrap_or(0);
                    external_inputs += if actual >= before { actual - before } else { actual };
                }
                if remote {
                    remote_complete = value["status"] == "completed";
                    if value["status"] == "failed" { return Err("Original remote UI replay failed".into()); }
                    if let Some(receipts) = value["receipts"].as_array() { steps.extend(receipts.iter().cloned()); }
                }
                if fixture {
                    fixture_complete = value["status"] == "completed";
                    if value["status"] == "failed" { return Err("Original native fixture replay failed".into()); }
                    if let Some(receipts) = value["receipts"].as_array() { steps.extend(receipts.iter().cloned()); }
                }
                if (label == "application:main" || fixture || remote) && value["pendingAction"].is_object() { dispatch(&session, &value["pendingAction"], &request).await?; }
                if let Some(object) = value.as_object_mut() { object.remove("pendingAction"); object.insert("surfaceRole".into(), json!(if label == "application:main" { "main-workbench" } else if remote { "remote-workbench" } else if fixture { "native-browser" } else { "passive" })); object.insert("label".into(), json!(label)); }
                samples.push(value);
            }
            eval(&main, format!("window.__varinDesktopBenchmark.externalInputs({external_inputs})")).await?;
            let record = json!({"schema":1,"nonce":request.nonce,"sequence":sequence,"elapsedMs":started.elapsed().as_secs_f64()*1000.,"targets":samples});
            serde_json::to_writer(&mut output, &record).map_err(|_| "Renderer recording failed")?;
            output.write_all(b"\n").map_err(|_| "Renderer recording failed")?;
            write(&request, "benchmark-live.json", &record)?;
            sequence += 1;
            if main_status == "completed" {
                if request.document["workload"]["browser"].is_object() && !fixture_complete { return Err("Original native fixture did not complete".into()); }
                if request.document["workload"]["remote"].is_object() && !remote_complete { return Err("Original remote UI replay did not complete".into()); }
                return Ok(());
            }
            if main_status == "failed" { return Err(main_error.unwrap_or_else(|| "Workload failed".into())); }
            tokio::time::sleep(interval).await;
        }
    }.await;
    // Disconnect passive observers on every still-live original surface before
    // the product owner drains windows and sessions, including failure paths.
    for (_, session) in crate::desktop::benchmark_sessions(&app).await {
        let _ = eval(&session, "window.__varinDesktopBenchmark?.stop()".into()).await;
    }
    let drained = crate::desktop::smoke_shutdown(&app).await.is_ok();
    let complete = outcome.is_ok() && drained;
    let reason = outcome
        .err()
        .or_else(|| (!drained).then(|| "Native owner drain did not complete".into()));
    let saved = write(
        &request,
        "benchmark-receipt.json",
        &receipt(
            &request,
            complete,
            reason.as_deref(),
            &steps,
            &targets,
            drained,
        ),
    )
    .is_ok();
    complete && saved
}
