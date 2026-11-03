// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// Copyright 2026 Varin contributors
// SPDX-License-Identifier: MIT
// Based on tauri-v3.0.0-alpha.5/examples/cef/src-tauri/src/offscreen.rs.
// Upstream MIT license: ../../vendor/tauri-runtime-cef/LICENSE-MIT.
// The opaque softbuffer example is replaced by real alpha composition; IME
// preedit, UTF-16 ranges, cancellation, focus and native frame lifetime are owned here.

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{Arc, Mutex},
};

use super::{
    gpu,
    pixels::{Frame, blend, utf16_offset},
};
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindowBuilder};
use tauri_runtime_cef::{
    Offscreen, OffscreenView,
    cef::{
        Browser, BrowserHost, CefString, CompositionUnderline, CompositionUnderlineStyle,
        CursorType, ImplBrowser, ImplBrowserHost, ImplRenderHandler, KeyEvent as CefKeyEvent,
        KeyEventType, MouseButtonType, MouseEvent, PaintElementType, Range, Rect as CefRect,
        RenderHandler, ScreenInfo, WrapRenderHandler, rc::Rc as _, sys::cef_event_flags_t,
        wrap_render_handler,
    },
};
#[cfg(not(target_os = "linux"))]
use winit::platform::scancode::PhysicalKeyExtScancode;
use winit::{
    cursor::{CursorIcon, CustomCursorSource},
    event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::ActiveEventLoop,
    keyboard::{Key, ModifiersState, NamedKey},
    window::Window,
};

/// The latest images CEF painted for one webview, shared with the commands the
/// page and the end-to-end suite read them back through.
#[derive(Default)]
pub struct Frames {
    view: Option<Frame>,
    popup: Option<Frame>,
    /// Where the page's popup widget (an open `<select>`) goes, in view DIPs.
    popup_rect: Option<CefRect>,
    paints: u64,
    popup_paints: u64,
}

/// The main-thread state of one off-screen window.
struct Embedded {
    view: OffscreenView,
    frames: Arc<Mutex<Frames>>,
    browser: Option<Browser>,
    /// Holds the native window, so it is dropped on `Destroyed`, before the
    /// runtime lets the window go.
    surface: Option<gpu::Surface>,
    ime_composing: bool,
    pending_cursor: Option<CustomCursorSource>,
    passthrough: bool,
    forwarded_inside: bool,
    last_click: Option<(std::time::Instant, i32, i32, u32, i32)>,
    error: Option<String>,
    presentations: u64,
    /// The last pointer position, in view DIPs, for `PointerLeft`.
    pointer: (i32, i32),
    modifiers: ModifiersState,
    buttons: u32,
}

thread_local! {
  static EMBEDDED: RefCell<HashMap<String, Embedded>> = RefCell::default();
}

wrap_render_handler! {
  struct NativeRenderHandler {
    label: String,
    view: OffscreenView,
    frames: Arc<Mutex<Frames>>,
  }

  impl RenderHandler {
    fn start_dragging(&self, browser:Option<&mut Browser>, data:Option<&mut tauri_runtime_cef::cef::DragData>, allowed:tauri_runtime_cef::cef::DragOperationsMask, x:i32, y:i32)->i32 {
      let (Some(host),Some(data))=(browser.and_then(|browser|browser.host()),data)else{return 0};
      i32::from(super::drag::start(&self.label,&self.view,host,data,allowed,x,y))
    }
    fn update_drag_cursor(&self,_browser:Option<&mut Browser>,operation:tauri_runtime_cef::cef::DragOperationsMask){super::drag::cursor(&self.label,&self.view,operation);}
    fn view_rect(&self, browser: Option<&mut Browser>, rect: Option<&mut CefRect>) {
      self.remember(browser);
      let Some(rect) = rect else { return };
      let (_, (width, height)) = logical_bounds(&self.view);
      // CEF asserts on an empty view, which is what a minimized window has.
      *rect = CefRect {
        x: 0,
        y: 0,
        width: (width.round() as i32).max(1),
        height: (height.round() as i32).max(1),
      };
    }

    fn screen_point(&self, _browser: Option<&mut Browser>, view_x: i32, view_y: i32,
        screen_x: Option<&mut i32>, screen_y: Option<&mut i32>) -> i32 {
      let (Some(window), Some(x), Some(y)) = (self.view.window(), screen_x, screen_y) else { return 0; };
      let origin = window.surface_position();
      let ((left, top), _) = logical_bounds(&self.view);
      let scale = window.scale_factor();
      *x = origin.x + ((left + f64::from(view_x)) * scale).round() as i32;
      *y = origin.y + ((top + f64::from(view_y)) * scale).round() as i32;
      1
    }

    fn on_ime_composition_range_changed(&self, _browser: Option<&mut Browser>,
        selected_range: Option<&Range>, character_bounds: Option<&[CefRect]>) {
      let (Some(window), Some(bounds)) = (self.view.window(), character_bounds) else { return; };
      let index = selected_range.map_or(0, |range| range.to.saturating_sub(1) as usize);
      let Some(rect) = bounds.get(index).or_else(|| bounds.last()) else { return; };
      let ((left, top), _) = logical_bounds(&self.view);
      window.set_ime_cursor_area(LogicalPosition::new(left + f64::from(rect.x), top + f64::from(rect.y)).into(),
          LogicalSize::new(rect.width.max(1), rect.height.max(1)).into());
    }

    fn screen_info(
      &self,
      _browser: Option<&mut Browser>,
      screen_info: Option<&mut ScreenInfo>,
    ) -> std::os::raw::c_int {
      let (Some(info), Some(window)) = (screen_info, self.view.window()) else {
        return 0;
      };
      // What CEF scales the paint buffer by: the view rect is in DIPs, the
      // pixels it paints are physical.
      info.device_scale_factor = window.scale_factor() as f32;
      1
    }

    fn on_popup_show(&self, _browser: Option<&mut Browser>, show: std::os::raw::c_int) {
      if show == 0 {
        let mut frames = self.frames.lock().unwrap();
        frames.popup = None;
        frames.popup_rect = None;
        drop(frames);
        self.view.request_redraw();
      }
    }

    fn on_popup_size(&self, _browser: Option<&mut Browser>, rect: Option<&CefRect>) {
      self.frames.lock().unwrap().popup_rect = rect.cloned();
    }

    fn on_paint(
      &self,
      browser: Option<&mut Browser>,
      type_: PaintElementType,
      _dirty_rects: Option<&[CefRect]>,
      buffer: *const u8,
      width: std::os::raw::c_int,
      height: std::os::raw::c_int,
    ) {
      self.remember(browser);
      let (Ok(width), Ok(height)) = (usize::try_from(width), usize::try_from(height)) else {
        return;
      };
      if buffer.is_null() {
        return;
      }
      // CEF only lends the buffer for the duration of this call.
      let Some(length) = width.checked_mul(height).and_then(|pixels| pixels.checked_mul(4)) else { return; };
      let bytes = unsafe { std::slice::from_raw_parts(buffer, length) };
      let Some(frame) = Frame::from_bgra(width, height, bytes) else { return; };
      let mut frames = self.frames.lock().unwrap();
      if type_ == PaintElementType::POPUP {
        frames.popup_paints += 1;
        frames.popup = Some(frame);
      } else {
        frames.paints += 1;
        frames.view = Some(frame);
      }
      drop(frames);
      self.view.request_redraw();
    }
  }
}

impl NativeRenderHandler {
    /// Keeps the browser the render handler is first called with, which is how
    /// the input forwarding below reaches its host.
    fn remember(&self, browser: Option<&mut Browser>) {
        let Some(browser) = browser else { return };
        let window = EMBEDDED.with(|embedded| {
            if let Ok(mut embedded) = embedded.try_borrow_mut()
                && let Some(embedded) = embedded.get_mut(&self.label)
                && embedded.browser.is_none()
            {
                embedded.browser = Some(browser.clone());
                return embedded.view.window();
            }
            None
        });
        // Never hold a map borrow across CEF calls: callbacks can re-enter.
        if let Some(window) = window {
            window.set_ime_allowed(true);
            if let Some(host) = browser.host() {
                refresh_rate(&window, &host);
            }
        }
    }
}

/// The webview's position and size relative to the window, in logical pixels.
pub(super) fn logical_bounds(view: &OffscreenView) -> ((f64, f64), (f64, f64)) {
    let bounds = view.bounds();
    let position = bounds.position.to_logical::<f64>(1.0);
    let size = bounds.size.to_logical::<f64>(1.0);
    ((position.x, position.y), (size.width, size.height))
}

/// Keep all window attributes chosen by the shell, but render its live page
/// through an alpha-capable native surface instead of an opaque Chromium child.
pub fn transparent<'a, M: Manager<tauri::DynRuntime>>(
    mut builder: WebviewWindowBuilder<'a, tauri::DynRuntime, M>,
    label: &str,
) -> Result<WebviewWindowBuilder<'a, tauri::DynRuntime, M>, String> {
    use tauri_runtime_cef::{AsCefWebviewAttributes, WebviewWindowBuilderCefExt};
    let label = label.to_string();
    let cursor_label = label.clone();
    let mut offscreen = Offscreen::new(move |view| {
        let frames = Arc::new(Mutex::new(Frames::default()));
        EMBEDDED.with_borrow_mut(|embedded| {
            embedded.insert(
                label.clone(),
                Embedded {
                    view: view.clone(),
                    frames: frames.clone(),
                    browser: None,
                    surface: None,
                    pointer: (0, 0),
                    modifiers: ModifiersState::empty(),
                    buttons: 0,
                    ime_composing: false,
                    pending_cursor: None,
                    passthrough: false,
                    forwarded_inside: false,
                    last_click: None,
                    error: None,
                    presentations: 0,
                },
            );
        });
        NativeRenderHandler::new(label.clone(), view, frames)
    });
    offscreen.cursor_handler = Some(Arc::new(move |cursor, info| {
        set_cursor(&cursor_label, cursor, info)
    }));
    builder = builder.transparent(true).with_browser_settings(|settings| {
        // This is replaced with the actual display refresh before the first
        // frame when available. Do not inherit CEF's 30 fps OSR default.
        settings.windowless_frame_rate = 60;
    });
    let attrs = builder
        .runtime_specific_attributes_mut()
        .as_cef_webview_attributes_mut()
        .ok_or("Transparent windows require the bundled CEF runtime")?;
    attrs.offscreen = Some(offscreen);
    Ok(builder)
}

pub fn last_error(label: &str) -> Option<String> {
    EMBEDDED.with_borrow(|embedded| embedded.get(label).and_then(|entry| entry.error.clone()))
}

/// Fixed native smoke observation. This is not a renderer/IPC command.
pub async fn observe(app: &tauri::AppHandle, label: &str) -> Result<serde_json::Value, String> {
    let label = label.to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let observed = EMBEDDED.with_borrow(|entries| {
            let entry = entries
                .get(&label)
                .ok_or("Original OSR surface is unavailable")?;
            let frames = entry
                .frames
                .lock()
                .map_err(|_| "OSR frame observation unavailable")?;
            let alpha = frames.view.as_ref().map(|frame| {
                frame.pixels.iter().fold((255u32, 0u32), |(min, max), p| {
                    (min.min(p >> 24), max.max(p >> 24))
                })
            });
            Ok::<_, String>(
                serde_json::json!({"paints":frames.paints,"presentations":entry.presentations,
                "alphaMin":alpha.map(|a|a.0),"alphaMax":alpha.map(|a|a.1),"error":entry.error,
                "gpu":entry.surface.as_ref().map(|s|s.observation())}),
            )
        });
        let _ = send.send(observed);
    })
    .map_err(|e| e.to_string())?;
    receive
        .await
        .map_err(|_| "Native OSR observation was lost".to_string())?
}

fn refresh_rate(window: &Arc<dyn Window>, host: &BrowserHost) {
    if let Some(rate) = window
        .current_monitor()
        .and_then(|monitor| monitor.current_video_mode())
        .and_then(|mode| mode.refresh_rate_millihertz())
    {
        host.set_windowless_frame_rate(((rate.get() + 999) / 1000) as i32);
    }
}

/// The native window events of every window, registered with
/// `Cef::on_window_event`. It runs before the runtime handles the event, and
/// only observes: the runtime's own handling (closing, resizing the webview)
/// still happens.
pub fn on_window_event(
    label: &str,
    event_loop: &dyn ActiveEventLoop,
    window: Arc<dyn Window>,
    event: &WindowEvent,
) {
    super::macos_chrome::window_event(label, matches!(event, WindowEvent::Destroyed));
    if let WindowEvent::Destroyed = event {
        super::drag::destroyed(label);
        // Drops the surface, and with it this module's last hold on the window.
        EMBEDDED.with_borrow_mut(|embedded| embedded.remove(label));
        let active =
            EMBEDDED.with_borrow(|entries| entries.values().any(|entry| entry.passthrough));
        let _ = super::input_forward::set_active(active);
        return;
    }

    let Some((view, host)) = EMBEDDED.with_borrow(|embedded| {
        embedded.get(label).map(|embedded| {
            (
                embedded.view.clone(),
                embedded.browser.as_ref().and_then(|browser| browser.host()),
            )
        })
    }) else {
        return;
    };

    if let Some(host) = host.as_ref() {
        if let Err(error) = super::drag::event(label, event_loop, &window, &view, host, event) {
            report_error(label, error)
        }
    }

    if let Some(source) = with_embedded(label, |entry| entry.pending_cursor.take()).flatten() {
        match event_loop.create_custom_cursor(source) {
            Ok(cursor) => window.set_cursor(cursor.into()),
            Err(error) => report_error(label, format!("Native custom cursor: {error}")),
        }
    }
    match event {
        WindowEvent::RedrawRequested => present(label, &window, &view),
        WindowEvent::Focused(focused) => {
            if let Some(host) = host {
                host.set_focus(i32::from(*focused));
                if !focused {
                    host.send_capture_lost_event();
                    host.ime_cancel_composition();
                    with_embedded(label, |entry| {
                        entry.buttons = 0;
                        entry.modifiers = ModifiersState::empty();
                        entry.ime_composing = false;
                    });
                }
            }
        }
        WindowEvent::ModifiersChanged(modifiers) => {
            with_embedded(label, |embedded| embedded.modifiers = modifiers.state());
        }
        WindowEvent::PointerMoved { position, .. } => {
            let Some(host) = host else { return };
            let event = mouse_event(label, &view, &window, position.x, position.y);
            host.send_mouse_move_event(Some(&event), 0);
        }
        WindowEvent::PointerLeft { .. } => {
            let Some(host) = host else { return };
            let event = with_embedded(label, |embedded| MouseEvent {
                x: embedded.pointer.0,
                y: embedded.pointer.1,
                modifiers: flags(embedded),
            });
            if let Some(event) = event {
                host.send_mouse_move_event(Some(&event), 1);
            }
        }
        WindowEvent::PointerButton {
            state,
            position,
            button,
            ..
        } => {
            let Some(host) = host else { return };
            let (kind, flag) = match button.clone().mouse_button() {
                Some(MouseButton::Left) => (MouseButtonType::LEFT, 16),
                Some(MouseButton::Middle) => (MouseButtonType::MIDDLE, 32),
                Some(MouseButton::Right) => (MouseButtonType::RIGHT, 64),
                _ => return,
            };
            let pressed = *state == ElementState::Pressed;
            with_embedded(label, |embedded| {
                if pressed {
                    embedded.buttons |= flag;
                } else {
                    embedded.buttons &= !flag;
                }
            });
            let event = mouse_event(label, &view, &window, position.x, position.y);
            let count = with_embedded(label, |entry| {
                if pressed {
                    let now = std::time::Instant::now();
                    let count = entry
                        .last_click
                        .as_ref()
                        .filter(|(at, x, y, old_flag, _)| {
                            now.duration_since(*at) <= double_click_interval()
                                && (event.x - x).abs() <= 4
                                && (event.y - y).abs() <= 4
                                && *old_flag == flag
                        })
                        .map_or(
                            1,
                            |(_, _, _, _, count)| if *count == 3 { 1 } else { count + 1 },
                        );
                    entry.last_click = Some((now, event.x, event.y, flag, count));
                    count
                } else {
                    entry.last_click.as_ref().map_or(1, |last| last.4)
                }
            })
            .unwrap_or(1);
            host.send_mouse_click_event(Some(&event), kind, i32::from(!pressed), count);
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let Some(host) = host else { return };
            // Chromium scrolls by pixels; a wheel notch is 120 of them on Windows,
            // the convention CEF follows everywhere.
            let (dx, dy) = match delta {
                MouseScrollDelta::LineDelta(x, y) => (x * 120., y * 120.),
                MouseScrollDelta::PixelDelta(delta) => (delta.x as f32, delta.y as f32),
                _ => return,
            };
            // winit's convention is positive for content moving right and down, the
            // same as CEF's, but the GTK 4 backend passes GDK's deltas through
            // unchanged, and GDK's are positive for scrolling down.
            #[cfg(target_os = "linux")]
            let (dx, dy) = (-dx, -dy);
            let event = with_embedded(label, |embedded| MouseEvent {
                x: embedded.pointer.0,
                y: embedded.pointer.1,
                modifiers: flags(embedded),
            });
            if let Some(event) = event {
                host.send_mouse_wheel_event(Some(&event), dx as i32, dy as i32);
            }
        }
        WindowEvent::KeyboardInput { event, .. } => {
            let Some(host) = host else { return };
            let modifiers = with_embedded(label, |embedded| flags(embedded)).unwrap_or(0);
            let composing =
                with_embedded(label, |embedded| embedded.ime_composing).unwrap_or(false);
            let pressed = event.state == ElementState::Pressed;
            let (virtual_code, native_code) = key_codes(event, modifiers);
            host.send_key_event(Some(&CefKeyEvent {
                type_: if pressed {
                    KeyEventType::RAWKEYDOWN
                } else {
                    KeyEventType::KEYUP
                },
                modifiers,
                windows_key_code: virtual_code,
                native_key_code: native_code,
                character: event
                    .text
                    .as_ref()
                    .and_then(|text| text.encode_utf16().next())
                    .unwrap_or(0),
                is_system_key: i32::from(modifiers & ALT_DOWN != 0),
                ..Default::default()
            }));
            // Text goes in as character events. A shortcut is not text.
            let shortcut = modifiers & (CONTROL_DOWN | COMMAND_DOWN) != 0;
            if pressed
                && !shortcut
                && !composing
                && let Some(text) = &event.text
            {
                send_text(&host, text, modifiers);
            }
        }
        WindowEvent::Ime(Ime::Preedit(text, selection)) => {
            let Some(host) = host else {
                return;
            };
            with_embedded(label, |entry| entry.ime_composing = !text.is_empty());
            if text.is_empty() {
                host.ime_cancel_composition();
            } else {
                let count = text.encode_utf16().count() as u32;
                let (from, to) = selection
                    .map(|(a, b)| (utf16_offset(text, a), utf16_offset(text, b)))
                    .unwrap_or((count, count));
                let underline = CompositionUnderline {
                    range: Range { from: 0, to: count },
                    color: 0xff000000,
                    style: CompositionUnderlineStyle::SOLID,
                    ..Default::default()
                };
                host.ime_set_composition(
                    Some(&CefString::from(text.as_str())),
                    Some(&[underline]),
                    Some(&Range {
                        from: u32::MAX,
                        to: u32::MAX,
                    }),
                    Some(&Range { from, to }),
                );
            }
        }
        WindowEvent::Ime(Ime::Commit(text)) => {
            with_embedded(label, |entry| entry.ime_composing = false);
            if let Some(host) = host {
                host.ime_commit_text(
                    Some(&CefString::from(text.as_str())),
                    Some(&Range {
                        from: u32::MAX,
                        to: u32::MAX,
                    }),
                    0,
                );
            }
        }
        WindowEvent::Ime(Ime::Disabled) => {
            with_embedded(label, |entry| entry.ime_composing = false);
            if let Some(host) = host {
                host.ime_cancel_composition();
            }
        }
        WindowEvent::SurfaceResized(_)
        | WindowEvent::ScaleFactorChanged { .. }
        | WindowEvent::Moved(_) => {
            if let Some(host) = host {
                host.notify_screen_info_changed();
                host.was_resized();
                refresh_rate(&window, &host);
            }
            view.request_redraw();
        }
        WindowEvent::Occluded(hidden) => {
            if let Some(host) = host {
                host.was_hidden(i32::from(*hidden));
            }
            if !hidden {
                view.request_redraw();
            }
        }
        _ => {}
    }
}

// `c_uint` everywhere but Windows, where bindgen makes it a `c_int`.
#[allow(clippy::unnecessary_cast)]
const SHIFT_DOWN: u32 = cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0 as u32;
#[allow(clippy::unnecessary_cast)]
const CONTROL_DOWN: u32 = cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0 as u32;
#[allow(clippy::unnecessary_cast)]
const ALT_DOWN: u32 = cef_event_flags_t::EVENTFLAG_ALT_DOWN.0 as u32;
#[allow(clippy::unnecessary_cast)]
const COMMAND_DOWN: u32 = cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0 as u32;

/// CEF's event flags for the held modifiers and mouse buttons.
fn flags(embedded: &Embedded) -> u32 {
    let mut flags = embedded.buttons;
    for (held, flag) in [
        (embedded.modifiers.shift_key(), SHIFT_DOWN),
        (embedded.modifiers.control_key(), CONTROL_DOWN),
        (embedded.modifiers.alt_key(), ALT_DOWN),
        (embedded.modifiers.meta_key(), COMMAND_DOWN),
    ] {
        if held {
            flags |= flag;
        }
    }
    flags
}

fn with_embedded<T>(label: &str, f: impl FnOnce(&mut Embedded) -> T) -> Option<T> {
    EMBEDDED.with_borrow_mut(|embedded| embedded.get_mut(label).map(f))
}

/// A mouse event at a physical window position, in the view's DIPs.
pub(super) fn mouse_event(
    label: &str,
    view: &OffscreenView,
    window: &Arc<dyn Window>,
    x: f64,
    y: f64,
) -> MouseEvent {
    let scale = window.scale_factor();
    let ((left, top), _) = logical_bounds(view);
    let position = (
        (x / scale - left).round() as i32,
        (y / scale - top).round() as i32,
    );
    with_embedded(label, |embedded| {
        embedded.pointer = position;
        MouseEvent {
            x: position.0,
            y: position.1,
            modifiers: flags(embedded),
        }
    })
    .unwrap_or_default()
}

fn send_text(host: &BrowserHost, text: &str, modifiers: u32) {
    for unit in text.encode_utf16() {
        host.send_key_event(Some(&CefKeyEvent {
            type_: KeyEventType::CHAR,
            modifiers,
            windows_key_code: i32::from(unit),
            character: unit,
            unmodified_character: unit,
            ..Default::default()
        }));
    }
}

/// The Windows virtual-key code Chromium identifies a key by, for the keys an
/// editable field needs. Letters and digits are their uppercase ASCII code.
fn windows_key_code(key: &Key) -> i32 {
    match key {
        Key::Named(named) => match named {
            NamedKey::F1 => 0x70,
            NamedKey::F2 => 0x71,
            NamedKey::F3 => 0x72,
            NamedKey::F4 => 0x73,
            NamedKey::F5 => 0x74,
            NamedKey::F6 => 0x75,
            NamedKey::F7 => 0x76,
            NamedKey::F8 => 0x77,
            NamedKey::F9 => 0x78,
            NamedKey::F10 => 0x79,
            NamedKey::F11 => 0x7A,
            NamedKey::F12 => 0x7B,
            NamedKey::CapsLock => 0x14,
            NamedKey::NumLock => 0x90,
            NamedKey::ScrollLock => 0x91,
            NamedKey::Pause => 0x13,
            NamedKey::Insert => 0x2D,
            NamedKey::PrintScreen => 0x2C,
            NamedKey::Meta | NamedKey::Super => 0x5B,
            NamedKey::ContextMenu => 0x5D,
            NamedKey::Backspace => 0x08,
            NamedKey::Tab => 0x09,
            NamedKey::Enter => 0x0D,
            NamedKey::Shift => 0x10,
            NamedKey::Control => 0x11,
            NamedKey::Alt => 0x12,
            NamedKey::Escape => 0x1B,
            NamedKey::PageUp => 0x21,
            NamedKey::PageDown => 0x22,
            NamedKey::End => 0x23,
            NamedKey::Home => 0x24,
            NamedKey::ArrowLeft => 0x25,
            NamedKey::ArrowUp => 0x26,
            NamedKey::ArrowRight => 0x27,
            NamedKey::ArrowDown => 0x28,
            NamedKey::Delete => 0x2E,
            _ => 0,
        },
        Key::Character(text) => text.chars().next().map_or(0, |c| match c {
            ';' | ':' => 0xBA,
            '=' | '+' => 0xBB,
            ',' | '<' => 0xBC,
            '-' | '_' => 0xBD,
            '.' | '>' => 0xBE,
            '/' | '?' => 0xBF,
            '`' | '~' => 0xC0,
            '[' | '{' => 0xDB,
            '\\' | '|' => 0xDC,
            ']' | '}' => 0xDD,
            '\'' | '"' => 0xDE,
            c if c.is_ascii_alphanumeric() || c == ' ' => c.to_ascii_uppercase() as i32,
            _ => 0,
        }),
        _ => 0,
    }
}

fn set_cursor(label: &str, cursor: CursorType, info: Option<&tauri_runtime_cef::cef::CursorInfo>) {
    let window = EMBEDDED.with_borrow(|embedded| embedded.get(label)?.view.window());
    let Some(window) = window else { return };
    window.set_cursor_visible(cursor != CursorType::NONE);
    if cursor == CursorType::CUSTOM {
        let Some(info) = info else { return };
        let (Ok(width), Ok(height), Ok(hotspot_x), Ok(hotspot_y)) = (
            u16::try_from(info.size.width),
            u16::try_from(info.size.height),
            u16::try_from(info.hotspot.x),
            u16::try_from(info.hotspot.y),
        ) else {
            return;
        };
        if info.buffer.is_null() || width > 2048 || height > 2048 {
            return;
        }
        // The cursor bitmap has the same premultiplied BGRA layout as OnPaint.
        // Copy during this callback, then create its OS handle at the next event.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                info.buffer.cast::<u8>(),
                usize::from(width) * usize::from(height) * 4,
            )
        };
        let mut rgba = Vec::with_capacity(bytes.len());
        for pixel in bytes.chunks_exact(4) {
            let alpha = u32::from(pixel[3]);
            for channel in [pixel[2], pixel[1], pixel[0]] {
                rgba.push(if alpha == 0 {
                    0
                } else {
                    ((u32::from(channel) * 255 + alpha / 2) / alpha).min(255) as u8
                });
            }
            rgba.push(pixel[3]);
        }
        if let Ok(source) = CustomCursorSource::from_rgba(rgba, width, height, hotspot_x, hotspot_y)
        {
            with_embedded(label, |entry| entry.pending_cursor = Some(source));
            window.request_redraw();
        }
        return;
    }
    with_embedded(label, |entry| entry.pending_cursor = None);
    let icon = match cursor {
        CursorType::CROSS => CursorIcon::Crosshair,
        CursorType::HAND => CursorIcon::Pointer,
        CursorType::IBEAM => CursorIcon::Text,
        CursorType::WAIT => CursorIcon::Wait,
        CursorType::HELP => CursorIcon::Help,
        CursorType::EASTRESIZE => CursorIcon::EResize,
        CursorType::NORTHRESIZE => CursorIcon::NResize,
        CursorType::NORTHEASTRESIZE => CursorIcon::NeResize,
        CursorType::NORTHWESTRESIZE => CursorIcon::NwResize,
        CursorType::SOUTHRESIZE => CursorIcon::SResize,
        CursorType::SOUTHEASTRESIZE => CursorIcon::SeResize,
        CursorType::SOUTHWESTRESIZE => CursorIcon::SwResize,
        CursorType::WESTRESIZE => CursorIcon::WResize,
        CursorType::NORTHSOUTHRESIZE => CursorIcon::NsResize,
        CursorType::EASTWESTRESIZE => CursorIcon::EwResize,
        CursorType::NORTHEASTSOUTHWESTRESIZE => CursorIcon::NeswResize,
        CursorType::NORTHWESTSOUTHEASTRESIZE => CursorIcon::NwseResize,
        CursorType::COLUMNRESIZE => CursorIcon::ColResize,
        CursorType::ROWRESIZE => CursorIcon::RowResize,
        CursorType::MOVE | CursorType::DND_MOVE => CursorIcon::Move,
        CursorType::VERTICALTEXT => CursorIcon::VerticalText,
        CursorType::CELL => CursorIcon::Cell,
        CursorType::CONTEXTMENU => CursorIcon::ContextMenu,
        CursorType::ALIAS | CursorType::DND_LINK => CursorIcon::Alias,
        CursorType::PROGRESS => CursorIcon::Progress,
        CursorType::NODROP | CursorType::DND_NONE => CursorIcon::NoDrop,
        CursorType::COPY | CursorType::DND_COPY => CursorIcon::Copy,
        CursorType::NOTALLOWED => CursorIcon::NotAllowed,
        CursorType::ZOOMIN => CursorIcon::ZoomIn,
        CursorType::ZOOMOUT => CursorIcon::ZoomOut,
        CursorType::GRAB => CursorIcon::Grab,
        CursorType::GRABBING => CursorIcon::Grabbing,
        CursorType::MIDDLEPANNING
        | CursorType::EASTPANNING
        | CursorType::NORTHPANNING
        | CursorType::NORTHEASTPANNING
        | CursorType::NORTHWESTPANNING
        | CursorType::SOUTHPANNING
        | CursorType::SOUTHEASTPANNING
        | CursorType::SOUTHWESTPANNING
        | CursorType::WESTPANNING
        | CursorType::MIDDLE_PANNING_VERTICAL
        | CursorType::MIDDLE_PANNING_HORIZONTAL => CursorIcon::AllScroll,
        _ => CursorIcon::Default,
    };
    window.set_cursor(icon.into());
}

fn double_click_interval() -> std::time::Duration {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetDoubleClickTime() -> u32;
        }
        return std::time::Duration::from_millis(u64::from(unsafe { GetDoubleClickTime() }));
    }
    #[cfg(not(windows))]
    {
        std::time::Duration::from_millis(500)
    }
}

fn present(label: &str, window: &Arc<dyn Window>, view: &OffscreenView) {
    let size = window.surface_size();
    if size.width == 0 || size.height == 0 || !view.is_visible() {
        return;
    }
    let Some(frames) = EMBEDDED.with_borrow(|entries| Some(entries.get(label)?.frames.clone()))
    else {
        return;
    };
    let mut surface = with_embedded(label, |entry| entry.surface.take()).flatten();
    if surface.is_none() {
        match gpu::Surface::new(window.clone()) {
            Ok(value) => surface = Some(value),
            Err(error) => {
                report_error(label, error);
                return;
            }
        }
    }
    let Some(mut surface) = surface else {
        return;
    };
    let (width, height) = (size.width as usize, size.height as usize);
    let Some(length) = width.checked_mul(height) else {
        return;
    };
    let mut pixels = vec![0; length];
    let scale = window.scale_factor();
    let ((left, top), _) = logical_bounds(view);
    let origin = (
        (left * scale).round() as isize,
        (top * scale).round() as isize,
    );
    {
        let frames = frames.lock().unwrap();
        if let Some(frame) = &frames.view {
            blend(&mut pixels, width, height, frame, origin);
        }
        if let (Some(frame), Some(rect)) = (&frames.popup, &frames.popup_rect) {
            blend(
                &mut pixels,
                width,
                height,
                frame,
                (
                    origin.0 + (f64::from(rect.x) * scale).round() as isize,
                    origin.1 + (f64::from(rect.y) * scale).round() as isize,
                ),
            );
        }
    }
    let bytes: Vec<u8> = pixels.into_iter().flat_map(u32::to_le_bytes).collect();
    match surface.present(size.width, size.height, &bytes) {
        Ok(outcome) => {
            let presented = matches!(outcome, gpu::PresentOutcome::Presented);
            with_embedded(label, |entry| {
                if presented {
                    entry.presentations += 1;
                }
                entry.surface = Some(surface);
                entry.error = None;
            });
            if matches!(outcome, gpu::PresentOutcome::Retry) {
                // Keep the latest CEF pixels, even when the page stops animating.
                // A transient resize/timeout must not drop its final static frame.
                view.request_redraw();
            }
        }
        Err(error) => {
            report_error(label, error);
            view.request_redraw();
        }
    }
}

fn report_error(label: &str, error: String) {
    with_embedded(label, |entry| {
        if entry.error.as_ref() != Some(&error) {
            eprintln!("[Desktop compositor] {label}: {error}");
        }
        entry.error = Some(error);
    });
}

fn key_codes(event: &winit::event::KeyEvent, modifiers: u32) -> (i32, i32) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MapVirtualKeyW(code: u32, map_type: u32) -> u32;
        }
        let scan = event.physical_key.to_scancode().unwrap_or(0);
        let virtual_code = unsafe { MapVirtualKeyW(scan, 3) } as i32; // MAPVK_VSC_TO_VK_EX
        // Chromium expects the native WM_KEY lParam, not a bare scan code.
        let mut native = 1 | ((scan & 0xff) << 16);
        if scan & 0xff00 != 0 {
            native |= 1 << 24;
        }
        if modifiers & ALT_DOWN != 0 {
            native |= 1 << 29;
        }
        if event.repeat || event.state == ElementState::Released {
            native |= 1 << 30;
        }
        if event.state == ElementState::Released {
            native |= 1 << 31;
        }
        (virtual_code, native as i32)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = modifiers;
        let native = winit_common::xkb::physicalkey_to_scancode(event.physical_key)
            .map(|code| code + 8)
            .unwrap_or(0) as i32;
        (windows_key_code(&event.logical_key), native)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = modifiers;
        (
            windows_key_code(&event.logical_key),
            event.physical_key.to_scancode().unwrap_or(0) as i32,
        )
    }
}

/// Apply click-through and receive a receipt after native forwarding is installed.
/// The main loop never waits synchronously for an asynchronous window command.
pub async fn set_passthrough(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let owned = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                with_embedded(owned.label(), |entry| entry.passthrough = enabled)
                    .ok_or("Companion surface is not ready for mouse forwarding")?;
                let active =
                    EMBEDDED.with_borrow(|entries| entries.values().any(|entry| entry.passthrough));
                if let Err(error) = super::input_forward::set_active(active) {
                    with_embedded(owned.label(), |entry| entry.passthrough = false);
                    let _ = owned.set_ignore_cursor_events(false);
                    return Err(error);
                }
                if let Err(error) = owned.set_ignore_cursor_events(enabled) {
                    with_embedded(owned.label(), |entry| entry.passthrough = false);
                    let active = EMBEDDED
                        .with_borrow(|entries| entries.values().any(|entry| entry.passthrough));
                    let _ = super::input_forward::set_active(active);
                    return Err(error.to_string());
                }
                Ok(())
            })();
            let _ = send.send(result);
        })
        .map_err(|_| "Companion main loop is unavailable")?;
    receive
        .await
        .map_err(|_| "Companion mouse-forwarding outcome is unknown")?
}

pub(super) fn forward_passthrough_mouse() {
    let windows = EMBEDDED
        .with(|entries| {
            entries.try_borrow().ok().map(|entries| {
                entries
                    .iter()
                    .filter_map(|(label, entry)| {
                        if !entry.passthrough || !entry.view.is_visible() {
                            return None;
                        }
                        Some((
                            label.clone(),
                            entry.view.clone(),
                            entry.view.window()?,
                            entry.browser.clone()?,
                        ))
                    })
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    for (label, view, window, browser) in windows {
        let Some((x, y)) = super::input_forward::position(&window) else {
            continue;
        };
        let size = window.surface_size();
        let inside =
            x >= 0.0 && y >= 0.0 && x < f64::from(size.width) && y < f64::from(size.height);
        let previous = with_embedded(&label, |entry| {
            let previous = entry.forwarded_inside;
            entry.forwarded_inside = inside;
            previous
        })
        .unwrap_or(false);
        if !inside && !previous {
            continue;
        }
        let event = mouse_event(&label, &view, &window, x, y);
        // Calling CEF after all registry borrows end permits normal re-entrancy.
        if let Some(host) = browser.host() {
            host.send_mouse_move_event(Some(&event), i32::from(!inside));
        }
    }
}
