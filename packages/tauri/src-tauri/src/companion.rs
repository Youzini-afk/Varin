//! Native surfaces only. Shared TypeScript owns artwork, scene chronology,
//! gesture policy and settings; inert surfaces never acquire the desktop bridge.
use crate::geometry;
use crate::{desktop, engine::offscreen, host::HostProcess};
use geometry::{Display, Rect};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    io::Read,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_runtime_cef::{
    AsCefWebviewAttributes, DevToolsProtocol, FrameEventKind, WebviewCefExt,
    WebviewWindowBuilderCefExt, allocate_devtools_message_id,
};
use tokio::sync::{oneshot, watch};
type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>;
#[derive(Clone)]
struct Surface {
    window: WebviewWindow,
    role: String,
    pack: String,
    version: String,
    pending: Pending,
    closed: watch::Receiver<bool>,
    revision: Arc<AtomicU64>,
}
#[derive(Clone)]
pub struct CompanionWindows {
    app: AppHandle,
    service: HostProcess,
    data_dir: PathBuf,
    surfaces: Arc<Mutex<HashMap<u64, Surface>>>,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    lifecycle: Arc<tokio::sync::RwLock<()>>,
    stopping: Arc<AtomicBool>,
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}
fn native<T>(r: tauri::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}
fn rect(v: &Value) -> Result<(f64, f64, f64, f64), String> {
    let mut out = [0.; 4];
    for (i, key) in ["x", "y", "width", "height"].iter().enumerate() {
        out[i] = v[key]
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or("Invalid companion geometry")?;
    }
    if out[2] <= 0. || out[3] <= 0. {
        return Err("Invalid companion dimensions".into());
    }
    Ok((out[0], out[1], out[2], out[3]))
}
fn monitor_id(m: &tauri::Monitor) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    if let Some(name) = m.name() {
        name.hash(&mut h);
    } else {
        m.position().x.hash(&mut h);
        m.position().y.hash(&mut h);
    }
    h.finish() & ((1u64 << 53) - 1)
}
fn app_url(url: &url::Url) -> bool {
    crate::security::application_origin(url)
}
impl CompanionWindows {
    pub fn new(
        app: AppHandle,
        service: HostProcess,
        data_dir: PathBuf,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Self {
        let owner = Self {
            app: app.clone(),
            service,
            data_dir,
            surfaces: Arc::default(),
            emit,
            lifecycle: Arc::default(),
            stopping: Arc::default(),
        };
        app.manage(owner.clone());
        owner
    }
    /// An exited Node owner cannot send its final window closes. Native lifetime
    /// remains here until CEF confirms each original browser is actually gone.
    pub async fn shutdown(&self) -> Result<(), String> {
        // A create that has begun owns its eventual CEF surface, even while
        // bootstrap/build is pending. Drain it before taking the close snapshot.
        let _lifecycle = self.lifecycle.write().await;
        self.stopping.store(true, Ordering::Release);
        let ids: Vec<_> = self
            .surfaces
            .lock()
            .map_err(|_| "Companion registry unavailable")?
            .keys()
            .copied()
            .collect();
        let mut closing = tokio::task::JoinSet::new();
        for id in ids {
            let owner = self.clone();
            closing.spawn(async move { owner.request("companion.close", json!({"id":id})).await });
        }
        let mut failed = false;
        while let Some(result) = closing.join_next().await {
            if !matches!(result, Ok(Ok(_))) {
                failed = true;
            }
        }
        if failed {
            return Err(
                "Companion shutdown was not confirmed; original native surfaces remain owned"
                    .into(),
            );
        }
        let ours = self
            .app
            .try_state::<Self>()
            .is_some_and(|current| Arc::ptr_eq(&current.surfaces, &self.surfaces));
        if ours {
            self.app.unmanage::<Self>();
        }
        Ok(())
    }
    fn event(&self, value: Value) {
        (self.emit)(value);
    }
    pub(crate) fn benchmark_sessions(&self) -> Vec<(String, crate::cdp::Session)> {
        self.surfaces
            .lock()
            .map(|surfaces| {
                surfaces
                    .iter()
                    .filter(|(_, surface)| !*surface.closed.borrow())
                    .map(|(id, surface)| {
                        (
                            format!("companion:{}:{id}", surface.role),
                            crate::cdp::Session::from_owned(
                                surface.window.as_ref().clone(),
                                surface.pending.clone(),
                            ),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn surface(&self, id: u64) -> Result<Surface, String> {
        self.surfaces
            .lock()
            .map_err(|_| "Companion registry unavailable")?
            .get(&id)
            .cloned()
            .ok_or("Companion window is closed".into())
    }
    fn displays(&self) -> Result<(Vec<Display>, u64), String> {
        let monitors = native(self.app.available_monitors())?;
        let primary =
            native(self.app.primary_monitor())?.ok_or("No native display is available")?;
        let primary = monitor_id(&primary);
        let displays = monitors
            .iter()
            .map(|m| {
                let p = m.position();
                let s = m.size();
                let a = m.work_area();
                Display::new(
                    monitor_id(m),
                    Rect {
                        x: p.x as f64,
                        y: p.y as f64,
                        width: s.width as f64,
                        height: s.height as f64,
                    },
                    Rect {
                        x: a.position.x as f64,
                        y: a.position.y as f64,
                        width: a.size.width as f64,
                        height: a.size.height as f64,
                    },
                    m.scale_factor(),
                )
            })
            .collect();
        Ok((
            geometry::layout(displays, primary, cfg!(target_os = "windows")),
            primary,
        ))
    }
    fn state(&self, id: u64, surface: &Surface) -> Reply {
        let window = &surface.window;
        let (displays, _) = self.displays()?;
        let position = native(window.outer_position())?;
        let size = native(window.outer_size())?;
        let display = geometry::nearest(
            &displays,
            Rect {
                x: position.x as f64,
                y: position.y as f64,
                width: size.width as f64,
                height: size.height as f64,
            },
            true,
        )
        .ok_or("Companion display unavailable")?;
        let (x, y) = display.to_logical(position.x as f64, position.y as f64);
        let content = native(window.inner_position())?;
        let inner = native(window.inner_size())?;
        let (cx, cy) = display.to_logical(content.x as f64, content.y as f64);
        let scale = display.scale;
        Ok(
            json!({"id":id,"revision":surface.revision.fetch_add(1,Ordering::Relaxed)+1,"label":window.label(),"bounds":{"x":x,"y":y,"width":size.width as f64/scale,"height":size.height as f64/scale},
            "contentBounds":{"x":cx,"y":cy,"width":inner.width as f64/scale,"height":inner.height as f64/scale},"visible":native(window.is_visible())?,"minimized":native(window.is_minimized())?,"alwaysOnTop":native(window.is_always_on_top())?,"destroyed":*surface.closed.borrow()}),
        )
    }
    fn set_bounds(&self, window: &WebviewWindow, value: &Value) -> Result<(), String> {
        let (x, y, width, height) = rect(value)?;
        let (displays, _) = self.displays()?;
        let display = geometry::nearest(
            &displays,
            Rect {
                x,
                y,
                width,
                height,
            },
            false,
        )
        .ok_or("Companion display unavailable")?;
        let (px, py) = display.to_physical(x, y);
        native(window.set_position(tauri::PhysicalPosition::new(
            px.round() as i32,
            py.round() as i32,
        )))?;
        native(window.set_size(tauri::PhysicalSize::new(
            (width * display.scale).round() as u32,
            (height * display.scale).round() as u32,
        )))?;
        Ok(())
    }
    fn snapshot(&self) -> Reply {
        let surfaces = self
            .surfaces
            .lock()
            .map_err(|_| "Companion registry unavailable")?
            .clone();
        let (displays, primary) = self.displays()?;
        let cursor = native(self.app.cursor_position())?;
        let display = geometry::nearest(
            &displays,
            Rect {
                x: cursor.x,
                y: cursor.y,
                width: 0.,
                height: 0.,
            },
            true,
        )
        .ok_or("Companion display unavailable")?;
        let (x, y) = display.to_logical(cursor.x, cursor.y);
        let screens: Vec<_> = displays
            .iter()
            .map(|d| {
                let a = d.work_area();
                json!({"id":d.id,"workArea":{"x":a.x,"y":a.y,"width":a.width,"height":a.height}})
            })
            .collect();
        let windows = surfaces
            .iter()
            .map(|(id, s)| self.state(*id, s))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(
            json!({"windows":windows,"displays":screens,"primaryId":primary,"cursor":{"x":x,"y":y},"platform":crate::manifest::platform()}),
        )
    }
    pub async fn request(&self, method: &str, args: Value) -> Reply {
        if method == "companion.snapshot" {
            return self.snapshot();
        }
        let id = args["id"]
            .as_u64()
            .filter(|id| *id > 0 && *id < (1 << 53))
            .ok_or("Invalid companion window identity")?;
        if method == "companion.create" {
            return self.create(id, args).await;
        }
        let surface = match self.surface(id) {
            Ok(s) => s,
            Err(_) if method == "companion.close" => return Ok(Value::Null),
            Err(e) => return Err(e),
        };
        match method {
            "companion.update" => {
                if !args["bounds"].is_null() {
                    self.set_bounds(&surface.window, &args["bounds"])?;
                }
                if let Some(value) = args["alwaysOnTop"].as_bool() {
                    native(surface.window.set_always_on_top(value))?;
                }
                if let Some(value) = args["passthrough"].as_bool() {
                    offscreen::set_passthrough(&surface.window, value).await?;
                }
                if let Some(value) = args["visible"].as_bool() {
                    if value {
                        native(surface.window.show())?
                    } else {
                        native(surface.window.hide())?
                    }
                }
                self.state(id, &surface)
            }
            "companion.close" => {
                Self::close_surface(&surface).await?;
                self.surfaces
                    .lock()
                    .map_err(|_| "Companion registry unavailable")?
                    .remove(&id);
                Ok(Value::Null)
            }
            "companion.ready" => {
                let (attribute, event) = match surface.role.as_str() {
                    "scene" => ("varinCompanionSceneReady", "varin-companion-scene-ready"),
                    "stool" => ("varinCompanionStoolReady", "varin-companion-stool-ready"),
                    _ => {
                        return Err(
                            "Character readiness belongs to its first painted artwork frame".into(),
                        );
                    }
                };
                let source = format!(
                    "new Promise((resolve,reject)=>{{if(document.documentElement.dataset.{attribute}==='true'){{resolve(true);return}} const ready=()=>{{clearTimeout(timer);resolve(true)}};const timer=setTimeout(()=>{{removeEventListener('{event}',ready);reject(new Error('Decorative mount timed out'))}},15000);addEventListener('{event}',ready,{{once:true}})}})"
                );
                Self::evaluate(&surface, &source).await?;
                Ok(Value::Null)
            }
            "companion.publish" => {
                if surface.role != "scene" {
                    return Err("Only a decorative scene receives scene facts".into());
                }
                Self::evaluate(&surface,&format!("window.dispatchEvent(new CustomEvent('varin-companion-scene',{{detail:{}}}))",serde_json::to_string(&args["payload"]).map_err(|_|"Scene facts are invalid")?)).await?;
                Ok(Value::Null)
            }
            "companion.stoolVisible" => {
                if surface.role != "stool" {
                    return Err("Only a world stool receives this event".into());
                }
                native(surface.window.show())?;
                Self::evaluate(
                    &surface,
                    "window.dispatchEvent(new Event('varin-stool-visible'))",
                )
                .await?;
                Ok(Value::Null)
            }
            _ => Err("Unknown native companion operation".into()),
        }
    }
    async fn create(&self, id: u64, args: Value) -> Reply {
        let _lifecycle = self.lifecycle.read().await;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Companion native owner is stopping".into());
        }
        if self
            .surfaces
            .lock()
            .map_err(|_| "Companion registry unavailable")?
            .contains_key(&id)
        {
            return Err("Companion window identity is already in use".into());
        }
        let role = required(&args, "role")?.to_owned();
        if !matches!(role.as_str(), "companion" | "scene" | "stool") {
            return Err("Invalid companion role".into());
        }
        let pack = required(&args["pack"], "id")?.to_owned();
        let version = required(&args["pack"], "version")?.to_owned();
        if pack.is_empty()
            || !pack
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            || version.len() != 64
            || !version
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("Invalid companion artwork generation".into());
        }
        let bootstrap = if role == "companion" {
            let mut value = desktop::bootstrap_for_window(&self.app, "main").await?;
            value["windowRole"] = json!("companion");
            Some(value)
        } else {
            None
        };
        let (x, y, w, h) = rect(&args["bounds"])?;
        let label = format!("companion-{id}");
        // CEF maps every registered scheme to HTTP on every desktop platform.
        let base = "http://varin-companion.localhost";
        let query = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query
                .append_pair("companionPack", &pack)
                .append_pair("companionVersion", &version)
                .append_pair("companionAssetOrigin", base);
            if role == "scene" {
                query.append_pair("scene", "1");
            }
            if role == "stool" {
                let phase = required(&args, "phase")?;
                if !matches!(phase, "lift" | "landing") {
                    return Err("Invalid stool phase".into());
                }
                query.append_pair("stool", phase);
            }
            query.finish()
        };
        let mut builder = WebviewWindowBuilder::new(
            &self.app,
            &label,
            WebviewUrl::App(format!("companion.html?{}", query).into()),
        )
        .title("Varin")
        .data_directory(self.data_dir.join("cef/application"))
        .inner_size(w, h)
        .position(x, y)
        .visible(false)
        .focused(false)
        .focusable(role == "companion")
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(app_url);
        if role == "scene" {
            let parent =
                self.surface(args["ownerId"].as_u64().ok_or("Scene owner is required")?)?;
            builder = native(builder.parent(&parent.window))?;
        }
        if role == "companion" {
            builder = builder.min_inner_size(240., 300.);
        }
        let pending: Pending = Arc::default();
        let (close_send, closed) = watch::channel(false);
        let close_owner = self.clone();
        let close_pending = pending.clone();
        let close_label = label.clone();
        let attrs = builder
            .runtime_specific_attributes_mut()
            .as_cef_webview_attributes_mut()
            .ok_or("Companion requires the bundled CEF runtime")?;
        attrs.native_only = role != "companion";
        attrs.native_close_handler = Some(Arc::new(move || {
            desktop::unregister_application_window(&close_owner.app, &close_label);
            close_send.send_replace(true);
            for (_, request) in close_pending.lock().unwrap().drain() {
                let _ = request.send(Err(
                    "Companion closed before its response; outcome is unknown".into(),
                ));
            }
            if let Ok(mut surfaces) = close_owner.surfaces.lock() {
                surfaces.remove(&id);
            }
            close_owner.event(json!({"id":id,"kind":"closed"}));
        }));
        let renderer_owner = self.clone();
        let renderer_pending = pending.clone();
        builder = builder.on_frame_event(move |event| {
            if matches!(event.kind, FrameEventKind::RendererTerminated) {
                for (_, request) in renderer_pending.lock().unwrap().drain() {
                    let _ =
                        request.send(Err("Companion renderer stopped; outcome is unknown".into()));
                }
                renderer_owner.event(json!({"id":id,"kind":"crashed"}));
            }
        });
        builder = offscreen::transparent(builder, &label)?;
        // Authorization must be registered before CEF starts the application
        // document; build returns a placeholder before its first navigation.
        if role == "companion" {
            desktop::register_application_window(&self.app, &label, "companion", bootstrap)?;
        }
        let window = match builder.build() {
            Ok(window) => window,
            Err(error) => {
                desktop::unregister_application_window(&self.app, &label);
                return Err(error.to_string());
            }
        };
        let surface = Surface {
            window: window.clone(),
            role: role.clone(),
            pack,
            version,
            pending: pending.clone(),
            closed,
            revision: Arc::new(AtomicU64::new(0)),
        };
        if *surface.closed.borrow() {
            return Err("Companion closed during creation".into());
        }
        self.surfaces
            .lock()
            .map_err(|_| "Companion registry unavailable")?
            .insert(id, surface.clone());
        let initialize = (|| -> Result<(), String> {
            self.set_bounds(&window, &args["bounds"])?;
            native(window.on_dev_tools_protocol(move |message| {
                if let DevToolsProtocol::Message(bytes) = message {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        if let Some(id) = value["id"].as_i64().and_then(|id| i32::try_from(id).ok())
                        {
                            if let Some(reply) = pending.lock().unwrap().remove(&id) {
                                let result = if value["error"].is_object() {
                                    Err("Companion renderer operation failed".into())
                                } else {
                                    Ok(value["result"].clone())
                                };
                                let _ = reply.send(result);
                            }
                        }
                    }
                }
            }))?;
            if role != "companion" {
                native(window.set_ignore_cursor_events(true))?;
                if let Some(owner) = args["ownerId"]
                    .as_u64()
                    .and_then(|id| self.surface(id).ok())
                {
                    native(window.set_always_on_top(native(owner.window.is_always_on_top())?))?;
                }
            }
            Ok(())
        })();
        if let Err(error) = initialize {
            // Do not lose ownership of a half-created native surface. Cleanup
            // still waits for CEF, and a failed close leaves it in the registry.
            Self::close_surface(&surface).await?;
            return Err(error);
        }
        let observer = self.clone();
        window.on_window_event(move|event|{match event{
            WindowEvent::Moved(_)|WindowEvent::Resized(_)|WindowEvent::Focused(_)=>{if let Ok(surface)=observer.surface(id){if let Ok(state)=observer.state(id,&surface){observer.event(json!({"id":id,"kind":"state","state":state,"blur":matches!(event,WindowEvent::Focused(false))}));}}}
            WindowEvent::ScaleFactorChanged{..}=>observer.event(json!({"kind":"displays"})),_=>{}
        }});
        self.state(id, &surface)
    }
    async fn close_surface(surface: &Surface) -> Result<(), String> {
        let mut closed = surface.closed.clone();
        if !*closed.borrow() {
            native(surface.window.close())?;
            while !*closed.borrow_and_update() {
                closed
                    .changed()
                    .await
                    .map_err(|_| "Companion close outcome is unknown")?;
            }
        }
        Ok(())
    }
    async fn evaluate(surface: &Surface, source: &str) -> Reply {
        let id = allocate_devtools_message_id().map_err(|e| e.to_string())?;
        let (send, receive) = oneshot::channel();
        surface
            .pending
            .lock()
            .map_err(|_| "Companion renderer unavailable")?
            .insert(id, send);
        let message = json!({"id":id,"method":"Runtime.evaluate","params":{"expression":source,"awaitPromise":true,"returnByValue":true}});
        if surface
            .window
            .send_dev_tools_message(
                &serde_json::to_vec(&message).map_err(|_| "Companion request invalid")?,
            )
            .is_err()
        {
            surface.pending.lock().unwrap().remove(&id);
            return Err("Companion dispatch could not be observed; outcome is unknown".into());
        }
        let result = receive
            .await
            .map_err(|_| "Companion renderer response was lost; outcome is unknown")??;
        if result["exceptionDetails"].is_object() {
            return Err("Companion decorative renderer is unavailable".into());
        }
        Ok(result)
    }
    async fn asset(
        &self,
        label: String,
        request_path: String,
    ) -> Result<(Vec<u8>, String), String> {
        let surface = self
            .surfaces
            .lock()
            .map_err(|_| "Companion registry unavailable")?
            .values()
            .find(|s| s.window.label() == label)
            .cloned()
            .ok_or("No companion artwork authority")?;
        let prefix = format!("/{}/{}/", surface.pack, surface.version);
        let name = request_path
            .strip_prefix(&prefix)
            .ok_or("Artwork belongs to another generation")?;
        if name.is_empty() || name.contains(['/', '\\', '%']) {
            return Err("Invalid artwork filename".into());
        }
        let receipt = self
            .service
            .request(
                "companionAsset",
                json!({"path":format!("{}/{}/{}",surface.pack,surface.version,name)}),
            )
            .await?;
        let file = PathBuf::from(required(&receipt, "file")?);
        let root = self.data_dir.join("companions/packs").join(&surface.pack);
        tokio::task::spawn_blocking(move || {
            let root = root
                .canonicalize()
                .map_err(|_| "Artwork cache unavailable")?;
            if file.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&root)
                || std::fs::symlink_metadata(&file)
                    .map_err(|_| "Artwork unavailable")?
                    .file_type()
                    .is_symlink()
            {
                return Err("Artwork escaped its verified cache".into());
            }
            let expected = receipt["size"]
                .as_u64()
                .ok_or("Artwork length is invalid")?;
            let input = std::fs::File::open(file).map_err(|_| "Artwork could not be read")?;
            if input
                .metadata()
                .map_err(|_| "Artwork metadata unavailable")?
                .len()
                != expected
            {
                return Err("Artwork length changed before delivery".into());
            }
            let mut bytes = Vec::new();
            input
                .take(expected.checked_add(1).ok_or("Artwork length is invalid")?)
                .read_to_end(&mut bytes)
                .map_err(|_| "Artwork could not be read")?;
            if receipt["size"].as_u64() != Some(bytes.len() as u64)
                || receipt["sha256"] != format!("{:x}", Sha256::digest(&bytes))
            {
                return Err("Artwork changed before delivery".into());
            }
            let mime = required(&receipt, "mime")?;
            if !matches!(mime, "image/png" | "application/json") {
                return Err("Artwork content type is not inert".into());
            }
            Ok((bytes, mime.into()))
        })
        .await
        .map_err(|_| "Artwork worker stopped")?
    }
}
/** Only a pinned companion surface can fetch its verified, catalog-owned files. */
pub fn register_asset_protocol(builder: tauri::Builder) -> tauri::Builder {
    builder.register_asynchronous_uri_scheme_protocol(
        "varin-companion",
        |context, request, responder| {
            let app = context.app_handle().clone();
            let label = context.webview_label().to_owned();
            let path = request.uri().path().to_owned();
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            tauri::async_runtime::spawn(async move {
                let result = if let Some(owner) = app.try_state::<CompanionWindows>() {
                    owner.asset(label, path).await
                } else {
                    Err("Companion service unavailable".into())
                };
                let response = match result {
                    Ok((bytes, mime)) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", origin)
                        .header("Cache-Control", "no-store")
                        .header("X-Content-Type-Options", "nosniff")
                        .body(bytes),
                    Err(_) => tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new()),
                };
                if let Ok(response) = response {
                    responder.respond(response);
                }
            });
        },
    )
}
