//! Mouse-move forwarding while the companion is genuinely click-through.
//! Monitor only pointer movement, only while a surface requests forwarding;
//! never consume the native event or observe keyboard input.
use std::sync::Arc;
use winit::window::Window;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{cell::Cell, ffi::c_void};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    type Handle = *mut c_void;
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetWindowsHookExW(
            kind: i32,
            callback: unsafe extern "system" fn(i32, usize, isize) -> isize,
            module: Handle,
            thread: u32,
        ) -> Handle;
        fn UnhookWindowsHookEx(hook: Handle) -> i32;
        fn CallNextHookEx(hook: Handle, code: i32, message: usize, data: isize) -> isize;
        fn GetCursorPos(point: *mut Point) -> i32;
        fn ScreenToClient(window: Handle, point: *mut Point) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleExW(flags: u32, address: *const u16, module: *mut Handle) -> i32;
    }
    thread_local! { static HOOK: Cell<Handle> = const { Cell::new(std::ptr::null_mut()) }; }
    unsafe extern "system" fn moved(code: i32, message: usize, data: isize) -> isize {
        if code >= 0 && message == 0x0200 {
            super::super::offscreen::forward_passthrough_mouse();
        }
        // A transparent companion must not intercept the underlying app's clicks.
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
    }
    pub fn set_active(active: bool) -> Result<(), String> {
        HOOK.with(|slot| {
            let current = slot.get();
            if active && current.is_null() {
                let mut module = std::ptr::null_mut();
                // Our hook lives in the bootstrap-loaded application DLL, not
                // bootstrap.exe. Resolve its actual module without changing refs.
                if unsafe { GetModuleHandleExW(6, moved as *const () as *const u16, &mut module) }
                    == 0
                {
                    return Err("Mouse-forwarding module could not be identified".into());
                }
                let hook = unsafe { SetWindowsHookExW(14, moved, module, 0) }; // WH_MOUSE_LL
                if hook.is_null() {
                    return Err("Native mouse forwarding could not be enabled".into());
                }
                slot.set(hook);
            } else if !active && !current.is_null() {
                if unsafe { UnhookWindowsHookEx(current) } == 0 {
                    return Err("Native mouse forwarding could not be removed".into());
                }
                slot.set(std::ptr::null_mut());
            }
            Ok(())
        })
    }
    pub fn position(window: &Arc<dyn Window>) -> Option<(f64, f64)> {
        let handle = window.window_handle().ok()?;
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return None;
        };
        let mut point = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0
            || unsafe { ScreenToClient(handle.hwnd.get() as Handle, &mut point) } == 0
        {
            return None;
        }
        Some((f64::from(point.x), f64::from(point.y)))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSEvent, NSEventMask, NSView};
    use std::{cell::RefCell, ptr::NonNull};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    struct Monitors {
        global: Retained<AnyObject>,
        local: Retained<AnyObject>,
    }
    impl Drop for Monitors {
        fn drop(&mut self) {
            // Both tokens came from NSEvent's matching monitor registration.
            unsafe {
                NSEvent::removeMonitor(&self.global);
                NSEvent::removeMonitor(&self.local);
            }
        }
    }
    thread_local! { static MONITORS: RefCell<Option<Monitors>> = const { RefCell::new(None) }; }
    pub fn set_active(active: bool) -> Result<(), String> {
        MONITORS.with(|slot| {
            let mut slot = slot.borrow_mut();
            if active && slot.is_none() {
                let mask = NSEventMask::MouseMoved
                    | NSEventMask::LeftMouseDragged
                    | NSEventMask::RightMouseDragged
                    | NSEventMask::OtherMouseDragged;
                let global_block = RcBlock::new(|_event: NonNull<NSEvent>| {
                    super::super::offscreen::forward_passthrough_mouse()
                });
                let global =
                    NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global_block)
                        .ok_or("Global mouse forwarding could not be enabled")?;
                let local_block = RcBlock::new(|event: NonNull<NSEvent>| {
                    super::super::offscreen::forward_passthrough_mouse();
                    event.as_ptr()
                });
                let Some(local) = (unsafe {
                    NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local_block)
                }) else {
                    unsafe {
                        NSEvent::removeMonitor(&global);
                    }
                    return Err("Application mouse forwarding could not be enabled".into());
                };
                *slot = Some(Monitors { global, local });
            } else if !active {
                slot.take();
            }
            Ok(())
        })
    }
    pub fn position(window: &Arc<dyn Window>) -> Option<(f64, f64)> {
        let handle = window.window_handle().ok()?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return None;
        };
        // Borrow only on AppKit's main thread while the winit window owns it.
        let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        let native = view.window()?;
        let point = native.convertPointFromScreen(NSEvent::mouseLocation());
        let point = view.convertPoint_fromView(point, None);
        let y = if view.isFlipped() {
            point.y
        } else {
            view.bounds().size.height - point.y
        };
        let scale = window.scale_factor();
        Some((point.x * scale, y * scale))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    // Electron's forward:true is supported only on Windows and macOS too.
    pub fn set_active(_active: bool) -> Result<(), String> {
        Ok(())
    }
    pub fn position(_window: &Arc<dyn Window>) -> Option<(f64, f64)> {
        None
    }
}
pub use platform::{position, set_active};
