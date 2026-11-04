//! Native desktop authority. Only registered application webviews may invoke it;
//! target selection and secrets belong to each window, never to a global renderer.
use crate::{
    host::{HostPhase, HostProcess},
    manifest::{RuntimePaths, architecture, platform},
    settings,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{
    AppHandle, Emitter, Manager, State, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_runtime_cef::{WebviewCefExt, WebviewWindowBuilderCefExt};
use tokio::sync::watch;

type Reply = Result<Value, String>;
type WindowRecord =
    crate::window_registry::WindowRecord<crate::lifecycle::CloseReceipt, crate::cdp::Session>;

struct DesktopState {
    runtime: OnceLock<Result<RuntimePaths, String>>,
    settings: settings::Owner,
    lease: OnceLock<crate::desktop_lock::Lease>,
    data_dir: PathBuf,
    smoke: Option<crate::smoke::SmokeRequest>,
    benchmark: Option<crate::benchmark::BenchmarkRequest>,
    background: Mutex<Option<Value>>,
    mini_create: tokio::sync::Mutex<()>,
    deep_links: tokio::sync::mpsc::Sender<String>,
    activation_restores: crate::preengine_activation::RestoreIntents,
    boot: watch::Sender<Option<Reply>>,
    windows: Mutex<HashMap<String, WindowRecord>>,
    draft_transfers: Mutex<crate::draft_transfer::Broker>,
    host: tokio::sync::Mutex<Option<HostProcess>>,
    services: tokio::sync::Mutex<Vec<crate::service::NativeService>>,
    browser_start: tokio::sync::Mutex<()>,
    focus_update: tokio::sync::Mutex<()>,
    exit_ready: AtomicBool,
    preferences: Mutex<Value>,
    startup_theme: OnceLock<Value>,
    admission: crate::desktop_admission::Owner,
    sequence: AtomicU64,
    quitting: AtomicBool,
    started_enabled: AtomicBool,
    restarting: AtomicBool,
    geometry: watch::Sender<Option<Value>>,
    geometry_ready: AtomicBool,
}
impl DesktopState {
    fn runtime(&self) -> Result<&RuntimePaths, String> {
        self.runtime
            .get()
            .ok_or("Desktop runtime is still preparing")?
            .as_ref()
            .map_err(Clone::clone)
    }
    async fn context(&self) -> Value {
        let host = self.host.lock().await;
        json!({"recoveryUiAvailable":true,"startedEnabled":self.started_enabled.load(Ordering::Relaxed),
            "runtime":if host.as_ref().is_some_and(|h| matches!(h.snapshot().phase,HostPhase::Ready)) {"embedded"} else {"stopped"}})
    }
    async fn setting(&self, method: &str, args: Value) -> Reply {
        self.settings
            .call(
                self.runtime()?,
                &self.data_dir,
                method,
                args,
                self.context().await,
            )
            .await
    }
    fn authorize(&self, webview: &Webview) -> Result<(), String> {
        let url = webview
            .url()
            .map_err(|_| "Native caller URL is unavailable")?;
        let windows = self
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        crate::window_registry::authorize(&windows, webview.label(), &url).map(|_| ())
    }
    async fn bootstrap(&self, label: &str) -> Reply {
        let mut prepared = self
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?
            .get(label)
            .ok_or("Window is not registered")?
            .native_ready
            .subscribe();
        let vibrancy = loop {
            if let Some(result) = prepared.borrow_and_update().clone() {
                break result?;
            }
            prepared
                .changed()
                .await
                .map_err(|_| "Native window preparation ended")?;
        };
        let saved = {
            self.windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .get(label)
                .and_then(|w| w.bootstrap.clone())
        };
        if let Some(mut value) = saved {
            value["macVibrancy"] = json!(vibrancy);
            if let Some(record) = self
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .get(label)
            {
                value["documentNonce"] = json!(record.document_nonce);
            }
            return Ok(value);
        }
        let mut ready = self.boot.subscribe();
        loop {
            if let Some(result) = ready.borrow_and_update().clone() {
                let mut value = result?;
                value["macVibrancy"] = json!(vibrancy);
                let mut windows = self
                    .windows
                    .lock()
                    .map_err(|_| "Window registry unavailable")?;
                let record = windows
                    .get_mut(label)
                    .ok_or("Window was closed during initialization")?;
                value["documentNonce"] = json!(record.document_nonce);
                record.bootstrap = Some(value.clone());
                return Ok(value);
            }
            ready
                .changed()
                .await
                .map_err(|_| "Desktop initialization ended")?;
        }
    }
}

fn external_url(value: &Value) -> Result<url::Url, String> {
    let url =
        url::Url::parse(value.as_str().ok_or("URL is required")?).map_err(|_| "Invalid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) URLs without embedded credentials are supported".into());
    }
    Ok(url)
}
fn string(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("{key} is required"))
}
fn boolean(args: &Value, key: &str) -> Result<bool, String> {
    args[key]
        .as_bool()
        .ok_or_else(|| format!("{key} must be boolean"))
}
fn native<T>(result: tauri::Result<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}
pub(crate) fn emit(app: &AppHandle, label: &str, event: &str, detail: Value) {
    let _ = app.emit_to(
        tauri::EventTarget::webview_window(label),
        "varin:emit",
        json!({"event":event,"detail":detail}),
    );
}

fn create_window(
    app: &AppHandle,
    label: &str,
    role: &str,
    bootstrap: Option<Value>,
    query: Option<&str>,
) -> Result<(), String> {
    // Hold through native construction and registry publication, not the
    // asynchronously prepared renderer/native-ready callbacks.
    let _admission = app.state::<DesktopState>().admission.enter()?;
    let bootstrap = bootstrap.map(|mut value| {
        value["windowRole"] = json!(role);
        value
    });
    let path = if role == "mini-chat" {
        "mini-chat.html"
    } else {
        "index.html"
    };
    let target = if let Some(query) = query {
        format!("{path}?{query}")
    } else {
        path.into()
    };
    let show = label != "main" || app.state::<DesktopState>().boot.borrow().is_some();
    let popup_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(target.into()))
        .title(if role == "mini-chat" {
            crate::native_presentation::text(
                &app.state::<crate::native_menu::NativeMenus>().locale(),
                "Varin Mini Chat",
            )
        } else {
            "Varin".into()
        })
        .inner_size(
            if role == "mini-chat" { 520. } else { 1280. },
            if role == "mini-chat" { 760. } else { 800. },
        )
        .data_directory(app.state::<DesktopState>().data_dir.join("cef/application"))
        .min_inner_size(
            if role == "mini-chat" { 360. } else { 800. },
            if role == "mini-chat" { 480. } else { 520. },
        )
        .decorations(cfg!(target_os = "macos"))
        .visible(false)
        .initialization_script(crate::startup_theme::initialization_script(
            app.state::<DesktopState>().startup_theme.get().unwrap_or(&Value::Null),
        ))
        .theme(match app.state::<DesktopState>().startup_theme.get().and_then(|theme| theme["mode"].as_str()) {
            Some("light") => Some(tauri::Theme::Light),
            Some("dark") => Some(tauri::Theme::Dark),
            _ => None,
        })
        .on_new_window(move |url, _| {
            if external_url(&json!(url.as_str())).is_ok() {
                let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .on_navigation(|url| {
            // No remote document is loaded in a privileged application webview.
            // Browser Use has separate, unregistered webviews and contexts.
            crate::security::application_origin(url)
        });
    let frame_app = app.clone();
    let frame_label = label.to_owned();
    builder = builder.on_frame_event(move |event| {
        use tauri_runtime_cef::FrameEventKind;
        if event.is_main
            && matches!(
                event.kind,
                FrameEventKind::DocumentCommitted { .. } | FrameEventKind::RendererTerminated
            )
        {
            if let Ok(mut windows) = frame_app.state::<DesktopState>().windows.lock() {
                if let Some(record) = windows.get_mut(&frame_label) {
                    if let Ok(mut transfers) =
                        frame_app.state::<DesktopState>().draft_transfers.lock()
                    {
                        transfers.window_ended(&frame_label, true);
                    }
                    record.renderer_ready = false;
                    record.document_nonce = uuid::Uuid::new_v4().to_string();
                    if let Some(cdp) = &record.cdp {
                        cdp.document_ended();
                    }
                }
            }
        }
    });
    builder = crate::engine::macos_chrome::configure(builder, label)?;
    let close = crate::lifecycle::attach(&mut builder, app, label)?;
    let prepare_now = bootstrap.is_some() || app.state::<DesktopState>().boot.borrow().is_some();
    let (native_ready, _) = watch::channel(None);
    // CEF builds an internal placeholder before its asynchronous real navigation.
    // Register the native-selected bundled origin, never the transient frame URL.
    app.state::<DesktopState>()
        .windows
        .lock()
        .map_err(|_| "Window registry unavailable")?
        .insert(
            label.into(),
            WindowRecord {
                mini_thread: if role == "mini-chat" {
                    let q: HashMap<_, _> =
                        url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
                            .into_owned()
                            .collect();
                    q.get("threadId")
                        .zip(q.get("branchId"))
                        .map(|(thread, branch)| (thread.clone(), branch.clone()))
                } else {
                    None
                },
                document_nonce: uuid::Uuid::new_v4().to_string(),
                renderer_ready: false,
                navigation: Vec::new(),
                native_ready: native_ready.clone(),
                origin: application_origin(),
                bootstrap,
                close: Some(close.clone()),
                cdp: None,
            },
        );
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            unregister_application_window(app, label);
            return Err(error.to_string());
        }
    };
    app.state::<crate::native_menu::NativeMenus>()
        .attach_window(&window)?;
    // The bundled app talks to its authenticated Host on 127.0.0.1. CEF treats
    // that as a loopback permission even though both ends belong to this app.
    // Scope it to the bundled origin in the application profile.
    window.with_cef_webview(|view| {
        use tauri_runtime_cef::cef::{
            CefString, ContentSettingTypes, ContentSettingValues, ImplBrowser, ImplBrowserHost,
            ImplRequestContext,
        };
        if let Some(context) = view.browser().host().and_then(|host| host.request_context()) {
            let origin = CefString::from(application_origin().as_str());
            context.set_content_setting(
                Some(&origin),
                None,
                ContentSettingTypes::LOOPBACK_NETWORK,
                ContentSettingValues::ALLOW,
            );
        }
    }).map_err(|_| "Application loopback permission could not be configured")?;
    if prepare_now {
        let enabled = app
            .state::<DesktopState>()
            .preferences
            .lock()
            .is_ok_and(|p| p["desktopVibrancy"] != false);
        let view = window.clone();
        tauri::async_runtime::spawn(async move {
            native_ready.send_replace(Some(
                crate::engine::macos_chrome::apply(&view, enabled).await,
            ));
        });
    }
    let cdp = crate::cdp::Session::attach(window.as_ref().clone(), close.clone())?;
    if let Some(record) = app
        .state::<DesktopState>()
        .windows
        .lock()
        .map_err(|_| "Window registry unavailable")?
        .get_mut(label)
    {
        record.cdp = Some(cdp);
    }
    let app_handle = app.clone();
    let event_label = label.to_owned();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            crate::engine::macos_chrome::window_event(&event_label, false);
            remember_window_geometry(&app_handle, &event_label);
            emit(
                &app_handle,
                &event_label,
                "varin:window-resized",
                Value::Null,
            );
            if let Some(window) = app_handle.get_webview_window(&event_label) {
                if let Ok(maximized) = window.is_maximized() {
                    emit(
                        &app_handle,
                        &event_label,
                        "varin:window-maximized-changed",
                        json!({"maximized":maximized}),
                    );
                }
            }
        }
        WindowEvent::Moved(_) => remember_window_geometry(&app_handle, &event_label),
        WindowEvent::CloseRequested { api, .. } => {
            remember_window_geometry(&app_handle, &event_label);
            let state = app_handle.state::<DesktopState>();
            let close = state
                .windows
                .lock()
                .ok()
                .and_then(|w| w.get(&event_label).and_then(|w| w.close.clone()));
            if close.as_ref().is_some_and(|c| c.closed()) {
                return;
            }
            api.prevent_close();
            let tray = app_handle
                .state::<crate::native_menu::NativeMenus>()
                .tray_enabled()
                && state
                    .preferences
                    .lock()
                    .ok()
                    .and_then(|p| p["desktopMinimizeToTrayEnabled"].as_bool())
                    .unwrap_or(false);
            let visible = app_handle
                .webview_windows()
                .values()
                .filter(|window| {
                    is_application_window(&app_handle, window.label())
                        && window.is_visible().unwrap_or(false)
                })
                .count();
            let background = app_handle
                .state::<crate::native_menu::NativeMenus>()
                .tray_enabled()
                && state.background.lock().is_ok_and(|value| value.is_some());
            if !state.quitting.load(Ordering::SeqCst)
                && ((tray && (event_label == "main" || event_label.starts_with("workbench-")))
                    || (cfg!(target_os = "macos") && visible <= 1))
            {
                if let Some(window) = app_handle.get_webview_window(&event_label) {
                    let _ = window.hide();
                }
            } else if !background
                && !cfg!(target_os = "macos")
                && !state.quitting.load(Ordering::Acquire)
                && state.windows.lock().is_ok_and(|windows| {
                    windows.values().filter(|w| w.close.is_some()).count() == 1
                })
            {
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if drain(&handle).await.is_ok() {
                        handle.exit(0);
                    }
                });
            } else if let (Some(close), Some(view)) = (close, app_handle.get_webview(&event_label))
            {
                let handle = app_handle.clone();
                let label = event_label.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = close_workbench_window(&handle, &label, &close, &view).await;
                });
            }
        }
        WindowEvent::Focused(focused) => {
            if *focused {
                app_handle
                    .state::<crate::native_menu::NativeMenus>()
                    .focus_window(&app_handle, &event_label);
            }
            crate::engine::macos_chrome::window_event(&event_label, false);
            refresh_desktop_state(&app_handle);
        }
        WindowEvent::Destroyed => {
            app_handle
                .state::<crate::native_menu::NativeMenus>()
                .remove_window(&app_handle, &event_label);
            crate::engine::macos_chrome::window_event(&event_label, true);
            if let Ok(mut windows) = app_handle.state::<DesktopState>().windows.lock() {
                windows.remove(&event_label);
            }
            refresh_desktop_state(&app_handle);
        }
        _ => {}
    });
    // New windows must inherit every active Computer Use capture lease before
    // their first visible pixels, not through a later queued refresh event.
    let prepared = crate::computer::protect_new_windows(app).and_then(|_| {
        if show {
            native(window.show())
        } else {
            Ok(())
        }
    });
    if let Err(error) = prepared {
        let view = window.as_ref().clone();
        tauri::async_runtime::spawn(async move {
            // Keep the registered original until actual CEF/native destruction.
            if let Err(error) = close.request(&view).await {
                eprintln!("Hidden window cleanup is unconfirmed: {error}");
            }
        });
        return Err(error);
    }
    refresh_desktop_state(app);
    Ok(())
}

async fn initialize(app: AppHandle, root: PathBuf) {
    let checked = tauri::async_runtime::spawn_blocking(move || {
        RuntimePaths::open(&root).map_err(|e| e.to_string())
    })
    .await;
    let state = app.state::<DesktopState>();
    let runtime =
        checked.unwrap_or_else(|_| Err("Desktop runtime verification could not finish".into()));
    let _ = state.runtime.set(runtime);
    let result: Reply = async {
        let (migration, snapshot) = {
            let admission = state.admission.enter()?;
            let lease=state.lease.get().ok_or("Desktop data lease is unavailable")?;lease.verify()?;
            let migration=crate::legacy_migration::prepare(&app,state.runtime()?,&state.settings,&state.data_dir,lease,&admission).await?;
            let snapshot = state.setting("snapshot", json!({})).await?;
            (migration, snapshot)
        };
        *state.preferences.lock().map_err(|_| "Preferences unavailable")? = snapshot["preferences"].clone();
        let _ = state.startup_theme.set(snapshot["startupTheme"].clone());
        // The old native settings are available before this document is built.
        // Hand off only splash presentation before its blocking prepaint script;
        // Host readiness and the sole frontend migration import still happen later.
        create_window(&app, "main", "main", None, None)?;
        let mut mac_vibrancy=false;
        if let Some(window)=app.get_webview_window("main"){
            let applied=crate::engine::macos_chrome::apply(&window,snapshot["preferences"]["desktopVibrancy"]!=false).await;
            if let Some(record)=state.windows.lock().map_err(|_|"Window registry unavailable")?.get("main"){record.native_ready.send_replace(Some(applied.clone()));}
            mac_vibrancy=applied?;
        }
        let enabled = snapshot["localHostMode"]["effectiveEnabled"].as_bool().ok_or("Local startup preference is invalid")?;
        {
            // Native preparation above may outlive a Quit. Re-enter before creating
            // menus, power leases or showing any registered window.
            let _presentation = state.admission.enter()?;
            if let Some(window)=app.get_webview_window("main") {
                let _=crate::window_geometry::restore(&app,&window,&snapshot["windowState"]);
                state.geometry_ready.store(true,Ordering::Release);
            }
            state.started_enabled.store(enabled, Ordering::Relaxed);
            app.state::<crate::native_menu::NativeMenus>().install(&app,snapshot["locale"].as_str().unwrap_or("en"))?;
            if app.state::<crate::native_menu::NativeMenus>().tray(&app,if cfg!(target_os="macos"){snapshot["preferences"]["desktopMacMenuBarEnabled"]!=false}else{true}).is_err(){eprintln!("Varin system tray is unavailable; the application window remains accessible");}
            state.activation_restores.ready()?;
            dispatch_activation_restore(&app)?;
            if let Some(window)=app.get_webview_window("main"){
                let background=std::env::args().any(|argument|argument=="--background");
                let reachable=cfg!(target_os="macos")||app.state::<crate::native_menu::NativeMenus>().tray_enabled();
                if !background||!reachable{native(window.show())?;}
            }
            if snapshot["preferences"]["desktopKeepAwakeEnabled"]==true {
                if app.state::<crate::power::PowerManager>().set(&app,true).await.is_err(){eprintln!("Varin sleep inhibitor could not be enabled; application startup continues");}
            }
        }
        let mut local_origin = String::new(); let mut local_token = String::new();
        if enabled {
            let host = {
                let _admission = state.admission.enter()?;
                let host = HostProcess::spawn(state.runtime()?, &state.data_dir)?;
                let service=crate::service::NativeService::attach(app.clone(),host.clone(),state.data_dir.clone()).await?;
                state.services.lock().await.push(service);
                *state.host.lock().await = Some(host.clone());
                host
            };
            match host.ready().await {
                Ok(ready) => { local_origin = ready.origin.unwrap_or_default(); local_token = ready.client_token.unwrap_or_default(); }
                Err(_) => { /* Retain selected local identity and show recovery below. */ }
            }
        }
        let config = &snapshot["hosts"];
        let forced = std::env::var("VARIN_SERVER_URL").ok().filter(|s| !s.trim().is_empty());
        let selected_id = config["defaultHostId"].as_str().unwrap_or("local");
        let selected = config["hosts"].as_array().and_then(|hosts| hosts.iter().find(|h| h["id"] == selected_id));
        let mut api_url = local_origin.clone(); let mut token = local_token; let mut headers = json!({}); let mut relay = String::new();
        let mut outcome;
        if let Some(url) = forced {
            let parsed = external_url(&json!(url))?; api_url = parsed.to_string();
            token = String::new();
            if let Some(host) = config["hosts"].as_array().and_then(|hosts| hosts.iter().find(|h|h["apiUrl"] == api_url || h["url"] == api_url)) {
                token = host["clientToken"].as_str().unwrap_or("").into(); headers = host["requestHeaders"].as_object().map(|h|json!(h)).unwrap_or(json!({}));
            }
            outcome = json!({"target":"remote","status":"ok","hostId":"environment","url":api_url,"localAvailable":!local_origin.is_empty()});
        } else if config["initialHostChoiceCompleted"] != true {
            outcome = json!({"target":null,"status":"not-configured","localAvailable":!local_origin.is_empty()});
        } else if selected_id == "local" {
            outcome = json!({"target":"local","status":if local_origin.is_empty(){"unreachable"}else{"ok"},"localAvailable":!local_origin.is_empty()});
        } else if let Some(host) = selected {
            api_url = host["apiUrl"].as_str().or_else(||host["url"].as_str()).unwrap_or("").into();
            token = host["clientToken"].as_str().unwrap_or("").into();
            headers = host["requestHeaders"].as_object().map(|h|json!(h)).unwrap_or(json!({}));
            if host["relay"].is_object() { relay = selected_id.to_owned(); api_url = String::new(); }
            outcome = json!({"target":"remote","status":"ok","hostId":selected_id,"url":host["url"],"localAvailable":!local_origin.is_empty()});
        } else {
            api_url = String::new(); token = String::new();
            outcome = json!({"target":"remote","status":"missing","hostId":selected_id,"localAvailable":!local_origin.is_empty()});
        }
        if outcome["target"]=="remote" && outcome["status"]=="ok" && relay.is_empty() && !api_url.is_empty(){
            let probe=match browser_service(&app).await {
                Ok(service)=>service.process.request("desktopPlatformInvoke",json!({"command":"desktop_host_probe","args":{"url":api_url,"clientToken":token,"requestHeaders":headers,"timeoutMs":2000}})).await,
                Err(error)=>Err(error)
            };
            outcome["status"]=json!(match probe.as_ref().ok().and_then(|value|value["status"].as_str()){
                Some("wrong-service")=>"wrong-service",Some("incompatible")=>"incompatible",Some("ok"|"auth"|"update-recommended")=>"ok",_=>"unreachable"
            });
        }
        Ok(json!({"version":1,"runtime":"tauri","platform":platform(),"arch":architecture(),"windowRole":"main","localPage":true,
            "localOrigin":local_origin,"apiBaseUrl":api_url,"clientToken":token,"requestHeaders":headers,"relayHostId":relay,
            "homeDirectory":snapshot["homeDirectory"],"macosMajor":crate::engine::macos_chrome::macos_major(),"macVibrancy":mac_vibrancy,
            "trayEnabled":app.state::<crate::native_menu::NativeMenus>().tray_enabled(),"locale":snapshot["locale"],"bootOutcome":outcome,"migration":migration}))
    }.await;
    let ready = result.is_ok();
    if let Ok(value) = &result {
        if value["bootOutcome"]["target"] == "remote" {
            if let Ok(mut background) = state.background.lock() {
                *background = Some(value.clone());
            }
        }
    }
    if !ready {
        // Recovery is a new resource admission, while failure settlement below
        // must still unblock existing documents when Quit already closed it.
        if let Ok(_recovery) = state.admission.enter() {
            if app.get_webview_window("main").is_none()
                && create_window(&app, "main", "main", None, None).is_err()
            {
                eprintln!("Varin startup recovery window could not be created");
            }
            let _ = state.activation_restores.ready();
            let _ = dispatch_activation_restore(&app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
        }
        if let Ok(windows) = state.windows.lock() {
            for window in windows.values() {
                if window.native_ready.borrow().is_none() {
                    window.native_ready.send_replace(Some(Err(result
                        .as_ref()
                        .err()
                        .cloned()
                        .unwrap_or_else(|| {
                            "Desktop initialization failed before native window preparation".into()
                        }))));
                }
            }
        }
    }
    state.boot.send_replace(Some(result.clone()));
    if !ready && !state.quitting.load(Ordering::Acquire) && app.get_webview_window("main").is_none() {
        // Native window creation itself failed; there is no surface to recover.
        // Use the existing guarded shutdown instead of remaining invisibly alive.
        app.exit(1);
    }
    refresh_desktop_state(&app);
    if let Some(request) = state.benchmark.clone() {
        let app = app.clone();
        let result = result.clone();
        tauri::async_runtime::spawn(async move {
            let passed = match result {
                Ok(_) => match smoke_main_session(&app) {
                    Ok(main) => crate::benchmark::run(app.clone(), request.clone(), main).await,
                    Err(error) => {
                        let _ = crate::benchmark::startup_failed(&request, &error);
                        false
                    }
                },
                Err(error) => {
                    let _ = crate::benchmark::startup_failed(&request, &error);
                    false
                }
            };
            if !app
                .state::<DesktopState>()
                .exit_ready
                .load(Ordering::Acquire)
            {
                let _ = drain(&app).await;
            }
            if app
                .state::<DesktopState>()
                .exit_ready
                .load(Ordering::Acquire)
            {
                app.exit(if passed { 0 } else { 1 });
            }
        });
    }
    if let Some(request) = state.smoke.clone() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let passed = match result {
                Ok(bootstrap) => match smoke_main_session(&app) {
                    Ok(main) => {
                        crate::smoke::run(app.clone(), request.clone(), main, bootstrap).await
                    }
                    Err(error) => {
                        let _ = crate::smoke::startup_failed(&request, &error);
                        false
                    }
                },
                Err(error) => {
                    let _ = crate::smoke::startup_failed(&request, &error);
                    false
                }
            };
            // A failed test does not grant permission to abandon native owners.
            if !app
                .state::<DesktopState>()
                .exit_ready
                .load(Ordering::Acquire)
            {
                let _ = drain(&app).await;
            }
            if app
                .state::<DesktopState>()
                .exit_ready
                .load(Ordering::Acquire)
            {
                app.exit(if passed { 0 } else { 1 });
            }
        });
    }
    if ready
        && state
            .preferences
            .lock()
            .is_ok_and(|p| p["desktopCompanionEnabled"] == true)
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(service) = browser_service(&app).await {
                if service.process.request("companionInvoke",json!({"command":"desktop_set_companion","args":{"enabled":true},"windowLabel":"main"})).await.is_err(){
                    emit(&app,"main","varin:companion-library-changed",Value::Null);
                }
            }
        });
    }
}

#[tauri::command]
async fn varin_bootstrap(webview: Webview, state: State<'_, DesktopState>) -> Reply {
    state.authorize(&webview)?;
    let mut bootstrap = state.bootstrap(webview.label()).await?;
    // All workbenches share the main presentation role, but only this native
    // identity owns the one-time import into their shared application origin.
    bootstrap["frontendMigrationOwner"] = json!(webview.label() == "main");
    Ok(bootstrap)
}
#[tauri::command]
async fn varin_invoke(
    app: AppHandle,
    webview: Webview,
    state: State<'_, DesktopState>,
    command: String,
    args: Value,
) -> Reply {
    state.authorize(&webview)?;
    let window = app
        .get_webview_window(webview.label())
        .ok_or("Window is unavailable")?;
    match command.as_str() {
        "desktop_start_window_drag" => {
            native(window.start_dragging())?;
            Ok(Value::Null)
        }
        "desktop_set_window_title" => {
            native(window.set_title(&string(&args, "title")?))?;
            Ok(Value::Null)
        }
        "desktop_is_window_fullscreen" => Ok(json!(native(window.is_fullscreen())?)),
        "desktop_minimize_current_window" => {
            native(window.minimize())?;
            Ok(Value::Null)
        }
        "desktop_toggle_current_window_maximized" => {
            if native(window.is_maximized())? {
                native(window.unmaximize())?;
            } else {
                native(window.maximize())?;
            }
            Ok(json!({"maximized":native(window.is_maximized())?}))
        }
        "desktop_get_current_window_state" => {
            Ok(json!({"maximized":native(window.is_maximized())?}))
        }
        "desktop_close_current_window" => {
            native(window.close())?;
            Ok(Value::Null)
        }
        "desktop_get_window_pinned" | "desktop_set_window_pinned"
            if webview.label().starts_with("companion-") =>
        {
            let process = crate::companion::process_for_window(&app, webview.label()).await?;
            process
                .request(
                    "companionInvoke",
                    json!({
                        "command": command, "args": args, "windowLabel": webview.label()
                    }),
                )
                .await
        }
        "desktop_get_window_pinned" => Ok(json!({"pinned":native(window.is_always_on_top())?})),
        "desktop_set_window_pinned" => {
            let pinned = boolean(&args, "pinned")?;
            native(window.set_always_on_top(pinned))?;
            Ok(json!({"pinned":pinned}))
        }
        "desktop_set_vibrancy" => {
            let enabled = boolean(&args, "enabled")?;
            if !cfg!(target_os = "macos") {
                return Ok(json!({"supported":false,"enabled":false}));
            }
            state
                .setting(
                    "setPreference",
                    json!({"key":"desktopVibrancy","enabled":enabled}),
                )
                .await?;
            state
                .preferences
                .lock()
                .map_err(|_| "Preferences unavailable")?["desktopVibrancy"] = json!(enabled);
            // Renderer chrome is bootstrapped once. Preserve Save and Restart:
            // do not change native backing while React still sees the old mode.
            // A cancelled/failed drain rejects the call, so the UI can retry.
            drain(&app).await?;
            app.request_restart();
            Ok(json!({"supported":true,"enabled":enabled,"requiresRestart":true}))
        }
        "desktop_set_window_theme" => {
            let theme = match args["themeMode"].as_str() {
                Some("dark") => Some(tauri::Theme::Dark),
                Some("light") => Some(tauri::Theme::Light),
                _ => None,
            };
            native(window.set_theme(theme))?;
            Ok(Value::Null)
        }
        "desktop_show_app_menu" => {
            app.state::<crate::native_menu::NativeMenus>()
                .popup(&window, &args)?;
            Ok(Value::Null)
        }
        "desktop_tray_update" => {
            let bootstrap = state.bootstrap(webview.label()).await?;
            app.state::<crate::native_menu::NativeMenus>().update_tray(
                &app,
                webview.label(),
                &args,
                &bootstrap,
            )?;
            Ok(Value::Null)
        }
        "desktop_get_app_version" => Ok(json!(app.package_info().version.to_string())),
        "desktop_get_launch_at_login" => Ok(
            json!({"supported":true,"enabled":app.autostart().is_enabled().map_err(|e|e.to_string())?}),
        ),
        "desktop_set_launch_at_login" => {
            let enabled = boolean(&args, "enabled")?;
            if enabled {
                app.autostart().enable()
            } else {
                app.autostart().disable()
            }
            .map_err(|e| e.to_string())?;
            Ok(
                json!({"supported":true,"enabled":app.autostart().is_enabled().map_err(|e|e.to_string())?}),
            )
        }
        "desktop_hosts_get" => {
            let bootstrap = state.bootstrap(webview.label()).await?;
            state
                .setting(&command, json!({"localOrigin":bootstrap["localOrigin"]}))
                .await
        }
        "desktop_hosts_set"
        | "desktop_install_id_get"
        | "desktop_local_client_token_get"
        | "desktop_get_local_host_mode"
        | "desktop_set_local_host_mode" => state.setting(&command, args).await,
        "desktop_set_locale" => {
            let locale = state.setting(&command, args).await?;
            app.state::<crate::native_menu::NativeMenus>()
                .install(&app, locale.as_str().unwrap_or("en"))?;
            for service in state.services.lock().await.iter() {
                service
                    .computer
                    .set_locale(locale.as_str().unwrap_or("en"))?;
            }
            let labels: Vec<_> = state
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .keys()
                .cloned()
                .collect();
            for label in labels {
                emit(
                    &app,
                    &label,
                    "varin:locale-changed",
                    json!({"locale":locale}),
                );
            }
            Ok(locale)
        }
        "desktop_get_keep_awake" => {
            let enabled = state
                .preferences
                .lock()
                .map_err(|_| "Preferences unavailable")?["desktopKeepAwakeEnabled"]
                == true;
            Ok(app
                .state::<crate::power::PowerManager>()
                .status(enabled)
                .await)
        }
        "desktop_set_keep_awake" => {
            let enabled = boolean(&args, "enabled")?;
            app.state::<crate::power::PowerManager>()
                .set(&app, enabled)
                .await?;
            state
                .setting(
                    "setPreference",
                    json!({"key":"desktopKeepAwakeEnabled","enabled":enabled}),
                )
                .await?;
            state
                .preferences
                .lock()
                .map_err(|_| "Preferences unavailable")?["desktopKeepAwakeEnabled"] =
                json!(enabled);
            Ok(app
                .state::<crate::power::PowerManager>()
                .status(enabled)
                .await)
        }
        "desktop_get_minimize_to_tray" => Ok(
            json!({"supported":!cfg!(target_os="macos"),"enabled":state.preferences.lock().map_err(|_|"Preferences unavailable")?["desktopMinimizeToTrayEnabled"] == true}),
        ),
        "desktop_set_minimize_to_tray" => {
            let enabled = boolean(&args, "enabled")?;
            state
                .setting(
                    "setPreference",
                    json!({"key":"desktopMinimizeToTrayEnabled","enabled":enabled}),
                )
                .await?;
            state
                .preferences
                .lock()
                .map_err(|_| "Preferences unavailable")?["desktopMinimizeToTrayEnabled"] =
                json!(enabled);
            Ok(json!({"supported":!cfg!(target_os="macos"),"enabled":enabled}))
        }
        "desktop_browser_capture_page" => {
            let id = args["webContentsId"]
                .as_i64()
                .and_then(|id| i32::try_from(id).ok())
                .filter(|id| *id >= 0)
                .ok_or("Native browser identity is required")?;
            browser_service(&app)
                .await?
                .browser
                .capture_legacy(id, webview.label())
                .await
        }
        "desktop_capture_page_rect" => {
            let session = state
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .get(webview.label())
                .and_then(|w| w.cdp.clone())
                .ok_or("Window capture owner unavailable")?;
            let size =
                native(window.inner_size())?.to_logical::<f64>(native(window.scale_factor())?);
            let x = args["x"]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(0.)
                .floor()
                .max(0.)
                .min((size.width - 1.).max(0.));
            let y = args["y"]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(0.)
                .floor()
                .max(0.)
                .min((size.height - 1.).max(0.));
            let width = args["width"]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(1.)
                .floor()
                .max(1.)
                .min((size.width - x).max(1.));
            let height = args["height"]
                .as_f64()
                .filter(|v| v.is_finite())
                .unwrap_or(1.)
                .floor()
                .max(1.)
                .min((size.height - y).max(1.));
            if width * height > 4_000_000. {
                return Err("Capture area is too large".into());
            }
            let result=session.request("Page.captureScreenshot",json!({"format":"jpeg","quality":82,"fromSurface":true,"captureBeyondViewport":false,"clip":{"x":x,"y":y,"width":width,"height":height,"scale":1}})).await?;
            Ok(json!({"mime":"image/jpeg","base64":result["data"],"width":width,"height":height}))
        }
        "desktop_clear_cache" => {
            let session = state
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .get(webview.label())
                .and_then(|w| w.cdp.clone())
                .ok_or("Window cache owner unavailable")?;
            let origin = native(webview.url())?.origin().ascii_serialization();
            session
                .request(
                    "Storage.clearDataForOrigin",
                    json!({"origin":origin,"storageTypes":"all"}),
                )
                .await?;
            session
                .request("Network.clearBrowserCache", json!({}))
                .await?;
            let labels: Vec<_> = state
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .keys()
                .cloned()
                .collect();
            for label in labels {
                if let Some(view) = app.get_webview(&label) {
                    native(view.reload())?;
                }
            }
            Ok(Value::Null)
        }
        "desktop_host_probe"
        | "desktop_remote_password_login"
        | "desktop_open_in_app"
        | "desktop_open_file_in_app"
        | "desktop_filter_installed_apps"
        | "desktop_fetch_app_icons"
        | "desktop_get_installed_apps" => {
            let service = browser_service(&app).await?;
            service
                .process
                .request(
                    "desktopPlatformInvoke",
                    json!({"command":command,"args":args}),
                )
                .await
        }
        "desktop_read_file" => {
            let path = PathBuf::from(string(&args, "path")?);
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from)
                .ok_or("Home directory unavailable")?;
            let (bytes, mime) = tauri::async_runtime::spawn_blocking(move || {
                crate::files::read(&path, &home, &std::env::temp_dir())
            })
            .await
            .map_err(|_| "File reader did not finish")??;
            use base64::Engine;
            Ok(
                json!({"mime":mime,"base64":base64::engine::general_purpose::STANDARD.encode(&bytes),"size":bytes.len()}),
            )
        }
        "desktop_save_markdown_file" => {
            let name = string(&args, "defaultFileName")?;
            let content = args["content"].as_str().unwrap_or("").to_owned();
            let dialog = app
                .dialog()
                .file()
                .set_title("Save Markdown")
                .set_file_name(name)
                .add_filter("Markdown", &["md"]);
            let path = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
                .await
                .map_err(|_| "Save dialog did not finish")?;
            let Some(path) = path else {
                return Ok(Value::Null);
            };
            let path = path
                .into_path()
                .map_err(|_| "Selected file is not a local filesystem path")?;
            let saved = path.to_string_lossy().to_string();
            tauri::async_runtime::spawn_blocking(move || std::fs::write(path, content))
                .await
                .map_err(|_| "Save completion is unknown")?
                .map_err(|_| "File could not be saved")?;
            Ok(json!(saved))
        }
        "desktop_get_lan_address" => state.setting(&command, json!({})).await,
        "desktop_open_external_url" => {
            app.opener()
                .open_url(external_url(&args["url"])?.as_str(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "desktop_open_path" | "desktop_reveal_path" => {
            let path = std::fs::canonicalize(string(&args, "path")?)
                .map_err(|_| "Path does not exist or is unavailable")?;
            if command == "desktop_reveal_path" {
                app.opener()
                    .reveal_item_in_dir(path)
                    .map_err(|e| e.to_string())?;
            } else {
                app.opener()
                    .open_path(path.to_string_lossy(), args["app"].as_str())
                    .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "desktop_new_window"
        | "desktop_new_window_at_url"
        | "desktop_new_window_for_host"
        | "desktop_open_draft_mini_chat_window"
        | "desktop_open_thread_mini_chat_window" => {
            let _creation = state.mini_create.lock().await;
            let mut bootstrap = state.bootstrap(webview.label()).await?;
            let mini = command.contains("mini_chat");
            if command == "desktop_open_thread_mini_chat_window" {
                let thread = string(&args, "threadId")?;
                let branch = string(&args, "branchId")?;
                let key = crate::native_presentation::runtime_key(&bootstrap);
                let existing_label = state
                    .windows
                    .lock()
                    .map_err(|_| "Window registry unavailable")?
                    .iter()
                    .find(|(_, window)| {
                        window.mini_thread.as_ref() == Some(&(thread.clone(), branch.clone()))
                            && window.bootstrap.as_ref().is_some_and(|bootstrap| {
                                crate::native_presentation::runtime_key(bootstrap) == key
                            })
                    })
                    .map(|(label, _)| label.clone());
                let existing = existing_label.and_then(|label| app.get_webview_window(&label));
                if let Some(window) = existing {
                    native(window.unminimize())?;
                    native(window.show())?;
                    native(window.set_focus())?;
                    return Ok(Value::Null);
                }
            }
            let label = format!(
                "{}-{}",
                if mini { "mini-chat" } else { "workbench" },
                state.sequence.fetch_add(1, Ordering::Relaxed)
            );
            bootstrap["windowRole"] = json!(if mini { "mini-chat" } else { "main" });
            if command == "desktop_new_window_at_url" {
                bootstrap["apiBaseUrl"] = json!(external_url(&args["url"])?.to_string());
                bootstrap["clientToken"] = json!(args["clientToken"].as_str().unwrap_or(""));
                bootstrap["requestHeaders"] = args["requestHeaders"]
                    .as_object()
                    .map(|h| json!(h))
                    .unwrap_or(json!({}));
                bootstrap["relayHostId"] = json!("");
            } else if command == "desktop_new_window_for_host" {
                let host_id = string(&args, "hostId")?;
                let config = state.setting("desktop_hosts_get", json!({})).await?;
                if host_id == "local" {
                    let local = bootstrap["localOrigin"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or("Local Host is unavailable")?
                        .to_owned();
                    bootstrap["apiBaseUrl"] = json!(local);
                    bootstrap["clientToken"] = state
                        .setting("desktop_local_client_token_get", json!({}))
                        .await?;
                    bootstrap["requestHeaders"] = json!({});
                    bootstrap["relayHostId"] = json!("");
                } else {
                    let host = config["hosts"]
                        .as_array()
                        .and_then(|hosts| hosts.iter().find(|h| h["id"] == host_id))
                        .ok_or("Saved Host no longer exists")?;
                    bootstrap["apiBaseUrl"] = json!(
                        host["apiUrl"]
                            .as_str()
                            .or_else(|| host["url"].as_str())
                            .unwrap_or("")
                    );
                    bootstrap["clientToken"] = json!(host["clientToken"].as_str().unwrap_or(""));
                    bootstrap["requestHeaders"] = host["requestHeaders"]
                        .as_object()
                        .map(|h| json!(h))
                        .unwrap_or(json!({}));
                    bootstrap["relayHostId"] = json!(if host["relay"].is_object() {
                        host_id
                    } else {
                        String::new()
                    });
                }
            }
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            if mini {
                query.append_pair(
                    "mode",
                    if command == "desktop_open_thread_mini_chat_window" {
                        "thread"
                    } else {
                        "draft"
                    },
                );
            }
            for key in ["threadId", "branchId", "directory", "projectId"] {
                if let Some(value) = args[key].as_str() {
                    query.append_pair(key, value);
                }
            }
            create_window(
                &app,
                &label,
                if mini { "mini-chat" } else { "main" },
                Some(bootstrap),
                Some(&query.finish()),
            )?;
            Ok(Value::Null)
        }
        "desktop_transfer_draft" => {
            let mut args = args;
            crate::draft_transfer::validate(&args["transfer"])?;
            let source_document = state
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?
                .get(webview.label())
                .ok_or("Draft source is closed")?
                .document_nonce
                .clone();
            let bootstrap = state.bootstrap(webview.label()).await?;
            let target = focus_runtime_window(
                &app,
                webview.label(),
                bootstrap.clone(),
                json!({"type":"focus-runtime-window"}),
            )?;
            let (id, receipt) = {
                let windows = state
                    .windows
                    .lock()
                    .map_err(|_| "Window registry unavailable")?;
                if windows
                    .get(webview.label())
                    .is_none_or(|record| record.document_nonce != source_document)
                {
                    return Err("Draft source document changed".into());
                }
                state
                    .draft_transfers
                    .lock()
                    .map_err(|_| "Draft broker unavailable")?
                    .admit(&windows, webview.label(), &target, args["transfer"].take())?
            };
            if let Err(error) = queue_navigation(
                &app,
                &target,
                &bootstrap,
                json!({"type":"transfer-draft","transferId":id}),
            ) {
                state
                    .draft_transfers
                    .lock()
                    .map_err(|_| "Draft broker unavailable")?
                    .cancel(&id, &error);
                return Err(error);
            }
            let outcome = match tokio::time::timeout(std::time::Duration::from_secs(30), receipt)
                .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("Draft acknowledgment ended; acceptance is unknown".into()),
                Err(_) => {
                    state
                        .draft_transfers
                        .lock()
                        .map_err(|_| "Draft broker unavailable")?
                        .cancel(&id, "Draft acknowledgment timed out; acceptance is unknown");
                    Err("Draft acknowledgment timed out; acceptance is unknown. Keep the source draft.".into())
                }
            };
            // Remove buffered IDs as well as payloads, including a never-ready receiver.
            if let Ok(mut windows) = state.windows.lock() {
                if let Some(record) = windows.get_mut(&target) {
                    record
                        .navigation
                        .retain(|action| action["transferId"] != id);
                }
            }
            outcome?;
            Ok(json!({"accepted":true}))
        }
        "desktop_complete_draft_transfer" => {
            let id = string(&args, "transferId")?;
            let accepted = boolean(&args, "accepted")?;
            let windows = state
                .windows
                .lock()
                .map_err(|_| "Window registry unavailable")?;
            state
                .draft_transfers
                .lock()
                .map_err(|_| "Draft broker unavailable")?
                .complete(
                    &windows,
                    webview.label(),
                    &id,
                    accepted,
                    args["reason"].as_str(),
                )?;
            Ok(Value::Null)
        }
        "desktop_focus_main_window" => {
            let bootstrap = state.bootstrap(webview.label()).await?;
            let action = crate::window_registry::main_window_action(&args)?;
            focus_runtime_window(&app, webview.label(), bootstrap, action)?;
            Ok(json!({"focused":true}))
        }
        "desktop_notify" => {
            let bootstrap = state.bootstrap(webview.label()).await?;
            app.state::<crate::native_notifications::NativeNotifications>()
                .show(&app, webview.label(), &bootstrap, &args)?;
            Ok(Value::Null)
        }
        "desktop_check_for_updates" => app.state::<crate::updater::Owner>().check(&app).await,
        "desktop_download_and_install_update" => {
            let handle = app.clone();
            app.state::<crate::updater::Owner>()
                .download(&app, &state.data_dir.join("updates"), move |detail| {
                    let labels: Vec<_> = handle
                        .state::<DesktopState>()
                        .windows
                        .lock()
                        .map(|w| w.keys().cloned().collect())
                        .unwrap_or_default();
                    for label in labels {
                        emit(&handle, &label, "varin:update-progress", detail.clone());
                    }
                })
                .await?;
            Ok(Value::Null)
        }
        "desktop_restart_without_update" | "desktop_restart" => {
            let handle = app.clone();
            let install = command == "desktop_restart";
            tauri::async_runtime::spawn(async move {
                if install && handle.state::<crate::updater::Owner>().downloaded().await {
                    if let Err(error) = handle
                        .state::<crate::updater::Owner>()
                        .install_after_drain(&handle, || drain(&handle))
                        .await
                    {
                        match error {
                            crate::updater::InstallFailure::Installation(message) => {
                                let exit = handle.clone();
                                crate::dialogs::show(
                                    &handle,
                                    None,
                                    "Varin update needs attention",
                                    message,
                                    crate::dialogs::Buttons::Acknowledge("Quit Varin".into()),
                                    move |_| exit.exit(1),
                                );
                            }
                            crate::updater::InstallFailure::Preparation(message)
                            | crate::updater::InstallFailure::Drain(message) => {
                                crate::dialogs::inform(
                                    &handle,
                                    "Varin update was not installed",
                                    message,
                                );
                            }
                        }
                    }
                } else if drain(&handle).await.is_ok() {
                    handle.restart();
                }
            });
            Ok(Value::Null)
        }
        command
            if command.starts_with("desktop_companion_")
                || matches!(command, "desktop_get_companion" | "desktop_set_companion") =>
        {
            let process = if webview.label().starts_with("companion-") {
                crate::companion::process_for_window(&app, webview.label()).await?
            } else {
                browser_service(&app).await?.process
            };
            process
                .request(
                    "companionInvoke",
                    json!({"command":command,"args":args,"windowLabel":webview.label()}),
                )
                .await
        }
        "desktop_browser_device" => {
            crate::window_registry::validate_browser_device_args(&args)?;
            state.bootstrap(webview.label()).await?;
            // Select the caller's original native record, never a label, target
            // object or credentials supplied in renderer arguments.
            let request = {
                let windows = state.windows.lock().map_err(|_| "Window registry unavailable")?;
                crate::window_registry::browser_device_request(&windows, webview.label(), args)?
            };
            let service = browser_service(&app).await?;
            service.process.request("browserInvoke", request).await
        }
        command if command.starts_with("desktop_browser_") || command == "desktop_web_render" => {
            let service = browser_service(&app).await?;
            service
                .process
                .request(
                    "desktopInvoke",
                    json!({"command":command,"args":args,"windowLabel":webview.label()}),
                )
                .await
        }
        command if command.starts_with("desktop_ssh_") => {
            let host = state
                .host
                .lock()
                .await
                .clone()
                .ok_or("Local Application Host is disabled or unavailable")?;
            host.request("desktopInvoke", json!({"command":command,"args":args}))
                .await
        }
        _ => Err(format!(
            "Desktop capability {command} is not available in this build"
        )),
    }
}

#[tauri::command]
async fn varin_dialog_open(
    app: AppHandle,
    webview: Webview,
    state: State<'_, DesktopState>,
    options: Value,
) -> Reply {
    state.authorize(&webview)?;
    let mut dialog = app.dialog().file();
    let title = options["title"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            crate::native_presentation::text(
                &app.state::<crate::native_menu::NativeMenus>().locale(),
                if options["directory"] == true {
                    "Select Folder"
                } else {
                    "Open File"
                },
            )
        });
    dialog = dialog.set_title(title);
    if let Some(directory) = options["defaultPath"].as_str() {
        dialog = dialog.set_directory(directory);
    }
    if let Some(filters) = options["filters"].as_array() {
        for filter in filters {
            if let (Some(name), Some(extensions)) =
                (filter["name"].as_str(), filter["extensions"].as_array())
            {
                let extensions: Vec<_> = extensions.iter().filter_map(Value::as_str).collect();
                dialog = dialog.add_filter(name, &extensions);
            }
        }
    }
    let directory = options["directory"] == true;
    let multiple = options["multiple"] == true;
    let result = tauri::async_runtime::spawn_blocking(move || {
        if multiple {
            if directory {
                dialog.blocking_pick_folders()
            } else {
                dialog.blocking_pick_files()
            }
        } else {
            (if directory {
                dialog.blocking_pick_folder()
            } else {
                dialog.blocking_pick_file()
            })
            .map(|p| vec![p])
        }
    })
    .await
    .map_err(|_| "File dialog could not finish")?;
    let Some(paths) = result else {
        return Ok(Value::Null);
    };
    let values: Vec<Value> = paths
        .into_iter()
        .map(|path| json!(path.to_string()))
        .collect();
    if options["returnGrant"] == true {
        let host = state
            .host
            .lock()
            .await
            .clone()
            .filter(|host| host.snapshot().phase == HostPhase::Ready);
        let mut grants = Vec::new();
        for path in values {
            let grant = if directory {
                json!({"path":path})
            } else if let Some(host) = &host {
                host.request("fileGrant", json!({"path":path}))
                    .await
                    .unwrap_or_else(|_| json!({"path":path}))
            } else {
                json!({"path":path})
            };
            grants.push(grant);
        }
        return Ok(if multiple {
            json!(grants)
        } else {
            grants.into_iter().next().unwrap_or(Value::Null)
        });
    }
    Ok(if multiple {
        json!(values)
    } else {
        values.into_iter().next().unwrap_or(Value::Null)
    })
}
#[tauri::command]
async fn varin_frontend_migration(
    webview: Webview,
    state: State<'_, DesktopState>,
    action: String,
    id: Option<String>,
    digest: Option<String>,
    imported_keys: Option<Vec<String>>,
    retained_keys: Option<Vec<String>>,
) -> Reply {
    state.authorize(&webview)?;
    if webview.label() != "main" {
        return Err("Only the main application may migrate its client preferences".into());
    }
    match action.as_str() {
        "read" => state.setting("frontendMigrationRead", json!({"serialized":true})).await,
        "complete" => state.setting("frontendMigrationComplete",json!({"id":id,"digest":digest,"importedKeys":imported_keys,"retainedKeys":retained_keys})).await,
        _ => Err("Unknown client migration action".into()),
    }
}
#[tauri::command]
async fn varin_file_grant_existing(
    webview: Webview,
    state: State<'_, DesktopState>,
    file_path: String,
) -> Reply {
    state.authorize(&webview)?;
    let host = state
        .host
        .lock()
        .await
        .clone()
        .ok_or("Local file grant owner is unavailable")?;
    host.request("fileGrant", json!({"path":file_path})).await
}
async fn close_workbench_window(
    app: &AppHandle,
    label: &str,
    close: &crate::lifecycle::CloseReceipt,
    view: &Webview,
) -> Result<(), String> {
    let mut parked = Vec::new();
    let result = async {
        for service in app.state::<DesktopState>().services.lock().await.clone() {
            parked.push(service.browser.detach_window(label)?);
        }
        close.request(view).await
    }
    .await;
    if result.is_err() && !close.closed() {
        for original in parked {
            original.restore()?;
        }
    }
    result
}

async fn drain(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return Err("Desktop shutdown is already pending".into());
    }
    let result: Result<(), String> = async {
        // No resource snapshot is valid until every earlier admission has
        // published its owner (or finished its original cleanup).
        state.admission.shutdown().await?;
        if let Some(host) = state
            .host
            .lock()
            .await
            .clone()
            .filter(|h| matches!(h.snapshot().phase, HostPhase::Ready))
        {
            let risk = host.request("quitRisk", Value::Null).await?;
            let scheduled = &risk["scheduledTasks"];
            let enabled = scheduled["enabledScheduledTasksCount"]
                .as_u64()
                .or_else(|| scheduled["enabledCount"].as_u64())
                .unwrap_or(0);
            let running = scheduled["runningScheduledTasksCount"]
                .as_u64()
                .or_else(|| scheduled["runningCount"].as_u64())
                .unwrap_or(0);
            let risky = risk["tunnel"]["active"] == true
                || scheduled["hasEnabledScheduledTasks"] == true
                || scheduled["hasRunningScheduledTasks"] == true
                || enabled > 0
                || running > 0;
            if risky {
                let locale = app.state::<crate::native_menu::NativeMenus>().locale();
                let mut details = vec![crate::native_presentation::text(
                    &locale,
                    "Quitting will stop background processes and may interrupt pending work.",
                )];
                if risk["tunnel"]["active"] == true {
                    details.push(crate::native_presentation::text(&locale, "Active tunnel"));
                }
                if running > 0 {
                    details.push(crate::native_presentation::counted(
                        &locale,
                        "Running scheduled tasks: {count}",
                        running as usize,
                    ));
                }
                if enabled > 0 {
                    details.push(crate::native_presentation::counted(
                        &locale,
                        "Enabled scheduled tasks: {count}",
                        enabled as usize,
                    ));
                }
                if !crate::dialogs::confirm(
                    app,
                    Some("main"),
                    "Quit Varin?",
                    details.join("\n"),
                    "Quit",
                    "Cancel",
                )
                .await
                {
                    return Err("Quit was cancelled; local services remain running".into());
                }
            }
        }
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(geometry) = crate::window_geometry::snapshot(app, &window) {
                state
                    .setting("saveWindowState", json!({"state":geometry}))
                    .await?;
            }
        }
        // First let every workbench flush state and run before-unload. No Host,
        // browser or native executor has been stopped if any window refuses.
        let windows: Vec<_> = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?
            .iter()
            .filter_map(|(label, w)| w.close.clone().map(|close| (label.clone(), close)))
            .collect();
        for (label, close) in windows {
            if let Some(view) = app.get_webview(&label) {
                close_workbench_window(app, &label, &close, &view).await?;
            }
        }
        state.settings.shutdown().await?;
        let services = state.services.lock().await.clone();
        for service in &services {
            // A historical unknown effect is not proof of a live process. Keep
            // that fact, but permit shell exit after the actual scope is empty.
            if let Err(error) = service.process.stop().await {
                service.process.disconnect(&error).await;
                service.process.wait_for_scope_end().await?;
            } else {
                service.process.wait_for_scope_end().await?;
            }
            service.cleanup().await?;
        }
        app.state::<crate::power::PowerManager>()
            .set(app, false)
            .await?;
        app.state::<crate::native_menu::NativeMenus>().shutdown(app);
        app.state::<crate::native_notifications::NativeNotifications>()
            .shutdown(app);
        state.exit_ready.store(true, Ordering::Release);
        Ok(())
    }
    .await;
    if result.is_err() {
        state.settings.resume();
        state.admission.resume()?;
        state.quitting.store(false, Ordering::Release);
    }
    result
}

pub fn run() {
    if std::env::args().any(|a| a == "--varin-desktop-smoke")
        && std::env::args().any(|a| a == "--varin-desktop-benchmark")
    {
        eprintln!("Native smoke and benchmark launches are mutually exclusive");
        return;
    }
    let benchmark = match crate::benchmark::prepare() {
        Ok(request) => request,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let smoke = match crate::smoke::prepare() {
        Ok(request) => request,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let (boot, _) = watch::channel(None);
    let (geometry, _) = watch::channel(None);
    let (deep_links, deep_link_requests) = tokio::sync::mpsc::channel(64);
    let data_dir = match settings::data_directory() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    // Own the data before CEF initializes its global cache or any profile.
    let context = tauri::generate_context!();
    let lease = match crate::desktop_lock::Lease::acquire(&data_dir) {
        Ok(lease) => lease,
        Err(error) => {
            // Warm activation reaches the verified first instance without
            // opening another engine or weakening the cross-shell data lease.
            if crate::preengine_activation::forward_to_owner(&data_dir, &context.config().identifier).is_ok() {
                return;
            }
            eprintln!("{error}");
            return;
        }
    };
    if let Err(error) = crate::preengine_activation::publish(&data_dir, &lease) {
        eprintln!("{error}");
        return;
    }
    let owned_lease=OnceLock::new();
    if owned_lease.set(lease).is_err(){return;}
    let builder = tauri::Builder::default()
        .manage(crate::native_menu::NativeMenus::new())
        .manage(crate::power::PowerManager::default())
        .manage(crate::updater::Owner::default())
        .plugin(crate::updater::plugin())
        .manage(crate::native_notifications::NativeNotifications::new())
        .on_menu_event(|app, event| crate::native_menu::dispatch(app, event.id.as_ref()))
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            queue_deep_links(app, args, "single-instance");
            let _ = request_activation_restore(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .manage(DesktopState {
            runtime: OnceLock::new(),
            settings: settings::Owner::default(),
            lease: owned_lease,
            data_dir,
            smoke: smoke.clone(),
            benchmark: benchmark.clone(),
            background: Mutex::new(None),
            mini_create: tokio::sync::Mutex::new(()),
            deep_links,
            activation_restores: crate::preengine_activation::RestoreIntents::default(),
            boot,
            windows: Mutex::new(HashMap::new()),
            draft_transfers: Mutex::new(crate::draft_transfer::Broker::default()),
            host: tokio::sync::Mutex::new(None),
            services: tokio::sync::Mutex::new(Vec::new()),
            browser_start: tokio::sync::Mutex::new(()),
            focus_update: tokio::sync::Mutex::new(()),
            exit_ready: AtomicBool::new(false),
            preferences: Mutex::new(json!({})),
            startup_theme: OnceLock::new(),
            admission: crate::desktop_admission::Owner::default(),
            sequence: AtomicU64::new(1),
            quitting: AtomicBool::new(false),
            started_enabled: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            geometry,
            geometry_ready: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            varin_bootstrap,
            varin_invoke,
            varin_dialog_open,
            varin_file_grant_existing,
            varin_frontend_migration,
            varin_renderer_ready,
            varin_runtime_changed
        ])
        .setup(move |app| {
            let root = if cfg!(debug_assertions) {
                std::env::var_os("VARIN_DESKTOP_RUNTIME_DIR").map(PathBuf::from)
            } else {
                None
            }
            .unwrap_or(app.path().resource_dir()?.join("runtime"));
            if app
                .state::<crate::native_notifications::NativeNotifications>()
                .install(app.handle())
                .is_err()
            {
                eprintln!("Varin native notifications are unavailable; desktop startup continues");
            }
            start_geometry_writer(app.handle());
            start_deep_link_owner(app.handle(), deep_link_requests);
            queue_deep_links(app.handle(), std::env::args().collect(), "argv");
            tauri::async_runtime::spawn(initialize(app.handle().clone(), root));
            Ok(())
        });
    let app = match crate::engine::configure(crate::preview::register_protocol(
        crate::companion::register_asset_protocol(builder),
    ))
        .build(context)
    {
        Ok(app) => app,
        Err(_) => {
            let error = "Varin desktop could not initialize its required native runtime";
            if let Some(request) = smoke {
                let _ = crate::smoke::startup_failed(&request, error);
            }
            if let Some(request) = benchmark {
                let _ = crate::benchmark::startup_failed(&request, error);
            }
            eprintln!("{error}");
            return;
        }
    };
    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            let _ = request_activation_restore(app);
        }
        if let tauri::RunEvent::Opened { urls } = &event {
            queue_deep_links(
                app,
                urls.iter().map(ToString::to_string).collect(),
                "opened",
            );
            show_main(app);
        }
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            // CEF emits code=None after its last native window closes. Remote
            // background notification ownership survives that event like Electron.
            if code.is_none()
                && !app.state::<DesktopState>().quitting.load(Ordering::Acquire)
                // The private migration window may close before startup has
                // constructed main. Its close is not a user request to quit.
                && (app.state::<DesktopState>().boot.borrow().is_none()
                    || cfg!(target_os = "macos")
                    || (app
                        .state::<crate::native_menu::NativeMenus>()
                        .tray_enabled()
                        && app
                            .state::<DesktopState>()
                            .background
                            .lock()
                            .is_ok_and(|value| value.is_some())))
            {
                api.prevent_exit();
                return;
            }
            if !app
                .state::<DesktopState>()
                .exit_ready
                .load(Ordering::Acquire)
            {
                api.prevent_exit();
                if app.state::<DesktopState>().quitting.load(Ordering::Acquire) {
                    return;
                }
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    if drain(&handle).await.is_ok() {
                        handle.exit(0);
                    }
                });
            }
        }
    });
}

pub(crate) async fn benchmark_sessions(app: &AppHandle) -> Vec<(String, crate::cdp::Session)> {
    let state = app.state::<DesktopState>();
    if state.benchmark.is_none() {
        return Vec::new();
    }
    let mut sessions = state
        .windows
        .lock()
        .map(|windows| {
            windows
                .iter()
                .filter_map(|(label, window)| {
                    window
                        .cdp
                        .clone()
                        .map(|session| (format!("application:{label}"), session))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let services = state.services.lock().await.clone();
    for service in services {
        sessions.extend(service.companion.benchmark_sessions());
        sessions.extend(service.browser.benchmark_sessions());
    }
    sessions
}

pub(crate) fn smoke_main_session(app: &AppHandle) -> Result<crate::cdp::Session, String> {
    app.state::<DesktopState>()
        .windows
        .lock()
        .map_err(|_| "Window registry unavailable")?
        .get("main")
        .and_then(|window| window.cdp.clone())
        .ok_or("Main application session is unavailable".into())
}
pub(crate) async fn smoke_browser_service(
    app: &AppHandle,
) -> Result<crate::service::NativeService, String> {
    if app.state::<DesktopState>().smoke.is_none() {
        return Err("Native Browser inspection requires the isolated smoke launch".into());
    }
    browser_service(app).await
}
pub(crate) async fn smoke_shutdown(app: &AppHandle) -> Result<(), String> {
    drain(app).await
}
pub(crate) fn smoke_renderer_ready(app: &AppHandle) -> bool {
    app.state::<DesktopState>()
        .windows
        .lock()
        .is_ok_and(|windows| {
            windows
                .get("main")
                .is_some_and(|window| window.renderer_ready)
        })
}

pub(crate) fn is_application_window(app: &AppHandle, label: &str) -> bool {
    app.state::<DesktopState>()
        .windows
        .lock()
        .is_ok_and(|windows| windows.contains_key(label))
}

async fn browser_service(app: &AppHandle) -> Result<crate::service::NativeService, String> {
    let state = app.state::<DesktopState>();
    let _serial = state.browser_start.lock().await;
    if state.restarting.load(Ordering::Acquire) {
        return Err("Local Host restart is pending".into());
    }
    let services = state.services.lock().await.clone();
    for service in services {
        if matches!(
            service.process.snapshot().phase,
            HostPhase::Exited | HostPhase::Failed
        ) {
            service.process.wait_for_scope_end().await?;
            service.cleanup().await?;
            state
                .services
                .lock()
                .await
                .retain(|owned| !owned.process.same_process(&service.process));
            continue;
        }
        service.process.ready().await?;
        return Ok(service);
    }
    if state.quitting.load(Ordering::Acquire) {
        return Err("Desktop is shutting down".into());
    }
    let service = {
        let _admission = state.admission.enter()?;
        let process = HostProcess::spawn_browser(state.runtime()?, &state.data_dir)?;
        let service =
            crate::service::NativeService::attach(app.clone(), process, state.data_dir.clone()).await?;
        state.services.lock().await.push(service.clone());
        service
    };
    service.process.ready().await?;
    refresh_desktop_state(app);
    Ok(service)
}
pub(crate) fn service_event(app: &AppHandle, process: &HostProcess, event: &str, payload: Value) {
    if event == "restartRequested" {
        if app
            .state::<DesktopState>()
            .restarting
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let app = app.clone();
        let process = process.clone();
        tauri::async_runtime::spawn(async move {
            let result = restart_local_host(&app, &process).await;
            app.state::<DesktopState>()
                .restarting
                .store(false, Ordering::Release);
            if result.is_err() {
                let labels: Vec<_> = app
                    .state::<DesktopState>()
                    .windows
                    .lock()
                    .map(|windows| windows.keys().cloned().collect())
                    .unwrap_or_default();
                for label in labels {
                    emit(&app, &label, "varin:local-host-restart-failed", Value::Null);
                }
            }
        });
        return;
    }
    let mapped = match event {
        "browser" => Some("varin:browser"),
        "connectionStatus" => Some("varin:ssh-instance-status"),
        "installedAppsUpdated" => Some("varin:installed-apps-updated"),
        "companionLibraryChanged" => Some("varin:companion-library-changed"),
        _ => None,
    };
    if let Some(mapped) = mapped {
        let labels: Vec<_> = app
            .state::<DesktopState>()
            .windows
            .lock()
            .map(|w| w.keys().cloned().collect())
            .unwrap_or_default();
        for label in labels {
            emit(app, &label, mapped, payload.clone());
        }
    } else if event == "remoteNotification" {
        let label = payload["windowLabel"].as_str().unwrap_or("main").to_owned();
        let runtime = payload["runtimeConfig"].clone();
        let notification = payload["notification"].clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(mut bootstrap) = bootstrap_for_window(&app, &label).await.or_else(|_| {
                app.state::<DesktopState>()
                    .boot
                    .borrow()
                    .clone()
                    .ok_or("Desktop is not ready".to_owned())
                    .and_then(|r| r)
            }) {
                for key in ["apiBaseUrl", "clientToken", "requestHeaders", "relayHostId"] {
                    bootstrap[key] = runtime[key].clone();
                }
                let _ = app
                    .state::<crate::native_notifications::NativeNotifications>()
                    .show(&app, &label, &bootstrap, &notification);
            }
        });
    } else if event == "notification" {
        let app = app.clone();
        let source = process.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(mut bootstrap) = bootstrap_for_window(&app, "main").await.or_else(|_| {
                app.state::<DesktopState>()
                    .boot
                    .borrow()
                    .clone()
                    .ok_or("Desktop is not ready".to_owned())
                    .and_then(|r| r)
            }) {
                let identity = source.snapshot();
                if identity.mode == crate::host::HostMode::Host {
                    bootstrap["apiBaseUrl"] = json!(identity.origin.unwrap_or_default());
                    bootstrap["clientToken"] = json!(identity.client_token.unwrap_or_default());
                    bootstrap["requestHeaders"] = json!({});
                    bootstrap["relayHostId"] = json!("");
                }
                let _ = app
                    .state::<crate::native_notifications::NativeNotifications>()
                    .show(&app, "main", &bootstrap, &payload);
            }
        });
    }
}
async fn restart_local_host(app: &AppHandle, previous: &HostProcess) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let _serial = state.browser_start.lock().await;
    if state.quitting.load(Ordering::Acquire) {
        return Err("Desktop is shutting down".into());
    }
    if !state
        .host
        .lock()
        .await
        .as_ref()
        .is_some_and(|host| host.same_process(previous))
    {
        return Err("Restart request no longer owns the local Host".into());
    }
    let previous_origin = previous.snapshot().origin.unwrap_or_default();
    // This path is entered only by the original Host's explicit restart event.
    // Its stopped receipt and actual zero exit are both required. Crashes never
    // automatically replay requests or create replacement application owners.
    previous.wait_for_scope_end().await?;
    previous.stop().await?;
    let services = state.services.lock().await.clone();
    for service in services
        .into_iter()
        .filter(|service| service.process.same_process(previous))
    {
        service.cleanup().await?;
    }
    state
        .services
        .lock()
        .await
        .retain(|service| !service.process.same_process(previous));
    if state.quitting.load(Ordering::Acquire) {
        return Err("Desktop is shutting down".into());
    }
    let process = {
        let _admission = state.admission.enter()?;
        let process = HostProcess::spawn(state.runtime()?, &state.data_dir)?;
        let service =
            crate::service::NativeService::attach(app.clone(), process.clone(), state.data_dir.clone())
                .await?;
        *state.host.lock().await = Some(process.clone());
        state.services.lock().await.push(service);
        process
    };
    let ready = process.ready().await?;
    let origin = ready
        .origin
        .ok_or("Restarted Host returned no local origin")?;
    let token = ready
        .client_token
        .ok_or("Restarted Host returned no local credential")?;
    let update = |value: &mut Value| {
        value["localOrigin"] = json!(origin);
        value["bootOutcome"]["localAvailable"] = json!(true);
        if value["apiBaseUrl"].as_str() == Some(previous_origin.as_str())
            && value["relayHostId"].as_str().unwrap_or("").is_empty()
        {
            value["apiBaseUrl"] = json!(origin);
            value["clientToken"] = json!(token);
            value["requestHeaders"] = json!({});
            if value["bootOutcome"]["target"] == "local" {
                value["bootOutcome"]["status"] = json!("ok");
            }
        }
    };
    state.boot.send_modify(|boot| {
        if let Some(Ok(value)) = boot {
            update(value);
        }
    });
    let labels = {
        let mut windows = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        for window in windows.values_mut() {
            if let Some(value) = window.bootstrap.as_mut() {
                update(value);
            }
        }
        state.draft_transfers.lock().map_err(|_| "Draft broker unavailable")?.reconcile(&windows);
        windows.keys().cloned().collect::<Vec<_>>()
    };
    for label in labels {
        emit(
            app,
            &label,
            "varin:local-host-restarted",
            json!({"previousOrigin":previous_origin}),
        );
    }
    refresh_desktop_state(app);
    Ok(())
}
pub(crate) async fn bootstrap_for_window(app: &AppHandle, label: &str) -> Reply {
    app.state::<DesktopState>().bootstrap(label).await
}

pub(crate) fn register_application_window(
    app: &AppHandle,
    label: &str,
    role: &str,
    bootstrap: Option<Value>,
) -> Result<(), String> {
    if role != "companion" || !label.starts_with("companion-") {
        return Err("Unsupported application window role".into());
    }
    let origin = application_origin();
    let bootstrap = bootstrap.map(|mut value| {
        value["windowRole"] = json!(role);
        value
    });
    app.state::<DesktopState>()
        .windows
        .lock()
        .map_err(|_| "Window registry unavailable")?
        .insert(
            label.into(),
            WindowRecord {
                mini_thread: None,
                document_nonce: uuid::Uuid::new_v4().to_string(),
                renderer_ready: false,
                navigation: Vec::new(),
                native_ready: watch::channel(Some(Ok(false))).0,
                origin,
                bootstrap,
                close: None,
                cdp: None,
            },
        );
    Ok(())
}

fn request_activation_restore(app: &AppHandle) -> Result<(), String> {
    app.state::<DesktopState>().activation_restores.request()?;
    dispatch_activation_restore(app)
}
fn dispatch_activation_restore(app: &AppHandle) -> Result<(), String> {
    let handle = app.clone();
    native(app.run_on_main_thread(move || {
        let state = handle.state::<DesktopState>();
        if state.activation_restores.take_ready().unwrap_or(false)
            && show_last_conversation(&handle).is_err()
        {
            // Keep the intent if native restoration was unavailable. A later
            // activation may retry presentation, never its deep-link action.
            let _ = state.activation_restores.request();
        }
    }))
}

/// Reactivation restores an existing conversation, including a hidden or
/// minimized Mini Chat. Companion/control windows never become the fallback.
pub(crate) fn show_last_conversation(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<DesktopState>();
    if state.quitting.load(Ordering::Acquire) {
        return Err("Desktop shutdown is already in progress".into());
    }
    let mut windows = state.windows.lock()
        .map_err(|_| "Window registry unavailable")?
        .iter()
        .filter(|(_, record)| record.close.as_ref().is_some_and(|close| !close.closed()))
        .filter_map(|(label, _)| app.get_webview_window(label))
        .collect::<Vec<_>>();
    windows.sort_by(|a, b| a.label().cmp(b.label()));
    let remembered = app.state::<crate::native_menu::NativeMenus>().last_conversation_window();
    let target = remembered.as_ref()
        .and_then(|label| windows.iter().find(|window| window.label() == label))
        .or_else(|| windows.iter().find(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
        }))
        .or_else(|| windows.first());
    if let Some(window) = target {
        native(window.show())?;
        native(window.unminimize())?;
        native(window.set_focus())?;
        return Ok(window.label().to_owned());
    }
    show_main(app);
    app.get_webview_window("main")
        .map(|_| "main".to_owned())
        .ok_or("The conversation window could not be restored".into())
}

pub(crate) fn show_main(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    if state.boot.borrow().is_none() && app.get_webview_window("main").is_none() {
        // Startup alone creates the first conversation after its presentation is
        // known. Early OS activation must not create a competing default page.
        let _ = state.activation_restores.request();
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let bootstrap = app
            .state::<DesktopState>()
            .background
            .lock()
            .ok()
            .and_then(|value| value.clone());
        let _ = create_window(app, "main", "main", bootstrap, None);
    }
}
pub(crate) fn menu_action(app: &AppHandle, action: &str) {
    let target = app
        .state::<crate::native_menu::NativeMenus>()
        .menu_target()
        .and_then(|label| app.get_webview_window(&label))
        .or_else(|| {
            app.webview_windows()
                .into_values()
                .find(|w| is_application_window(app, w.label()) && w.is_focused().unwrap_or(false))
        })
        .or_else(|| app.get_webview_window("main"));
    match action {
        "show-main" => show_main(app),
        "quit" | "restart" => {
            let app = app.clone();
            let restart = action == "restart";
            tauri::async_runtime::spawn(async move {
                if drain(&app).await.is_ok() {
                    if restart {
                        app.restart();
                    } else {
                        app.exit(0);
                    }
                }
            });
        }
        "new-window" => {
            if let Some(target) = target {
                let app = app.clone();
                let label = target.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    if let Ok(bootstrap) = bootstrap_for_window(&app, &label).await {
                        let id = app
                            .state::<DesktopState>()
                            .sequence
                            .fetch_add(1, Ordering::Relaxed);
                        let _ = create_window(
                            &app,
                            &format!("workbench-{id}"),
                            "main",
                            Some(bootstrap),
                            None,
                        );
                    }
                });
            }
        }
        "updates" => {
            if let Some(window) = target {
                let app = app.clone();
                let label = window.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let bootstrap = bootstrap_for_window(&app, &label).await?;
                        focus_runtime_window(
                            &app,
                            &label,
                            bootstrap,
                            json!({"type":"check-for-updates"}),
                        )
                    }
                    .await;
                    if let Err(error) = result {
                        crate::dialogs::inform(&app, "Unable to check for updates", error);
                    }
                });
            }
        }
        "clear-cache" => {
            if let Some(window) = target {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = varin_invoke(
                        app.clone(),
                        window.as_ref().clone(),
                        app.state::<DesktopState>(),
                        "desktop_clear_cache".into(),
                        json!({}),
                    )
                    .await;
                });
            }
        }
        "report-bug" | "request-feature" | "discord" => {
            let url = if action == "discord" {
                "https://discord.gg/ZYRSdnwwKA"
            } else {
                "https://github.com/Youzini-afk/Varin/issues/new"
            };
            let _ = app.opener().open_url(url, None::<&str>);
        }
        "close" => {
            if let Some(window) = target {
                let _ = window.close();
            }
        }
        "minimize" => {
            if let Some(window) = target {
                let _ = window.minimize();
            }
        }
        "maximize" => {
            if let Some(window) = target {
                let _ = if window.is_maximized().unwrap_or(false) {
                    window.unmaximize()
                } else {
                    window.maximize()
                };
            }
        }
        "fullscreen" => {
            if let Some(window) = target {
                let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
            }
        }
        "reload" => {
            if let Some(window) = target {
                let _ = window.reload();
            }
        }
        "force-reload" => {
            if let Some(window) = target {
                use tauri_runtime_cef::{WebviewCefExt, cef::ImplBrowser};
                let _ = window.with_cef_webview(|view| view.browser().reload_ignore_cache());
            }
        }
        "devtools" => {
            if let Some(window) = target {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" => {
            if let Some(window) = target {
                let _ = crate::native_menu::edit(&window, action);
                if action == "copy" {
                    emit(app, window.label(), "varin:menu-action", json!(action));
                }
            }
        }
        _ => {
            if let Some(window) = target {
                emit(app, window.label(), "varin:menu-action", json!(action));
            }
        }
    }
}

fn refresh_desktop_state(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<DesktopState>();
        let _serial = state.focus_update.lock().await;
        let focused = app.webview_windows().into_values().find(|window| {
            is_application_window(&app, window.label()) && window.is_focused().unwrap_or(false)
        });
        let config = focused.as_ref().and_then(|window| {
            state
                .windows
                .lock()
                .ok()
                .and_then(|w| w.get(window.label()).and_then(|w| w.bootstrap.clone()))
        });
        let config=config.map(|value|json!({"apiBaseUrl":value["apiBaseUrl"],"clientToken":value["clientToken"],"requestHeaders":value["requestHeaders"],"relayHostId":value["relayHostId"]}));
        let services = state.services.lock().await.clone();
        let mut targets:Vec<_>=state.windows.lock().map(|windows|windows.iter().filter_map(|(label,window)|{
            if window.close.is_none(){return None;}let value=window.bootstrap.as_ref()?;
            if value["apiBaseUrl"].as_str().unwrap_or("").is_empty()&&value["relayHostId"].as_str().unwrap_or("").is_empty(){return None;}
            Some(json!({"windowLabel":label,"runtimeConfig":{"apiBaseUrl":value["apiBaseUrl"],"clientToken":value["clientToken"],"requestHeaders":value["requestHeaders"],"relayHostId":value["relayHostId"]}}))
        }).collect()).unwrap_or_default();
        if let Some(value) = state.background.lock().ok().and_then(|value| value.clone()) {
            let key = crate::native_presentation::runtime_key(&value);
            if !targets.iter().any(|target| {
                crate::native_presentation::runtime_key(&target["runtimeConfig"]) == key
            }) {
                targets.push(json!({"windowLabel":"main","runtimeConfig":{"apiBaseUrl":value["apiBaseUrl"],"clientToken":value["clientToken"],"requestHeaders":value["requestHeaders"],"relayHostId":value["relayHostId"]}}));
            }
        }
        let mut notifications_assigned = false;
        for service in services {
            let _ = service.computer.refresh_windows();
            if matches!(service.process.snapshot().phase, HostPhase::Ready) {
                if let Ok(handles) = service.computer.handles() {
                    let local = service.process.snapshot().origin;
                    let notification_targets: Vec<_> = if notifications_assigned {
                        Vec::new()
                    } else {
                        targets
                            .iter()
                            .filter(|target| {
                                local.as_ref().is_none_or(|origin| {
                                    target["runtimeConfig"]["apiBaseUrl"].as_str() != Some(origin)
                                })
                            })
                            .cloned()
                            .collect()
                    };
                    notifications_assigned = true;
                    let _=service.process.request("setDesktopState",json!({"focused":focused.is_some(),"runtimeConfig":config,"controlWindows":handles,"notificationTargets":notification_targets})).await;
                }
            }
        }
    });
}

fn application_origin() -> url::Url {
    url::Url::parse("http://tauri.localhost").expect("fixed bundled application origin")
}
pub(crate) fn unregister_application_window(app: &AppHandle, label: &str) {
    if let Ok(mut windows) = app.state::<DesktopState>().windows.lock() {
        windows.remove(label);
        if let Ok(mut transfers) = app.state::<DesktopState>().draft_transfers.lock() {
            transfers.window_ended(label, false);
        }
    }
}

fn remember_window_geometry(app: &AppHandle, label: &str) {
    if label != "main"
        || !app
            .state::<DesktopState>()
            .geometry_ready
            .load(Ordering::Acquire)
        || app.state::<DesktopState>().quitting.load(Ordering::Acquire)
    {
        return;
    }
    if let Some(window) = app.get_webview_window(label) {
        if let Ok(value) = crate::window_geometry::snapshot(app, &window) {
            app.state::<DesktopState>()
                .geometry
                .send_replace(Some(value));
        }
    }
}
fn start_geometry_writer(app: &AppHandle) {
    let app = app.clone();
    let mut geometry = app.state::<DesktopState>().geometry.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            if geometry.changed().await.is_err() {
                break;
            }
            loop {
                tokio::select! {
                    changed=geometry.changed()=>{if changed.is_err(){return;}}
                    _=tokio::time::sleep(std::time::Duration::from_millis(250))=>break,
                }
            }
            let value = geometry.borrow_and_update().clone();
            let state = app.state::<DesktopState>();
            if state.quitting.load(Ordering::Acquire) || state.runtime().is_err() {
                continue;
            }
            if let Some(value) = value {
                let _ = state
                    .setting("saveWindowState", json!({"state":value}))
                    .await;
            }
        }
    });
}

pub(crate) fn native_presentation_action(
    app: &AppHandle,
    label: &str,
    bootstrap: Value,
    action: Value,
) {
    let kind = action["type"].as_str().unwrap_or("");
    match kind {
        "quit" => {
            menu_action(app, "quit");
            return;
        }
        "toggle-main-window" => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
                    let _ = window.hide();
                    return;
                }
            }
            show_main(app);
            return;
        }
        "hide-main-window" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }
            return;
        }
        "show-main-window" => {
            show_main(app);
            return;
        }
        "focus-thread" | "new-thread" | "focus-runtime-window" => {}
        _ => return,
    }
    let _ = focus_runtime_window(app, label, bootstrap, action);
}

fn focus_runtime_window(
    app: &AppHandle,
    source_label: &str,
    mut bootstrap: Value,
    action: Value,
) -> Result<String, String> {
    let state = app.state::<DesktopState>();
    if state.quitting.load(Ordering::Acquire) {
        return Err("Desktop shutdown is already in progress".into());
    }
    let target = {
        let windows = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        crate::window_registry::workbench_target(&windows, source_label, &bootstrap)
    };
    let target = match target {
        Some(target) => target,
        None => {
            let target = format!(
                "workbench-{}",
                state.sequence.fetch_add(1, Ordering::Relaxed)
            );
            bootstrap["windowRole"] = json!("main");
            create_window(app, &target, "main", Some(bootstrap.clone()), None)?;
            target
        }
    };
    let window = app
        .get_webview_window(&target)
        .ok_or("Main window is unavailable")?;
    native(window.show())?;
    native(window.unminimize())?;
    native(window.set_focus())?;
    if action["type"] != "focus-runtime-window" {
        queue_navigation(app, &target, &bootstrap, action)?;
    }
    Ok(target)
}

fn queue_navigation(
    app: &AppHandle,
    label: &str,
    bootstrap: &Value,
    action: Value,
) -> Result<(), String> {
    let immediate = {
        let state = app.state::<DesktopState>();
        let mut windows = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        crate::window_registry::queue_navigation(&mut windows, label, bootstrap, action)?
    };
    if let Some(action) = immediate {
        emit_navigation(app, label, action)?;
    }
    Ok(())
}
fn emit_navigation(app: &AppHandle, label: &str, action: Value) -> Result<(), String> {
    let event = crate::window_registry::navigation_event(&action)?;
    if action["type"] == "transfer-draft" {
        // Hold the ledger through emission so navigation/Host changes cannot race binding.
        let state = app.state::<DesktopState>();
        let windows = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        let mut transfers = state
            .draft_transfers
            .lock()
            .map_err(|_| "Draft broker unavailable")?;
        let id = string(&action, "transferId")?;
        let detail = match transfers.delivery(&windows, label, &id) {
            Ok(Some(detail)) => detail,
            Ok(None) => return Ok(()), // Expired queued IDs never disclose a draft.
            Err(error) => {
                transfers.cancel(&id, &error);
                return Err(error);
            }
        };
        let result = native(app.emit_to(
            tauri::EventTarget::webview_window(label),
            "varin:emit",
            json!({"event":event,"detail":detail}),
        ));
        if let Err(error) = &result {
            transfers.cancel(&id, error);
        }
        return result;
    }
    native(app.emit_to(
        tauri::EventTarget::webview_window(label),
        "varin:emit",
        json!({"event":event,"detail":action}),
    ))
}
#[tauri::command]
async fn varin_renderer_ready(
    app: AppHandle,
    webview: Webview,
    state: State<'_, DesktopState>,
    document_nonce: String,
) -> Reply {
    state.authorize(&webview)?;
    let queued = {
        let mut windows = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        let window = windows.get_mut(webview.label()).ok_or("Window is closed")?;
        if window.document_nonce != document_nonce {
            return Err("The original application document was replaced".into());
        }
        window.renderer_ready = true;
        std::mem::take(&mut window.navigation)
    };
    let mut failure = None;
    for action in queued {
        if let Err(error) = emit_navigation(&app, webview.label(), action) {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(Value::Null), Err)
}
#[tauri::command]
async fn varin_runtime_changed(
    app: AppHandle,
    webview: Webview,
    state: State<'_, DesktopState>,
    document_nonce: String,
    config: Value,
) -> Reply {
    state.authorize(&webview)?;
    let api = config["apiBaseUrl"]
        .as_str()
        .ok_or("Runtime endpoint is missing")?;
    if !api.is_empty() {
        external_url(&json!(api))?;
    }
    let token = config["clientToken"].as_str().unwrap_or("");
    let relay = config["relayHostId"].as_str().unwrap_or("");
    let headers = config["requestHeaders"]
        .as_object()
        .ok_or("Runtime headers are invalid")?;
    if token.len() > 65536
        || relay.len() > 8192
        || headers.len() > 128
        || headers.iter().any(|(key, value)| {
            key.len() > 1024
                || key.bytes().any(|b| b <= 32 || b >= 127)
                || value
                    .as_str()
                    .is_none_or(|value| value.len() > 65536 || value.contains(['\r', '\n', '\0']))
        })
    {
        return Err("Runtime connection is invalid".into());
    }
    {
        let mut windows = state
            .windows
            .lock()
            .map_err(|_| "Window registry unavailable")?;
        let record = windows.get_mut(webview.label()).ok_or("Window is closed")?;
        if record.document_nonce != document_nonce {
            return Err("The original application document was replaced".into());
        }
        let bootstrap = record
            .bootstrap
            .as_mut()
            .ok_or("Window bootstrap is not ready")?;
        bootstrap["apiBaseUrl"] = json!(api);
        bootstrap["clientToken"] = json!(token);
        bootstrap["requestHeaders"] = json!(headers);
        bootstrap["relayHostId"] = json!(relay);
        if webview.label() == "main" {
            let remote = (!api.is_empty() && bootstrap["localOrigin"].as_str() != Some(api))
                || !relay.is_empty();
            if let Ok(mut background) = state.background.lock() {
                *background = remote.then(|| bootstrap.clone());
            }
        }
        state
            .draft_transfers
            .lock()
            .map_err(|_| "Draft broker unavailable")?
            .reconcile(&windows);
    }
    refresh_desktop_state(&app);
    Ok(Value::Null)
}

fn queue_deep_links(app: &AppHandle, urls: Vec<String>, source: &str) {
    let state = app.state::<DesktopState>();
    for raw in urls {
        if let Some(request) = &state.smoke {
            if raw == format!("varin://smoke/{}", request.nonce) {
                let temporary = request.data_dir.join(".smoke-protocol-activation.tmp");
                let receipt = json!({"schema":1,"nonce":request.nonce,"pid":std::process::id(),"source":source});
                if serde_json::to_vec(&receipt)
                    .ok()
                    .is_some_and(|bytes| std::fs::write(&temporary, bytes).is_ok())
                {
                    let _ = std::fs::rename(
                        temporary,
                        request.data_dir.join("smoke-protocol-activation.json"),
                    );
                }
                continue;
            }
        }
        if raw.len() > 65536 || !raw.starts_with("varin://") {
            continue;
        }
        if state.deep_links.try_send(raw).is_err() {
            eprintln!("Varin deep link queue is full or closed");
        }
    }
}
fn start_deep_link_owner(app: &AppHandle, mut requests: tokio::sync::mpsc::Receiver<String>) {
    let app = app.clone();
    let mut ready = app.state::<DesktopState>().boot.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            if ready.borrow_and_update().is_some() {
                break;
            }
            if ready.changed().await.is_err() {
                return;
            }
        }
        while let Some(url) = requests.recv().await {
            if app.state::<DesktopState>().quitting.load(Ordering::Acquire) {
                return;
            }
            let result:Result<(),String>=async{
                let service=browser_service(&app).await?;
                let action=service.process.request("desktopPlatformInvoke",json!({"command":"native_deep_link","args":{"url":url}})).await?;
                if action.is_null(){return Ok(())}
                let bootstrap=bootstrap_for_host(&app,action["hostId"].as_str()).await?;
                if action["type"]=="thread" {
                    let thread=string(&action,"threadId")?;let branch=string(&action,"branchId")?;
                    native_presentation_action(&app,"main",bootstrap,json!({"type":"focus-thread","threadId":thread,"branchId":branch,"directory":action["directory"].as_str().unwrap_or("")}));
                }else if action["type"]=="host" {
                    let key=crate::native_presentation::runtime_key(&bootstrap);
                    let existing=app.state::<DesktopState>().windows.lock().map_err(|_|"Window registry unavailable")?.iter().find(|(label,window)|(label.as_str()=="main"||label.starts_with("workbench-"))&&window.bootstrap.as_ref().is_some_and(|candidate|crate::native_presentation::runtime_key(candidate)==key)).map(|(label,_)|label.clone());
                    if let Some(window)=existing.and_then(|label|app.get_webview_window(&label)){native(window.show())?;native(window.unminimize())?;native(window.set_focus())?;}
                    else {let id=app.state::<DesktopState>().sequence.fetch_add(1,Ordering::Relaxed);create_window(&app,&format!("workbench-{id}"),"main",Some(bootstrap),None)?;}
                }
                Ok(())
            }.await;
            if result.is_err() {
                crate::dialogs::inform(
                    &app,
                    "Connection link",
                    "Varin could not open this connection link. Existing connections and credentials were retained.",
                );
            }
        }
    });
}
async fn bootstrap_for_host(app: &AppHandle, host_id: Option<&str>) -> Reply {
    let state = app.state::<DesktopState>();
    let mut bootstrap = state.bootstrap("main").await.or_else(|_| {
        state
            .background
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .map(Ok)
            .unwrap_or_else(|| {
                state
                    .boot
                    .borrow()
                    .clone()
                    .unwrap_or_else(|| Err("Desktop is not ready".into()))
            })
    })?;
    let Some(host_id) = host_id else {
        return Ok(bootstrap);
    };
    if host_id == "local" {
        let ready = state
            .host
            .lock()
            .await
            .as_ref()
            .map(HostProcess::snapshot)
            .filter(|host| host.phase == HostPhase::Ready)
            .ok_or("Local Host is unavailable")?;
        bootstrap["apiBaseUrl"] = json!(ready.origin.ok_or("Local Host origin is unavailable")?);
        bootstrap["clientToken"] = json!(
            ready
                .client_token
                .ok_or("Local Host credential is unavailable")?
        );
        bootstrap["requestHeaders"] = json!({});
        bootstrap["relayHostId"] = json!("");
        bootstrap["bootOutcome"] = json!({"target":"local","status":"ok","localAvailable":true});
    } else {
        let config = state.setting("desktop_hosts_get", json!({})).await?;
        let host = config["hosts"]
            .as_array()
            .and_then(|hosts| hosts.iter().find(|host| host["id"] == host_id))
            .ok_or("Saved Host no longer exists")?;
        let relay = host["relay"].is_object();
        let url = host["apiUrl"]
            .as_str()
            .or_else(|| host["url"].as_str())
            .unwrap_or("");
        if !relay {
            external_url(&json!(url))?;
        }
        bootstrap["apiBaseUrl"] = json!(if relay { "" } else { url });
        bootstrap["clientToken"] = json!(host["clientToken"].as_str().unwrap_or(""));
        bootstrap["requestHeaders"] = host["requestHeaders"]
            .as_object()
            .map(|headers| json!(headers))
            .unwrap_or(json!({}));
        bootstrap["relayHostId"] = json!(if relay { host_id } else { "" });
        bootstrap["bootOutcome"] = json!({"target":"remote","status":"ok","hostId":host_id,"url":host["url"],"localAvailable":!bootstrap["localOrigin"].as_str().unwrap_or("").is_empty()});
    }
    bootstrap["windowRole"] = json!("main");
    Ok(bootstrap)
}
pub(crate) async fn confirm_deep_link(app: &AppHandle, args: Value) -> Reply {
    let url = external_url(&args["serverUrl"])?;
    if url.as_str().len() > 8192 {
        return Err("Connection target is too long".into());
    }
    let mut targets = vec![url.to_string()];
    if let Some(candidates) = args["candidateUrls"].as_array() {
        if candidates.len() > 16 {
            return Err("Too many connection targets".into());
        }
        for candidate in candidates {
            let candidate = external_url(candidate)?;
            if candidate.as_str().len() > 8192 {
                return Err("Connection target is too long".into());
            }
            if !targets.iter().any(|target| target == candidate.as_str()) {
                targets.push(candidate.to_string());
            }
        }
    }
    let label = args["label"]
        .as_str()
        .unwrap_or("Varin Host")
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>();
    let locale = app.state::<crate::native_menu::NativeMenus>().locale();
    let message=format!("{}\n\n{}",crate::native_presentation::text(&locale,"Connect to “{label}”?").replace("{label}",&label),crate::native_presentation::text(&locale,"This will add {url} as a remote instance and route this app’s activity through it. Only continue if you trust this server and started the connection yourself.").replace("{url}",&targets.join("\n")));
    Ok(json!(
        crate::dialogs::confirm(
            app,
            Some("main"),
            "Connect to Varin server?",
            message,
            "Connect",
            "Cancel"
        )
        .await
    ))
}
