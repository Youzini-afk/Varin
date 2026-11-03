//! Real AppKit sidebar material behind the live CEF/Metal page. The original
//! winit content view remains the input/IME owner and parent of Browser views.
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

/// The old UI contract uses 15 for macOS 15 and 15 for macOS 10.15.
pub fn macos_major() -> u32 {
    #[cfg(target_os = "macos")]
    {
        let version = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        return if version.majorVersion == 10 {
            version.minorVersion
        } else {
            version.majorVersion
        }
        .max(0) as u32;
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// Configure ordinary main/mini-chat windows, never decorative pet windows.
/// Keeping OSR when the preference is off lets startup read settings before
/// deciding whether to install the material, without recreating the page.
pub fn configure<'a, M: Manager<tauri::DynRuntime>>(
    builder: WebviewWindowBuilder<'a, tauri::DynRuntime, M>,
    label: &str,
) -> Result<WebviewWindowBuilder<'a, tauri::DynRuntime, M>, String> {
    #[cfg(target_os = "macos")]
    {
        super::offscreen::transparent(
            builder
                .decorations(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(16., 17.)),
            label,
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = label;
        Ok(builder)
    }
}

/// Resolves only after AppKit has installed/removed the real material. Propagate
/// failure rather than exposing macVibrancy=true for an unavailable native view.
pub async fn apply(window: &WebviewWindow, enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let owned = window.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = send.send(platform::apply(&owned, enabled));
            })
            .map_err(|e| e.to_string())?;
        receive
            .await
            .map_err(|_| "Native vibrancy installation did not complete".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, enabled);
        Ok(false)
    }
}

pub(crate) fn window_event(label: &str, destroyed: bool) {
    #[cfg(target_os = "macos")]
    platform::window_event(label, destroyed);
    #[cfg(not(target_os = "macos"))]
    let _ = (label, destroyed);
}

#[cfg(target_os = "macos")]
pub(crate) use platform::MetalHost;

#[cfg(target_os = "macos")]
mod platform {
    use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSColor, NSView, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow,
        NSWindowOrderingMode,
    };
    use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect};
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
        ptr::NonNull,
        rc::Rc,
        sync::Arc,
    };
    use tauri::{Emitter, Manager, WebviewWindow};
    use winit::{
        raw_window_handle::{AppKitWindowHandle, RawWindowHandle},
        window::Window,
    };

    define_class!(
        #[unsafe(super(NSView))]
        #[name = "VarinCefMetalPresentationView"]
        #[thread_kind = MainThreadOnly]
        pub struct MetalView;
        unsafe impl NSObjectProtocol for MetalView {}
        impl MetalView {
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> { None }
        }
    );
    impl MetalView {
        fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
            unsafe { msg_send![super(Self::alloc(mtm)), initWithFrame: frame] }
        }
    }
    define_class!(
        #[unsafe(super(NSVisualEffectView))]
        #[name = "VarinCefSidebarMaterialView"]
        #[thread_kind = MainThreadOnly]
        struct MaterialView;
        unsafe impl NSObjectProtocol for MaterialView {}
        impl MaterialView {
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> Option<Retained<NSView>> { None }
        }
    );
    impl MaterialView {
        fn new(mtm: MainThreadMarker, frame: NSRect) -> Retained<Self> {
            unsafe { msg_send![super(Self::alloc(mtm)), initWithFrame: frame] }
        }
    }

    /// Kept after the wgpu surface in declaration/drop order. The native surface
    /// targets this exact retained view; the original window also stays alive.
    pub struct MetalHost {
        view: Retained<MetalView>,
        _window: Arc<dyn Window>,
    }
    impl MetalHost {
        pub fn new(window: Arc<dyn Window>) -> Result<Self, String> {
            let mtm =
                MainThreadMarker::new().ok_or("Metal view requires the AppKit main thread")?;
            let handle = window.window_handle().map_err(|e| e.to_string())?;
            let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
                return Err("Native AppKit view is unavailable".into());
            };
            // SAFETY: winit exposes the live NSView and the Arc remains owned here.
            let parent = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
            let view = MetalView::new(mtm, parent.bounds());
            view.setAutoresizingMask(
                NSAutoresizingMaskOptions::ViewWidthSizable
                    | NSAutoresizingMaskOptions::ViewHeightSizable,
            );
            // Above the material, below any genuine native Browser CEF child.
            parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
            let materials: Vec<_> = MATERIALS.with_borrow(|entries| {
                entries
                    .values()
                    .filter(|material| {
                        Retained::as_ptr(&material.parent) == parent as *const NSView
                    })
                    .map(|material| material.view.clone())
                    .collect()
            });
            for material in materials {
                parent.addSubview_positioned_relativeTo(
                    &material,
                    NSWindowOrderingMode::Below,
                    Some(&view),
                );
            }
            Ok(Self {
                view,
                _window: window,
            })
        }
        pub fn raw_handle(&self) -> RawWindowHandle {
            RawWindowHandle::AppKit(AppKitWindowHandle::new(NonNull::from(&*self.view).cast()))
        }
    }
    impl Drop for MetalHost {
        fn drop(&mut self) {
            self.view.removeFromSuperview();
        }
    }

    struct Material {
        view: Retained<MaterialView>,
        parent: Retained<NSView>,
        window: Retained<NSWindow>,
        app: tauri::AppHandle,
        label: String,
        ready: Cell<Option<bool>>,
    }
    impl Material {
        fn refresh(&self) {
            let ready = self.window.isVisible() && !self.window.isMiniaturized();
            if self.ready.replace(Some(ready)) != Some(ready) {
                if ready {
                    self.view.setNeedsDisplay(true);
                    self.view.displayIfNeeded();
                }
                let _ = self.app.emit_to(
                    tauri::EventTarget::webview_window(&self.label),
                    "varin:emit",
                    serde_json::json!({"event":"varin:vibrancy-ready","detail":{"ready":ready}}),
                );
            }
        }
    }
    impl Drop for Material {
        fn drop(&mut self) {
            self.view.removeFromSuperview();
        }
    }
    thread_local! { static MATERIALS: RefCell<HashMap<String, Rc<Material>>> = RefCell::default(); }

    pub fn apply(window: &WebviewWindow, enabled: bool) -> Result<bool, String> {
        let mtm = MainThreadMarker::new().ok_or("Vibrancy requires the AppKit main thread")?;
        if !enabled {
            MATERIALS.with_borrow_mut(|entries| entries.remove(window.label()));
            return Ok(false);
        }
        if let Some(material) =
            MATERIALS.with_borrow(|entries| entries.get(window.label()).cloned())
        {
            material.refresh();
            return Ok(true);
        }
        let pointer = window
            .ns_window()
            .map_err(|e| e.to_string())?
            .cast::<NSWindow>();
        // SAFETY: Tauri's live NSWindow is retained for this presentation.
        let native = unsafe { Retained::retain(pointer) }.ok_or("Native window is unavailable")?;
        let parent = native
            .contentView()
            .ok_or("Native content view is unavailable")?;
        let view = MaterialView::new(mtm, parent.bounds());
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        view.setMaterial(NSVisualEffectMaterial::Sidebar);
        view.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
        view.setState(NSVisualEffectState::FollowsWindowActiveState);
        native.setOpaque(false);
        native.setBackgroundColor(Some(&NSColor::clearColor()));
        parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
        let material = Material {
            view,
            parent,
            window: native,
            app: window.app_handle().clone(),
            label: window.label().into(),
            ready: Cell::new(None),
        };
        material.refresh();
        MATERIALS
            .with_borrow_mut(|entries| entries.insert(window.label().into(), Rc::new(material)));
        Ok(true)
    }
    pub fn window_event(label: &str, destroyed: bool) {
        if destroyed {
            MATERIALS.with_borrow_mut(|entries| entries.remove(label));
        } else if let Some(material) = MATERIALS.with_borrow(|entries| entries.get(label).cloned())
        {
            material.refresh();
        }
    }
}
