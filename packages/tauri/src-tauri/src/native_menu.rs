//! Native menus and tray are presentation only. Trusted window bootstraps travel
//! separately from renderer snapshots and are never included in public events.
use crate::native_presentation::{self as policy, IconState, TrayPresentation, TrayRow};
pub use policy::text;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{
    AppHandle, Manager, WebviewWindow,
    image::Image,
    menu::{ContextMenu, IconMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_runtime_cef::{
    WebviewCefExt,
    cef::{ImplBrowser, ImplFrame},
};

#[derive(Clone)]
struct Source {
    label: String,
    bootstrap: Value,
    snapshot: Value,
}
#[derive(Clone)]
struct Action {
    source: Arc<Source>,
    payload: Value,
}
#[derive(Default)]
struct Presentation {
    locale: String,
    tray_enabled: bool,
    menu: Option<Menu<tauri::DynRuntime>>,
    sources: HashMap<String, Arc<Source>>,
    focused: Option<String>,
    popup_target: Option<String>,
    active: Option<Arc<Source>>,
    rendered: Option<TrayPresentation>,
    actions: HashMap<String, Action>,
    generation: u64,
    animation: Option<tauri::async_runtime::JoinHandle<()>>,
    animation_epoch: u64,
}
impl Drop for Presentation {
    fn drop(&mut self) {
        if let Some(animation) = self.animation.take() {
            animation.abort();
        }
    }
}
pub struct NativeMenus {
    state: Mutex<Presentation>,
}
impl NativeMenus {
    pub fn new() -> Self {
        let mut state = Presentation::default();
        state.locale = "en".into();
        Self {
            state: Mutex::new(state),
        }
    }
    pub fn locale(&self) -> String {
        self.state
            .lock()
            .map(|state| state.locale.clone())
            .unwrap_or_else(|_| "en".into())
    }
    /// Actual native tray existence, not the user's requested preference.
    pub fn tray_enabled(&self) -> bool {
        self.state.lock().is_ok_and(|state| state.tray_enabled)
    }
    pub fn install(&self, app: &AppHandle, locale: &str) -> Result<(), String> {
        let locale = policy::normalize_locale(locale).to_owned();
        let handle = app.clone();
        app.run_on_main_thread_blocking(move || {
            let menu = application_menu(&handle, &locale)?;
            handle.set_menu(menu.clone()).map_err(error)?;
            if !cfg!(target_os = "macos") {
                for window in handle.windows().values() {
                    let _ = window.hide_menu();
                }
            }
            let owner = handle.state::<Self>();
            let mut state = owner.state.lock().map_err(|_| "Native menus unavailable")?;
            state.locale = locale;
            state.menu = Some(menu);
            state.rendered = None;
            render_tray(&handle, &mut state)
        })
        .map_err(error)?
    }
    pub fn popup(&self, window: &WebviewWindow, args: &Value) -> Result<(), String> {
        let menu = {
            let mut state = self.state.lock().map_err(|_| "Native menus unavailable")?;
            state.popup_target = Some(window.label().into());
            state
                .menu
                .clone()
                .ok_or("Application menu is still preparing")?
        };
        if let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) {
            if !x.is_finite() || !y.is_finite() {
                return Err("Menu position is invalid".into());
            }
            menu.popup_at(
                window.as_ref().window(),
                tauri::LogicalPosition::new(x.max(0.).round(), y.max(0.).round()),
            )
            .map_err(error)
        } else {
            menu.popup(window.as_ref().window()).map_err(error)
        }
    }
    pub fn menu_target(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.popup_target.clone().or_else(|| s.focused.clone()))
    }
    /// Called only for registered conversation windows, not browsers or overlays.
    pub fn focus_window(&self, app: &AppHandle, label: &str) {
        let handle = app.clone();
        let label = label.to_owned();
        let _ = app.run_on_main_thread(move || {
            let owner = handle.state::<Self>();
            if let Ok(mut state) = owner.state.lock() {
                state.focused = Some(label.clone());
                state.popup_target = None;
                if let Some(source) = state.sources.get(&label).cloned() {
                    state.active = Some(source);
                    let _ = render_tray(&handle, &mut state);
                }
            }
        });
    }
    pub fn remove_window(&self, app: &AppHandle, label: &str) {
        let handle = app.clone();
        let label = label.to_owned();
        let _ = app.run_on_main_thread(move || {
            let owner = handle.state::<Self>();
            if let Ok(mut state) = owner.state.lock() {
                state.sources.remove(&label);
                if state.focused.as_deref() == Some(&label) {
                    state.focused = None;
                }
                if state.popup_target.as_deref() == Some(&label) {
                    state.popup_target = None;
                }
                if state
                    .active
                    .as_ref()
                    .is_some_and(|source| source.label == label)
                {
                    state.active = state
                        .sources
                        .get("main")
                        .cloned()
                        .or_else(|| state.sources.values().next().cloned());
                    let _ = render_tray(&handle, &mut state);
                }
            }
        });
    }
    pub fn tray(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        let handle = app.clone();
        app.run_on_main_thread_blocking(move || {
            let owner = handle.state::<Self>();
            let mut state = owner.state.lock().map_err(|_| "Native menus unavailable")?;
            if !enabled {
                stop_animation(&mut state);
                state.rendered = None;
                state.actions.clear();
                handle.remove_tray_by_id("varin");
                state.tray_enabled = false;
                return Ok(());
            }
            if handle.tray_by_id("varin").is_none() {
                state.tray_enabled = false;
                let assets = assets()?;
                TrayIconBuilder::with_id("varin")
                    .icon(assets.idle.clone())
                    .icon_as_template(cfg!(target_os = "macos"))
                    .tooltip("Varin")
                    .show_menu_on_left_click(cfg!(target_os = "macos"))
                    // Application-wide menu handler already receives tray menu events.
                    // Registering another here would dispatch every action twice.
                    .on_tray_icon_event(|tray, event| {
                        if matches!(
                            event,
                            TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            }
                        ) && !cfg!(target_os = "macos")
                        {
                            dispatch_window_action(
                                tray.app_handle(),
                                if cfg!(target_os = "linux") {
                                    "toggle-main-window"
                                } else {
                                    "show-main-window"
                                },
                            );
                        }
                    })
                    .build(&handle)
                    .map_err(error)?;
                state.rendered = None;
            }
            state.tray_enabled = true;
            render_tray(&handle, &mut state)
        })
        .map_err(error)?
    }
    pub fn update_tray(
        &self,
        app: &AppHandle,
        label: &str,
        snapshot: &Value,
        bootstrap: &Value,
    ) -> Result<(), String> {
        let source = Arc::new(Source {
            label: label.into(),
            bootstrap: bootstrap.clone(),
            snapshot: snapshot.clone(),
        });
        let handle = app.clone();
        app.run_on_main_thread_blocking(move || {
            let owner = handle.state::<Self>();
            let mut state = owner.state.lock().map_err(|_| "Native menus unavailable")?;
            if let Some(window) = handle.get_webview_window(&source.label) {
                let _ = window.set_badge_count(
                    policy::tray_presentation(&source.snapshot, &state.locale).badge,
                );
            }
            state.sources.insert(source.label.clone(), source.clone());
            // A background window's update must not replace the focused Host's menu.
            if state
                .focused
                .as_ref()
                .is_none_or(|focused| focused == &source.label)
                || state.active.is_none()
            {
                state.active = Some(source);
            }
            render_tray(&handle, &mut state)
        })
        .map_err(error)?
    }
    pub fn shutdown(&self, app: &AppHandle) {
        let _ = self.tray(app, false);
        if let Ok(mut state) = self.state.lock() {
            state.sources.clear();
            state.active = None;
        }
    }
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn application_menu(app: &AppHandle, locale: &str) -> Result<Menu<tauri::DynRuntime>, String> {
    let menu = Menu::new(app).map_err(error)?;
    let mac = cfg!(target_os = "macos");
    let app_menu = Submenu::new(app, "Varin", true).map_err(error)?;
    append(
        &app_menu,
        app,
        locale,
        &[
            ("about", "About Varin", None),
            ("updates", "Check for Updates", None),
            ("", "", None),
            ("settings", "Settings", Some("CmdOrCtrl+,")),
        ],
    )?;
    if !mac {
        append(
            &app_menu,
            app,
            locale,
            &[
                ("reload", "Reload Webview", None),
                ("restart", "Restart", None),
            ],
        )?;
    }
    append(
        &app_menu,
        app,
        locale,
        &[
            ("command-palette", "Command Palette", Some("CmdOrCtrl+P")),
            ("", "", None),
        ],
    )?;
    #[cfg(target_os = "macos")]
    {
        app_menu
            .append(
                &PredefinedMenuItem::services(app, Some(&text(locale, "Services")))
                    .map_err(error)?,
            )
            .map_err(error)?;
        separator(&app_menu, app)?;
        app_menu
            .append(
                &PredefinedMenuItem::hide(app, Some(&text(locale, "Hide Varin"))).map_err(error)?,
            )
            .map_err(error)?;
        app_menu
            .append(
                &PredefinedMenuItem::hide_others(app, Some(&text(locale, "Hide Others")))
                    .map_err(error)?,
            )
            .map_err(error)?;
        separator(&app_menu, app)?;
    }
    append(
        &app_menu,
        app,
        locale,
        &[("quit", "Quit Varin", Some("CmdOrCtrl+Q"))],
    )?;
    menu.append(&app_menu).map_err(error)?;
    let file = Submenu::new(app, text(locale, "File"), true).map_err(error)?;
    append(
        &file,
        app,
        locale,
        &[
            ("new-window", "New Window", Some("CmdOrCtrl+Shift+Alt+N")),
            ("", "", None),
            ("new-session", "New Session", Some("CmdOrCtrl+N")),
            (
                "new-worktree-session",
                "New Worktree",
                Some("CmdOrCtrl+Shift+N"),
            ),
            ("", "", None),
            ("change-workspace", "Add Workspace", None),
            ("", "", None),
        ],
    )?;
    append(
        &file,
        app,
        locale,
        &[if mac {
            ("close", "Close", Some("CmdOrCtrl+W"))
        } else {
            ("quit", "Quit Varin", Some("CmdOrCtrl+Q"))
        }],
    )?;
    menu.append(&file).map_err(error)?;
    let edit = Submenu::new(app, text(locale, "Edit"), true).map_err(error)?;
    append(
        &edit,
        app,
        locale,
        &[
            ("undo", "Undo", Some("CmdOrCtrl+Z")),
            (
                "redo",
                "Redo",
                Some(if mac { "CmdOrCtrl+Shift+Z" } else { "Ctrl+Y" }),
            ),
            ("", "", None),
            ("cut", "Cut", Some("CmdOrCtrl+X")),
            ("copy", "Copy", Some("CmdOrCtrl+C")),
            (
                "add-selection-to-chat",
                "Add Selection to Chat",
                if mac { Some("Super+L") } else { None },
            ),
            ("paste", "Paste", Some("CmdOrCtrl+V")),
            ("select-all", "Select All", Some("CmdOrCtrl+A")),
        ],
    )?;
    menu.append(&edit).map_err(error)?;
    let view = Submenu::new(app, text(locale, "View"), true).map_err(error)?;
    if !mac {
        append(
            &view,
            app,
            locale,
            &[
                ("reload", "Reload", Some("Ctrl+R")),
                ("force-reload", "Force Reload", Some("Ctrl+Shift+R")),
                ("devtools", "Toggle Developer Tools", Some("Ctrl+Alt+I")),
                ("", "", None),
            ],
        )?;
    }
    append(
        &view,
        app,
        locale,
        &[
            (
                "toggle-right-sidebar",
                "Toggle Right Sidebar",
                Some("CmdOrCtrl+B"),
            ),
            (
                "open-right-sidebar-git",
                "Open Git Sidebar",
                Some("CmdOrCtrl+Shift+G"),
            ),
            (
                "workspace-search",
                "Search Workspace",
                if mac { Some("Super+Shift+F") } else { None },
            ),
            ("", "", None),
            (
                "toggle-terminal",
                "Toggle Terminal Dock",
                Some("CmdOrCtrl+J"),
            ),
            (
                "toggle-terminal-expanded",
                "Toggle Terminal Expanded",
                Some("CmdOrCtrl+Shift+J"),
            ),
            ("", "", None),
            ("theme-light", "Light Theme", None),
            ("theme-dark", "Dark Theme", None),
            ("theme-system", "System Theme", None),
            ("", "", None),
            (
                "toggle-sidebar",
                "Toggle Session Sidebar",
                Some("CmdOrCtrl+Alt+L"),
            ),
            ("", "", None),
            (
                "fullscreen",
                "Toggle Full Screen",
                Some(if mac { "Ctrl+Super+F" } else { "F11" }),
            ),
        ],
    )?;
    menu.append(&view).map_err(error)?;
    if !mac {
        let go = Submenu::new(app, text(locale, "Go"), true).map_err(error)?;
        append(
            &go,
            app,
            locale,
            &[
                ("go-back", "Back", Some("Alt+Left")),
                ("go-forward", "Forward", Some("Alt+Right")),
                ("", "", None),
                ("previous-session", "Previous Session", Some("Alt+Up")),
                ("next-session", "Next Session", Some("Alt+Down")),
                ("", "", None),
                ("previous-project", "Previous Project", None),
                ("next-project", "Next Project", None),
            ],
        )?;
        menu.append(&go).map_err(error)?;
    }
    let window = Submenu::new(app, text(locale, "Window"), true).map_err(error)?;
    append(
        &window,
        app,
        locale,
        &[
            (
                "minimize",
                "Minimize",
                if mac { Some("Super+M") } else { None },
            ),
            if mac {
                ("maximize", "Zoom", None)
            } else {
                ("fullscreen", "Toggle Full Screen", Some("F11"))
            },
            ("", "", None),
            ("close", "Close", Some("CmdOrCtrl+W")),
        ],
    )?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp().map_err(error)?;
    menu.append(&window).map_err(error)?;
    let help = Submenu::new(app, text(locale, "Help"), true).map_err(error)?;
    append(
        &help,
        app,
        locale,
        &[
            (
                "help-dialog",
                "Keyboard Shortcuts",
                if mac { Some("Super+Shift+.") } else { None },
            ),
            (
                "show-diagnostics",
                "Show Diagnostics",
                if mac { Some("Super+Shift+O") } else { None },
            ),
        ],
    )?;
    if mac {
        append(
            &help,
            app,
            locale,
            &[(
                "devtools",
                "Toggle Developer Tools",
                Some("CmdOrCtrl+Alt+I"),
            )],
        )?;
    }
    append(
        &help,
        app,
        locale,
        &[
            ("", "", None),
            ("clear-cache", "Clear Cache", None),
            ("", "", None),
            ("report-bug", "Report a Bug", None),
            ("request-feature", "Request a Feature", None),
            ("", "", None),
            ("discord", "Join Discord", None),
        ],
    )?;
    #[cfg(target_os = "macos")]
    help.set_as_help_menu_for_nsapp().map_err(error)?;
    menu.append(&help).map_err(error)?;
    Ok(menu)
}
fn separator(menu: &Submenu<tauri::DynRuntime>, app: &AppHandle) -> Result<(), String> {
    menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
        .map_err(error)
}
fn append(
    menu: &Submenu<tauri::DynRuntime>,
    app: &AppHandle,
    locale: &str,
    items: &[(&str, &str, Option<&str>)],
) -> Result<(), String> {
    for (id, label, accelerator) in items {
        if id.is_empty() {
            separator(menu, app)?;
            continue;
        }
        let mut label = text(locale, label);
        if !cfg!(target_os = "macos") {
            // Electron registerAccelerator:false applies only on Windows/Linux.
            // A tab is the native menu shortcut column, without registering a
            // second handler for these renderer-owned keys.
            let display = match *id {
                "add-selection-to-chat" => Some("Ctrl+L"),
                "workspace-search" => Some("Ctrl+Shift+F"),
                "help-dialog" => Some("Ctrl+Shift+."),
                "show-diagnostics" => Some("Ctrl+Shift+O"),
                _ => None,
            };
            if let Some(display) = display {
                label.push('\t');
                label.push_str(display);
            }
        }
        menu.append(
            &MenuItem::with_id(app, format!("app:{id}"), label, true, *accelerator)
                .map_err(error)?,
        )
        .map_err(error)?;
    }
    Ok(())
}

struct Assets {
    idle: Image<'static>,
    unseen: Image<'static>,
    breath: Vec<Image<'static>>,
    status: HashMap<&'static str, Image<'static>>,
}
static ASSETS: OnceLock<Result<Arc<Assets>, String>> = OnceLock::new();
macro_rules! tray_asset {
    ($name:literal) => {
        include_bytes!(concat!("../../../electron/resources/icons/tray/", $name))
    };
}
pub(crate) const APPLICATION_ICON_PNG: &[u8] =
    include_bytes!("../../../electron/resources/icons/icon.png");

fn assets() -> Result<Arc<Assets>, String> {
    ASSETS
        .get_or_init(|| {
            let decode = |bytes: &[u8]| Image::from_bytes(bytes).map_err(error);
            #[cfg(target_os = "macos")]
            let (idle, unseen, breath) = (
                decode(tray_asset!("trayTemplate-idle@2x.png"))?,
                decode(tray_asset!("trayTemplate-unseen@2x.png"))?,
                vec![
                    decode(tray_asset!("trayTemplate-breath-00@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-01@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-02@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-03@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-04@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-05@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-06@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-07@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-08@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-09@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-10@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-11@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-12@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-13@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-14@2x.png"))?,
                    decode(tray_asset!("trayTemplate-breath-15@2x.png"))?,
                ],
            );
            #[cfg(not(target_os = "macos"))]
            let (idle, unseen, breath) = {
                // Match the original 22 px Linux panel icon and 32 px Windows icon. Area
                // integration preserves the shared app artwork, with no extra copy on disk.
                let image = resize_icon(
                    &decode(APPLICATION_ICON_PNG)?,
                    if cfg!(target_os = "linux") { 22 } else { 32 },
                );
                (image.clone(), image, Vec::new())
            };
            let mut status = HashMap::new();
            // The 2x artwork has the same logical 16 px size on macOS (set below).
            for (key, bytes) in [
                ("busy", tray_asset!("status/busy@2x.png").as_slice()),
                ("retry", tray_asset!("status/retry@2x.png").as_slice()),
                ("error", tray_asset!("status/error@2x.png").as_slice()),
                ("unseen", tray_asset!("status/unseen@2x.png").as_slice()),
                ("blank", tray_asset!("status/blank@2x.png").as_slice()),
            ] {
                let image = decode(bytes)?;
                status.insert(
                    key,
                    if cfg!(target_os = "macos") {
                        image
                    } else {
                        resize_icon(&image, 16)
                    },
                );
            }
            Ok(Arc::new(Assets {
                idle,
                unseen,
                breath,
                status,
            }))
        })
        .clone()
}
fn resize_icon(image: &Image<'_>, size: u32) -> Image<'static> {
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let source = image.rgba();
    for y in 0..size {
        for x in 0..size {
            let x0 = x as f64 * image.width() as f64 / size as f64;
            let x1 = (x + 1) as f64 * image.width() as f64 / size as f64;
            let y0 = y as f64 * image.height() as f64 / size as f64;
            let y1 = (y + 1) as f64 * image.height() as f64 / size as f64;
            let mut sum = [0.; 4];
            let mut weight = 0.;
            for sy in y0.floor() as u32..(y1.ceil() as u32).min(image.height()) {
                for sx in x0.floor() as u32..(x1.ceil() as u32).min(image.width()) {
                    let area = (x1.min(sx as f64 + 1.) - x0.max(sx as f64))
                        * (y1.min(sy as f64 + 1.) - y0.max(sy as f64));
                    let offset = ((sy * image.width() + sx) * 4) as usize;
                    let alpha = source[offset + 3] as f64 / 255.;
                    for c in 0..3 {
                        sum[c] += source[offset + c] as f64 * area * alpha;
                    }
                    sum[3] += source[offset + 3] as f64 * area;
                    weight += area;
                }
            }
            let offset = ((y * size + x) * 4) as usize;
            for c in 0..3 {
                rgba[offset + c] = if sum[3] > 0. {
                    (sum[c] * 255. / sum[3]).round() as u8
                } else {
                    0
                };
            }
            rgba[offset + 3] = (sum[3] / weight).round() as u8;
        }
    }
    Image::new_owned(rgba, size, size)
}

fn render_tray(app: &AppHandle, state: &mut Presentation) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("varin") else {
        return Ok(());
    };
    let empty = Arc::new(Source {
        label: "main".into(),
        bootstrap: Value::Null,
        snapshot: json!({}),
    });
    let source = state.active.clone().unwrap_or(empty);
    let next = policy::tray_presentation(&source.snapshot, &state.locale);
    let identity_changed =
        state.actions.values().next().is_some_and(|a| {
            a.source.label != source.label || a.source.bootstrap != source.bootstrap
        });
    if state.rendered.as_ref() == Some(&next) && !identity_changed {
        return Ok(());
    }
    let previous = state.rendered.clone();
    if previous.as_ref().is_none_or(|p| p.title != next.title) {
        tray.set_title(Some(&next.title)).map_err(error)?;
    }
    if previous.as_ref().is_none_or(|p| p.tooltip != next.tooltip) {
        tray.set_tooltip(Some(&next.tooltip)).map_err(error)?;
    }

    if previous.as_ref().is_none_or(|p| p.icon != next.icon) {
        stop_animation(state);
        let assets = assets()?;
        let image = match next.icon {
            IconState::Unseen => &assets.unseen,
            _ => &assets.idle,
        };
        tray.set_icon_with_as_template(Some(image.clone()), cfg!(target_os = "macos"))
            .map_err(error)?;
        if next.icon == IconState::Busy && assets.breath.len() > 1 {
            start_animation(app, state, assets);
        }
    }
    // Badge-only updates and credential rotations do not tear down a native
    // menu that the user may be reading. Runtime identity still fences targets.
    let same_runtime = state.actions.values().next().is_none_or(|action| {
        action.source.label == source.label
            && policy::runtime_key(&action.source.bootstrap)
                == policy::runtime_key(&source.bootstrap)
    });
    if previous.as_ref().is_some_and(|previous| {
        previous.header == next.header
            && previous.sessions == next.sessions
            && previous.approvals == next.approvals
    }) && same_runtime
    {
        for action in state.actions.values_mut() {
            action.source = source.clone();
        }
        state.rendered = Some(next);
        return Ok(());
    }
    let menu = Menu::new(app).map_err(error)?;
    let mut actions = HashMap::new();
    state.generation = state.generation.wrapping_add(1);
    let generation = state.generation;
    menu.append(
        &MenuItem::new(app, escape_mnemonic(&next.header), false, None::<&str>).map_err(error)?,
    )
    .map_err(error)?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
        .map_err(error)?;
    if !next.approvals.is_empty() {
        menu.append(
            &MenuItem::new(
                app,
                text(&state.locale, "Needs your attention"),
                false,
                None::<&str>,
            )
            .map_err(error)?,
        )
        .map_err(error)?;
        append_rows(
            app,
            &menu,
            &next.approvals,
            policy::VISIBLE_APPROVALS,
            "approval",
            generation,
            &state.locale,
            &source,
            &mut actions,
        )?;
        menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
            .map_err(error)?;
    }
    menu.append(
        &MenuItem::new(
            app,
            text(
                &state.locale,
                if next.sessions.is_empty() {
                    "No active sessions"
                } else {
                    "Sessions"
                },
            ),
            false,
            None::<&str>,
        )
        .map_err(error)?,
    )
    .map_err(error)?;
    append_rows(
        app,
        &menu,
        &next.sessions,
        policy::VISIBLE_SESSIONS,
        "thread",
        generation,
        &state.locale,
        &source,
        &mut actions,
    )?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
        .map_err(error)?;
    let mut quick = |kind: &str, label: &str| -> Result<(), String> {
        let id = format!("tray:{generation}:{kind}");
        actions.insert(
            id.clone(),
            Action {
                source: source.clone(),
                payload: json!({"type":kind}),
            },
        );
        menu.append(
            &MenuItem::with_id(app, id, text(&state.locale, label), true, None::<&str>)
                .map_err(error)?,
        )
        .map_err(error)
    };
    quick("new-thread", "New Session")?;
    if !cfg!(target_os = "macos") {
        menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
            .map_err(error)?;
        quick("show-main-window", "Show Window")?;
        quick("hide-main-window", "Hide Window")?;
    } else {
        quick("show-main-window", "Show Varin")?;
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(error)?)
        .map_err(error)?;
    quick("quit", "Quit Varin")?;
    tray.set_menu(Some(menu)).map_err(error)?;
    #[cfg(target_os = "macos")]
    mac::decorate_tray(&tray, &next)?;
    state.actions = actions;
    state.rendered = Some(next);
    Ok(())
}
fn escape_mnemonic(value: &str) -> String {
    value.replace('&', "&&")
}
#[allow(clippy::too_many_arguments)]
fn append_rows(
    app: &AppHandle,
    menu: &Menu<tauri::DynRuntime>,
    rows: &[TrayRow],
    limit: usize,
    kind: &str,
    generation: u64,
    locale: &str,
    source: &Arc<Source>,
    actions: &mut HashMap<String, Action>,
) -> Result<(), String> {
    let overflow = if rows.len() > limit {
        Some(
            Submenu::new(
                app,
                policy::counted(locale, "{count} more…", rows.len() - limit),
                true,
            )
            .map_err(error)?,
        )
    } else {
        None
    };
    let assets = assets()?;
    for (index, row) in rows.iter().enumerate() {
        let id = format!("tray:{generation}:{kind}:{index}");
        actions.insert(
            id.clone(),
            Action {
                source: source.clone(),
                payload: row.action.clone(),
            },
        );
        let icon = row.icon.and_then(|key| assets.status.get(key)).cloned();
        let item = IconMenuItem::with_id(
            app,
            id,
            escape_mnemonic(&row.label),
            true,
            icon,
            None::<&str>,
        )
        .map_err(error)?;
        if index < limit {
            menu.append(&item).map_err(error)?;
        } else if let Some(overflow) = &overflow {
            overflow.append(&item).map_err(error)?;
        }
    }
    if let Some(overflow) = overflow {
        menu.append(&overflow).map_err(error)?;
    }
    Ok(())
}
fn stop_animation(state: &mut Presentation) {
    state.animation_epoch = state.animation_epoch.wrapping_add(1);
    if let Some(animation) = state.animation.take() {
        animation.abort();
    }
}
fn start_animation(app: &AppHandle, state: &mut Presentation, assets: Arc<Assets>) {
    let handle = app.clone();
    let epoch = state.animation_epoch;
    state.animation = Some(tauri::async_runtime::spawn(async move {
        let mut index = 0usize;
        let mut forward = true;
        loop {
            tokio::time::sleep(policy::BREATH_INTERVAL).await;
            let handle = handle.clone();
            let frame = assets.breath[index].clone();
            let _ = handle.clone().run_on_main_thread(move || {
                let owner = handle.state::<NativeMenus>();
                let Ok(state) = owner.state.lock() else {
                    return;
                };
                if state.animation_epoch != epoch
                    || state.animation.is_none()
                    || state
                        .rendered
                        .as_ref()
                        .is_none_or(|p| p.icon != IconState::Busy)
                {
                    return;
                }
                if let Some(tray) = handle.tray_by_id("varin") {
                    let _ = tray.set_icon_with_as_template(Some(frame), true);
                }
            });
            if forward {
                index += 1;
                if index == assets.breath.len() - 1 {
                    forward = false;
                }
            } else {
                index -= 1;
                if index == 0 {
                    forward = true;
                }
            }
        }
    }));
}
fn dispatch_window_action(app: &AppHandle, kind: &str) {
    let source = app
        .state::<NativeMenus>()
        .state
        .lock()
        .ok()
        .and_then(|s| s.active.clone());
    if let Some(source) = source {
        crate::desktop::native_presentation_action(
            app,
            &source.label,
            source.bootstrap.clone(),
            json!({"type":kind}),
        );
    } else if kind == "show-main-window" || kind == "toggle-main-window" {
        crate::desktop::show_main(app);
    }
}
pub fn dispatch(app: &AppHandle, id: &str) {
    if let Some(action) = id.strip_prefix("app:") {
        crate::desktop::menu_action(app, action);
        return;
    }
    let action = app
        .state::<NativeMenus>()
        .state
        .lock()
        .ok()
        .and_then(|s| s.actions.get(id).cloned());
    if let Some(action) = action {
        crate::desktop::native_presentation_action(
            app,
            &action.source.label,
            action.source.bootstrap.clone(),
            action.payload,
        );
    }
    // A click from a replaced native menu must not use the same index in its
    // replacement, nor leak through as a renderer menu command.
}
pub fn edit(window: &WebviewWindow, action: &str) -> Result<(), String> {
    let action = action.to_owned();
    window
        .with_cef_webview(move |view| {
            if let Some(frame) = view.browser().focused_frame() {
                match action.as_str() {
                    "undo" => frame.undo(),
                    "redo" => frame.redo(),
                    "cut" => frame.cut(),
                    "copy" => frame.copy(),
                    "paste" => frame.paste(),
                    "select-all" => frame.select_all(),
                    _ => {}
                }
            }
        })
        .map_err(error)
}
#[cfg(target_os = "macos")]
#[path = "native_menu_macos.rs"]
mod mac;
