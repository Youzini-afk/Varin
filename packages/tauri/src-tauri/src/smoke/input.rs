//! Fixed native acceptance input. No arbitrary-input IPC or command-line API.
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
pub async fn click(app: &AppHandle, x: f64, y: f64) -> Result<Value, String> {
    let window = app
        .get_window("main")
        .ok_or("The original main window is unavailable")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let position = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if !scale.is_finite() || scale <= 0. || !x.is_finite() || !y.is_finite() {
        return Err("Native input coordinate is invalid".into());
    }
    let physical = (
        f64::from(position.x) + x * scale,
        f64::from(position.y) + y * scale,
    );
    // AppKit exposes global event coordinates in points; winit's inner_position
    // is physical at this window's backing scale.
    #[cfg(target_os = "macos")]
    let target = (physical.0 / scale, physical.1 / scale);
    #[cfg(not(target_os = "macos"))]
    let target = physical;
    tokio::task::spawn_blocking(move || native::click(target.0, target.1))
        .await
        .map_err(|_| "Native input executor ended without an outcome")??;
    Ok(
        json!({"source":native::SOURCE,"screenX":target.0,"screenY":target.1,"windowScale":scale,"cursorRestored":true}),
    )
}
#[cfg(windows)]
mod native {
    pub const SOURCE: &str = "Win32 SendInput";
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Mouse {
        dx: i32,
        dy: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    union Data {
        mouse: Mouse,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        data: Data,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn SendInput(count: u32, input: *const Input, size: i32) -> u32;
    }
    pub fn click(x: f64, y: f64) -> Result<(), String> {
        let mut previous = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut previous) } == 0 {
            return Err("Native cursor position is not observable".into());
        }
        if unsafe { SetCursorPos(x.round() as i32, y.round() as i32) } == 0 {
            return Err("Native mouse movement was denied".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
        let inputs = [2, 4].map(|flags| Input {
            kind: 0,
            data: Data {
                mouse: Mouse {
                    dx: 0,
                    dy: 0,
                    data: 0,
                    flags,
                    time: 0,
                    extra: 0,
                },
            },
        });
        let accepted =
            unsafe { SendInput(2, inputs.as_ptr(), std::mem::size_of::<Input>() as i32) };
        // Release even if Windows accepted only the down event. A partial receipt is
        // failure, never a reason to leave the physical button held.
        if accepted == 1 {
            unsafe { SendInput(1, &inputs[1], std::mem::size_of::<Input>() as i32) };
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        let restored = unsafe { SetCursorPos(previous.x, previous.y) } != 0;
        if accepted != 2 || !restored {
            return Err(
                "Windows did not acknowledge the full native click and cursor restoration".into(),
            );
        }
        Ok(())
    }
}
#[cfg(target_os = "macos")]
mod native {
    pub const SOURCE: &str = "CoreGraphics CGEventPost";
    use std::ffi::c_void;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightPostEventAccess() -> bool;
        fn CGEventCreate(source: *const c_void) -> *mut c_void;
        fn CGEventGetLocation(event: *const c_void) -> Point;
        fn CGEventCreateMouseEvent(
            source: *const c_void,
            kind: u32,
            position: Point,
            button: u32,
        ) -> *mut c_void;
        fn CGEventPost(tap: u32, event: *const c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }
    fn post(kind: u32, point: Point) -> Result<(), String> {
        let event = unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, point, 0) };
        if event.is_null() {
            return Err("Native macOS input event could not be created".into());
        }
        unsafe {
            CGEventPost(0, event);
            CFRelease(event)
        };
        Ok(())
    }
    pub fn click(x: f64, y: f64) -> Result<(), String> {
        if !unsafe { CGPreflightPostEventAccess() } {
            return Err("This native runner lacks macOS event-posting permission; no synthetic browser fallback was used".into());
        }
        let event = unsafe { CGEventCreate(std::ptr::null()) };
        if event.is_null() {
            return Err("Native cursor position is not observable".into());
        }
        let previous = unsafe { CGEventGetLocation(event) };
        unsafe { CFRelease(event) };
        let point = Point { x, y };
        let result = (|| {
            post(5, point)?;
            std::thread::sleep(std::time::Duration::from_millis(30));
            post(1, point)?;
            post(2, point)
        })();
        if result.is_err() {
            let _ = post(2, point);
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
        let restored = post(5, previous);
        result?;
        restored
    }
}
#[cfg(target_os = "linux")]
mod native {
    pub const SOURCE: &str = "X11 XTEST";
    use std::ffi::{c_char, c_int, c_uint, c_ulong, c_void};
    #[link(name = "X11")]
    unsafe extern "C" {
        fn XOpenDisplay(name: *const c_char) -> *mut c_void;
        fn XCloseDisplay(display: *mut c_void) -> c_int;
        fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
        fn XDefaultScreen(display: *mut c_void) -> c_int;
        fn XQueryPointer(
            display: *mut c_void,
            window: c_ulong,
            root: *mut c_ulong,
            child: *mut c_ulong,
            root_x: *mut c_int,
            root_y: *mut c_int,
            win_x: *mut c_int,
            win_y: *mut c_int,
            mask: *mut c_uint,
        ) -> c_int;
        fn XSync(display: *mut c_void, discard: c_int) -> c_int;
    }
    #[link(name = "dl")]
    unsafe extern "C" {
        fn dlopen(name: *const c_char, flags: c_int) -> *mut c_void;
        fn dlsym(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn dlclose(module: *mut c_void) -> c_int;
    }
    struct Native {
        display: *mut c_void,
        module: *mut c_void,
    }
    impl Drop for Native {
        fn drop(&mut self) {
            unsafe {
                if !self.display.is_null() {
                    XCloseDisplay(self.display);
                }
                if !self.module.is_null() {
                    dlclose(self.module);
                }
            }
        }
    }
    impl Native {
        unsafe fn symbol<T: Copy>(&self, name: &std::ffi::CStr) -> Result<T, String> {
            let symbol = unsafe { dlsym(self.module, name.as_ptr()) };
            if symbol.is_null() || std::mem::size_of::<T>() != std::mem::size_of_val(&symbol) {
                return Err("The native XTEST entry point is unavailable".into());
            }
            Ok(unsafe { std::mem::transmute_copy(&symbol) })
        }
    }
    pub fn click(x: f64, y: f64) -> Result<(), String> {
        let native = Native {
            display: unsafe { XOpenDisplay(std::ptr::null()) },
            module: unsafe { dlopen(c"libXtst.so.6".as_ptr(), 2) },
        };
        if native.display.is_null() || native.module.is_null() {
            return Err(
                "A real X11 display and libXtst are required for native mouse acceptance".into(),
            );
        }
        type Motion = unsafe extern "C" fn(*mut c_void, c_int, c_int, c_int, c_ulong) -> c_int;
        type Button = unsafe extern "C" fn(*mut c_void, c_uint, c_int, c_ulong) -> c_int;
        type Query = unsafe extern "C" fn(
            *mut c_void,
            *mut c_int,
            *mut c_int,
            *mut c_int,
            *mut c_int,
        ) -> c_int;
        let motion: Motion = unsafe { native.symbol(c"XTestFakeMotionEvent") }?;
        let button: Button = unsafe { native.symbol(c"XTestFakeButtonEvent") }?;
        let query: Query = unsafe { native.symbol(c"XTestQueryExtension") }?;
        let (mut event, mut error, mut major, mut minor) = (0, 0, 0, 0);
        if unsafe {
            query(
                native.display,
                &mut event,
                &mut error,
                &mut major,
                &mut minor,
            )
        } == 0
        {
            return Err("The native X server does not provide XTEST".into());
        }
        let (mut root, mut child, mut old_x, mut old_y, mut win_x, mut win_y, mut mask) =
            (0, 0, 0, 0, 0, 0, 0);
        if unsafe {
            XQueryPointer(
                native.display,
                XDefaultRootWindow(native.display),
                &mut root,
                &mut child,
                &mut old_x,
                &mut old_y,
                &mut win_x,
                &mut win_y,
                &mut mask,
            )
        } == 0
        {
            return Err("Native X11 cursor is not observable".into());
        }
        let screen = unsafe { XDefaultScreen(native.display) };
        let moved = unsafe {
            motion(
                native.display,
                screen,
                x.round() as i32,
                y.round() as i32,
                0,
            )
        };
        unsafe { XSync(native.display, 0) };
        std::thread::sleep(std::time::Duration::from_millis(30));
        let down = unsafe { button(native.display, 1, 1, 0) };
        let up = unsafe { button(native.display, 1, 0, 0) };
        unsafe { XSync(native.display, 0) };
        std::thread::sleep(std::time::Duration::from_millis(120));
        let restored = unsafe { motion(native.display, screen, old_x, old_y, 0) };
        unsafe { XSync(native.display, 0) };
        if moved == 0 || down == 0 || up == 0 || restored == 0 {
            return Err("XTEST did not accept the full native click and cursor restoration".into());
        }
        Ok(())
    }
}
