//! Native drag sessions for CEF OSR. Original CEF DragData survives internal
//! drags (including custom Varin MIME types); external files are paths, never
//! loaded into memory. CEF and the OS both receive the actual terminal action.
use super::offscreen;
use std::{cell::RefCell, collections::HashMap, sync::Arc};
use tauri_runtime_cef::{
    OffscreenView,
    cef::{
        self, AlphaType, BrowserHost, CefString, CefStringList, ColorType, DragData,
        DragOperationsMask, ImplBinaryValue, ImplBrowserHost, ImplDragData, ImplImage, MouseEvent,
    },
};
use winit::{
    data_transfer::{DataTransferId, DataTransferSendBuilder, SendData, TypeHint},
    event::WindowEvent,
    event_loop::{ActiveEventLoop, AsyncRequestSerial, DndAction, DragIcon},
    icon::RgbaIcon,
    window::Window,
};
struct Source {
    label: String,
    view: OffscreenView,
    host: BrowserHost,
    data: DragData,
    allowed: DragOperationsMask,
    id: Option<DataTransferId>,
    pending: bool,
    position: (i32, i32),
    selected: DragOperationsMask,
}
#[derive(Clone, Copy)]
enum Format {
    Hint(TypeHint),
    #[cfg(target_os = "macos")]
    Custom(bool),
}
struct Target {
    id: DataTransferId,
    host: BrowserHost,
    data: DragData,
    pending: HashMap<AsyncRequestSerial, Format>,
    position: Option<MouseEvent>,
    entered: bool,
    dropped: bool,
    allowed: DragOperationsMask,
    selected: DragOperationsMask,
}
thread_local! {static SOURCE:RefCell<Option<Source>>=const{RefCell::new(None)};static TARGETS:RefCell<HashMap<String,Target>>=RefCell::default();}
fn mask(bits: u32) -> DragOperationsMask {
    cef::sys::cef_drag_operations_mask_t(bits as _).into()
}
fn actions(value: DragOperationsMask) -> Vec<DndAction> {
    let bits = value.as_ref().0;
    [
        (1, DndAction::Copy),
        (16, DndAction::Move),
        (2, DndAction::Link),
    ]
    .into_iter()
    .filter_map(|(bit, action)| (bits & bit != 0).then_some(action))
    .collect()
}
fn operation(action: Option<DndAction>) -> DragOperationsMask {
    mask(match action {
        Some(DndAction::Copy) => 1,
        Some(DndAction::Move) => 16,
        Some(DndAction::Link) => 2,
        _ => 0,
    })
}
pub fn start(
    label: &str,
    view: &OffscreenView,
    host: BrowserHost,
    data: &DragData,
    allowed: DragOperationsMask,
    x: i32,
    y: i32,
) -> bool {
    let Some(copy) = ImplDragData::clone(data) else {
        return false;
    };
    let admitted = SOURCE.with_borrow_mut(|source| {
        if source.is_some() {
            return false;
        }
        *source = Some(Source {
            label: label.into(),
            view: view.clone(),
            host,
            data: copy,
            allowed,
            id: None,
            pending: true,
            position: (x, y),
            selected: mask(0),
        });
        true
    });
    if admitted {
        view.request_redraw()
    }
    admitted
}
pub fn cursor(label: &str, view: &OffscreenView, operation: DragOperationsMask) {
    TARGETS.with_borrow_mut(|targets| {
        if let Some(target) = targets.get_mut(label) {
            target.selected = operation
        }
    });
    SOURCE.with_borrow_mut(|source| {
        if let Some(source) = source {
            source.selected = operation
        }
    });
    view.request_redraw();
}
fn icon(data: &DragData, scale: f64) -> Option<DragIcon> {
    let image = data.image()?;
    let (mut width, mut height) = (0, 0);
    let bitmap = image.as_bitmap(
        scale as f32,
        ColorType::RGBA_8888,
        AlphaType::POSTMULTIPLIED,
        Some(&mut width),
        Some(&mut height),
    )?;
    let size = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?
        .checked_mul(4)?;
    if size == 0 || size > 64 * 1024 * 1024 || bitmap.size() != size {
        return None;
    }
    let mut bytes = vec![0; size];
    if bitmap.data(Some(&mut bytes), 0) != size {
        return None;
    }
    let hotspot = data.image_hotspot();
    Some(DragIcon {
        icon: RgbaIcon::new(bytes, width as u32, height as u32)
            .ok()?
            .into(),
        offset_x: -(f64::from(hotspot.x) * scale).round() as i32,
        offset_y: -(f64::from(hotspot.y) * scale).round() as i32,
    })
}
#[derive(Debug)]
struct Export {
    text: String,
    html: String,
    uris: Vec<String>,
}
fn outgoing(
    label: &str,
    event_loop: &dyn ActiveEventLoop,
    window: &Arc<dyn Window>,
) -> Result<(), String> {
    let source = SOURCE.with_borrow_mut(|source| {
        source
            .as_mut()
            .filter(|s| s.label == label && s.pending)
            .map(|s| {
                s.pending = false;
                (Clone::clone(&s.data), s.allowed)
            })
    });
    let Some((data, allowed)) = source else {
        return Ok(());
    };
    let mut paths = CefStringList::new();
    data.file_paths(Some(&mut paths));
    let mut uris: Vec<String> = paths
        .into_iter()
        .filter_map(|p| url::Url::from_file_path(p).ok().map(Into::into))
        .collect();
    let link = CefString::from(&data.link_url()).to_string();
    if !link.is_empty() {
        uris.push(link)
    }
    let exported = Export {
        text: CefString::from(&data.fragment_text()).to_string(),
        html: CefString::from(&data.fragment_html()).to_string(),
        uris,
    };
    let has_html = !exported.html.is_empty();
    let has_uris = !exported.uris.is_empty();
    // Always advertise plaintext, even for a private-MIME-only internal drag.
    // The OS transports a harmless empty carrier; the original CEF object below
    // carries its exact private fields between Varin's own surfaces.
    let mut transfer = DataTransferSendBuilder::new(exported)
        .with_type(TypeHint::Plaintext, |v, _| Some(v.text.clone()));
    if has_html {
        transfer = transfer.with_type(TypeHint::Html, |v, _| Some(v.html.clone()))
    }
    if has_uris {
        transfer = transfer.with_type(TypeHint::UriList, |v, _| {
            Some(SendData::Uris(v.uris.clone()))
        })
    }
    match event_loop.start_drag(
        window.id(),
        transfer.build(),
        &actions(allowed),
        icon(&data, window.scale_factor()),
    ) {
        Ok(id) => {
            SOURCE.with_borrow_mut(|source| {
                if let Some(s) = source.as_mut() {
                    s.id = Some(id)
                }
            });
            Ok(())
        }
        Err(error) => {
            finish(None, None);
            Err(format!("Native drag could not start: {error}"))
        }
    }
}
fn finish(id: Option<DataTransferId>, selected: Option<DndAction>) {
    let source = SOURCE.with_borrow_mut(|s| {
        if s.as_ref().is_some_and(|s| id.is_none() || s.id == id) {
            s.take()
        } else {
            None
        }
    });
    if let Some(source) = source {
        let result = selected.map(|a| operation(Some(a))).unwrap_or_else(|| {
            if id.is_some() {
                source.selected
            } else {
                mask(0)
            }
        });
        source
            .host
            .drag_source_ended_at(source.position.0, source.position.1, result);
        source.host.drag_source_system_drag_ended();
    }
}
fn leave(label: &str) {
    let target = TARGETS.with_borrow_mut(|targets| targets.remove(label));
    if let Some(target) = target.filter(|t| t.entered) {
        target.host.drag_target_drag_leave();
    }
}
fn drive(label: &str, event_loop: &dyn ActiveEventLoop) {
    let update = TARGETS.with_borrow_mut(|targets| {
        let target = targets.get_mut(label)?;
        let position = target.position.clone()?;
        if !target.pending.is_empty() {
            return None;
        }
        let enter = !target.entered;
        target.entered = true;
        Some((
            target.id,
            target.host.clone(),
            Clone::clone(&target.data),
            position,
            target.allowed,
            target.selected,
            enter,
            target.dropped,
        ))
    });
    let Some((id, host, mut data, position, allowed, selected, enter, dropped)) = update else {
        return;
    };
    if enter {
        host.drag_target_drag_enter(Some(&mut data), Some(&position), allowed)
    }
    host.drag_target_drag_over(Some(&position), allowed);
    if dropped {
        TARGETS.with_borrow_mut(|targets| targets.remove(label));
        host.drag_target_drop(Some(&position));
    } else {
        let _ = event_loop.set_valid_dnd_actions(id, &actions(selected));
    }
}
pub fn destroyed(label: &str) {
    leave(label);
    let owned =
        SOURCE.with_borrow(|source| source.as_ref().is_some_and(|source| source.label == label));
    if owned {
        finish(None, None)
    }
}
pub fn event(
    label: &str,
    event_loop: &dyn ActiveEventLoop,
    window: &Arc<dyn Window>,
    view: &OffscreenView,
    host: &BrowserHost,
    event: &WindowEvent,
) -> Result<(), String> {
    outgoing(label, event_loop, window)?;
    match event {
        WindowEvent::DragEntered { id, position } => {
            leave(label);
            let own = SOURCE.with_borrow(|source| {
                source
                    .as_ref()
                    .filter(|s| !s.pending)
                    .and_then(|s| ImplDragData::clone(&s.data).map(|data| (data, s.allowed)))
            });
            let is_own = own.is_some();
            let (data, allowed) = match own {
                Some(value) => value,
                None => (
                    cef::drag_data_create().ok_or("Chromium drag data unavailable")?,
                    mask(1 | 2 | 16),
                ),
            };
            let position = position.map(|p| offscreen::mouse_event(label, view, window, p.x, p.y));
            TARGETS.with_borrow_mut(|targets| {
                targets.insert(
                    label.into(),
                    Target {
                        id: *id,
                        host: host.clone(),
                        data,
                        pending: HashMap::new(),
                        position,
                        entered: false,
                        dropped: false,
                        allowed,
                        selected: mask(0),
                    },
                )
            });
            if !is_own {
                let data = event_loop.data_transfer(*id).map_err(|e| e.to_string())?;
                let mut types = Vec::new();
                for hint in [TypeHint::UriList, TypeHint::Plaintext, TypeHint::Html] {
                    if data.has_type(&hint) {
                        types.push(hint)
                    }
                }
                #[cfg(target_os = "macos")]
                {
                    use objc2_foundation::NSString;
                    use winit::platform::macos::PasteboardType;
                    // Electron and VS Code package DOM custom types in this
                    // native Chromium format; some sources advertise the
                    // consumer's type directly instead.
                    for (name, pickle) in [
                        ("org.chromium.web-custom-data", true),
                        ("CodeFiles", false),
                        ("codefiles", false),
                        ("application/vnd.code.tree", false),
                        ("application/vnd.code.tree.explorer", false),
                    ] {
                        let native = PasteboardType::from(NSString::from_str(name));
                        if data.has_type(&native) {
                            let serial = event_loop
                                .fetch_data_transfer(*id, &native)
                                .map_err(|e| e.to_string())?;
                            TARGETS.with_borrow_mut(|targets| {
                                if let Some(target) = targets.get_mut(label) {
                                    target.pending.insert(serial, Format::Custom(pickle));
                                }
                            });
                        }
                    }
                }
                for hint in types {
                    let serial = event_loop
                        .fetch_data_transfer(*id, &hint)
                        .map_err(|e| e.to_string())?;
                    TARGETS.with_borrow_mut(|targets| {
                        if let Some(target) = targets.get_mut(label) {
                            target.pending.insert(serial, Format::Hint(hint));
                        }
                    });
                }
            }
            if !is_own
                && TARGETS.with_borrow(|targets| {
                    targets
                        .get(label)
                        .is_some_and(|target| target.pending.is_empty())
                })
            {
                leave(label);
                let _ = event_loop.set_valid_dnd_actions(*id, &[]);
                return Ok(());
            }
            drive(label, event_loop);
        }
        WindowEvent::DragPosition { id, position, .. } => {
            let position = offscreen::mouse_event(label, view, window, position.x, position.y);
            TARGETS.with_borrow_mut(|targets| {
                if let Some(target) = targets.get_mut(label).filter(|t| t.id == *id) {
                    target.position = Some(position.clone())
                }
            });
            // SourceEnd coordinates are in the original view, including cross-window drags.
            let origin = window.surface_position();
            let scale = window.scale_factor();
            let ((left, top), _) = offscreen::logical_bounds(view);
            SOURCE.with_borrow_mut(|source| {
                if let Some(source) = source {
                    if let Some(source_window) = source.view.window() {
                        let original = source_window.surface_position();
                        let ((x, y), _) = offscreen::logical_bounds(&source.view);
                        source.position = (
                            ((f64::from(origin.x - original.x)
                                + (f64::from(position.x) + left) * scale)
                                / source_window.scale_factor()
                                - x)
                                .round() as i32,
                            ((f64::from(origin.y - original.y)
                                + (f64::from(position.y) + top) * scale)
                                / source_window.scale_factor()
                                - y)
                                .round() as i32,
                        )
                    }
                }
            });
            drive(label, event_loop);
        }
        WindowEvent::DataTransferReceived { id, serial, value } => {
            let hint = TARGETS.with_borrow(|targets| {
                targets
                    .get(label)
                    .filter(|t| t.id == *id)
                    .and_then(|t| t.pending.get(serial).copied())
            });
            let Some(hint) = hint else { return Ok(()) };
            // winit documents repeated DataTransferReceived while WouldBlock. Keep the
            // original serial alive until the complete payload, not the first callback.
            enum Payload {
                Uris(Vec<String>),
                Text(String),
            }
            let payload = match hint {
                Format::Hint(TypeHint::UriList) => value.try_as_uris().map(Payload::Uris),
                Format::Hint(_) => value.try_as_string().map(Payload::Text),
                #[cfg(target_os = "macos")]
                Format::Custom(pickle) => value.try_as_bytes().and_then(|bytes| {
                    let values = if pickle {
                        super::drag_data::custom_data(&bytes)
                            .map_err(std::io::Error::other)?
                            .into_iter()
                            .filter(|(key, _)| {
                                matches!(
                                    key.to_ascii_lowercase().as_str(),
                                    "codefiles"
                                        | "application/vnd.code.tree"
                                        | "application/vnd.code.tree.explorer"
                                )
                            })
                            .map(|(_, value)| value)
                            .collect::<Vec<_>>()
                    } else {
                        vec![String::from_utf8(bytes).map_err(std::io::Error::other)?]
                    };
                    Ok(Payload::Uris(
                        values
                            .iter()
                            .flat_map(|value| file_references(value))
                            .collect(),
                    ))
                }),
            };
            let payload = match payload {
                Ok(p) => p,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Deadlock
                    ) =>
                {
                    return Ok(());
                }
                Err(error) => {
                    leave(label);
                    let _ = event_loop.set_valid_dnd_actions(*id, &[]);
                    return Err(format!("Original drag payload is unreadable: {error}"));
                }
            };
            TARGETS.with_borrow_mut(|targets| {
                if let Some(target) = targets.get_mut(label).filter(|t| t.id == *id) {
                    match payload {
                        Payload::Uris(uris) => {
                            for uri in uris {
                                if let Ok(url) = url::Url::parse(&uri) {
                                    if let Ok(path) = url.to_file_path() {
                                        target.data.add_file(
                                            Some(&CefString::from(path.to_string_lossy().as_ref())),
                                            None,
                                        )
                                    } else if target.data.is_link() == 0 {
                                        target
                                            .data
                                            .set_link_url(Some(&CefString::from(uri.as_str())));
                                    }
                                }
                            }
                        }
                        Payload::Text(text) => {
                            if matches!(hint, Format::Hint(TypeHint::Html)) {
                                target
                                    .data
                                    .set_fragment_html(Some(&CefString::from(text.as_str())))
                            } else {
                                target
                                    .data
                                    .set_fragment_text(Some(&CefString::from(text.as_str())))
                            }
                        }
                    }
                    target.pending.remove(serial);
                }
            });
            drive(label, event_loop);
        }
        WindowEvent::DragDropped { id, .. } => {
            TARGETS.with_borrow_mut(|targets| {
                if let Some(target) = targets.get_mut(label).filter(|t| t.id == *id) {
                    target.dropped = true
                }
            });
            drive(label, event_loop);
        }
        WindowEvent::DragLeft { id } => {
            let remove = TARGETS.with_borrow(|targets| {
                targets
                    .get(label)
                    .is_some_and(|t| t.id == *id && !t.dropped)
            });
            if remove {
                leave(label)
            }
        }
        WindowEvent::OutgoingDragDropped { id, action } => finish(Some(*id), *action),
        WindowEvent::OutgoingDragCanceled { id } => {
            let owned = SOURCE.with_borrow(|s| s.as_ref().is_some_and(|s| s.id == Some(*id)));
            if owned {
                finish(None, None)
            }
        }
        WindowEvent::RedrawRequested => {
            let target =
                TARGETS.with_borrow(|targets| targets.get(label).map(|t| (t.id, t.selected)));
            if let Some((id, selected)) = target {
                event_loop
                    .set_valid_dnd_actions(id, &actions(selected))
                    .map_err(|e| e.to_string())?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn file_references(text: &str) -> Vec<String> {
    fn candidate(value: &str, out: &mut Vec<String>) {
        for line in value.lines() {
            let value = line.trim().trim_matches(['\'', '\"']);
            let uri = if value.to_ascii_lowercase().starts_with("file://") {
                url::Url::parse(value)
                    .ok()
                    .filter(|u| u.to_file_path().is_ok())
            } else {
                url::Url::from_file_path(value).ok()
            };
            if let Some(uri) = uri {
                let uri = uri.to_string();
                if !out.contains(&uri) {
                    out.push(uri)
                }
            }
        }
    }
    fn walk(value: &serde_json::Value, out: &mut Vec<String>, depth: usize) {
        if depth > 6 {
            return;
        }
        match value {
            serde_json::Value::String(s) => candidate(s, out),
            serde_json::Value::Array(a) => {
                for v in a {
                    walk(v, out, depth + 1)
                }
            }
            serde_json::Value::Object(o) => {
                for v in o.values() {
                    walk(v, out, depth + 1)
                }
            }
            _ => {}
        }
    }
    let mut values = Vec::new();
    candidate(text, &mut values);
    if let Ok(json) = serde_json::from_str(text) {
        walk(&json, &mut values, 0)
    }
    values
}
