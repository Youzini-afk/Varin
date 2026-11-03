//! Keep-awake leases are native resources, released only by their owning shell.
//! They inhibit idle system sleep, never claim to prevent explicit user sleep.
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
#[derive(Default)]
pub struct PowerManager {
    lease: Mutex<Option<Lease>>,
}
#[cfg(target_os = "linux")]
struct Lease {
    _connection: zbus::Connection,
    _descriptor: zbus::zvariant::OwnedFd,
}
#[cfg(target_os = "macos")]
struct Lease(u32);
#[cfg(windows)]
struct Lease;
impl PowerManager {
    pub async fn status(&self, enabled: bool) -> Value {
        json!({"supported":true,"enabled":enabled,"active":self.lease.lock().await.is_some()})
    }
    pub async fn set(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        let mut lease = self.lease.lock().await;
        if enabled == lease.is_some() {
            return Ok(());
        }
        if enabled {
            *lease = Some(acquire(app).await?);
        } else if let Some(value) = lease.as_ref() {
            release(app, value).await?;
            // Retain the ownership receipt on a failed OS release for retry.
            lease.take();
        }
        Ok(())
    }
}
#[cfg(target_os = "linux")]
async fn acquire(_app: &AppHandle) -> Result<Lease, String> {
    let connection = zbus::Connection::system()
        .await
        .map_err(|_| "System power service is unavailable")?;
    let proxy = zbus::Proxy::new(
        &connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await
    .map_err(|_| "System power manager is unavailable")?;
    let descriptor: zbus::zvariant::OwnedFd = proxy
        .call(
            "Inhibit",
            &(
                "sleep",
                "Varin",
                "Keep Varin background work running",
                "block",
            ),
        )
        .await
        .map_err(|_| "System power manager refused the sleep inhibitor")?;
    Ok(Lease {
        _connection: connection,
        _descriptor: descriptor,
    })
}
#[cfg(target_os = "linux")]
async fn release(_app: &AppHandle, _lease: &Lease) -> Result<(), String> {
    Ok(())
}
#[cfg(windows)]
async fn acquire(app: &AppHandle) -> Result<Lease, String> {
    app.run_on_main_thread_blocking(|| {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetThreadExecutionState(flags: u32) -> u32;
        }
        // SAFETY: OS API has no pointer arguments; the main thread owns the lease.
        if unsafe { SetThreadExecutionState(0x80000001) } == 0 {
            Err("Windows refused the sleep inhibitor".into())
        } else {
            Ok(Lease)
        }
    })
    .map_err(|_| "Power owner is unavailable")?
}
#[cfg(windows)]
async fn release(app: &AppHandle, _lease: &Lease) -> Result<(), String> {
    app.run_on_main_thread_blocking(|| {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetThreadExecutionState(flags: u32) -> u32;
        }
        // SAFETY: release on exactly the thread which acquired the execution state.
        if unsafe { SetThreadExecutionState(0x80000000) } == 0 {
            Err("Windows sleep inhibitor release is unconfirmed".into())
        } else {
            Ok(())
        }
    })
    .map_err(|_| "Power owner is unavailable")?
}
#[cfg(target_os = "macos")]
async fn acquire(app: &AppHandle) -> Result<Lease, String> {
    app.run_on_main_thread_blocking(|| {
        use core_foundation_sys::{
            base::{CFRelease, kCFAllocatorDefault},
            string::{CFStringCreateWithCString, CFStringRef, kCFStringEncodingUTF8},
        };
        #[link(name = "IOKit", kind = "framework")]
        unsafe extern "C" {
            fn IOPMAssertionCreateWithName(
                kind: CFStringRef,
                level: u32,
                name: CFStringRef,
                id: *mut u32,
            ) -> i32;
        }
        // SAFETY: both static C strings are NUL-terminated; owned CF objects live
        // through the call and are released once regardless of OS success.
        unsafe {
            let kind = CFStringCreateWithCString(
                kCFAllocatorDefault,
                c"PreventUserIdleSystemSleep".as_ptr(),
                kCFStringEncodingUTF8,
            );
            let name = CFStringCreateWithCString(
                kCFAllocatorDefault,
                c"Varin background work".as_ptr(),
                kCFStringEncodingUTF8,
            );
            if kind.is_null() || name.is_null() {
                if !kind.is_null() {
                    CFRelease(kind.cast())
                }
                if !name.is_null() {
                    CFRelease(name.cast())
                }
                return Err("Power assertion name could not be allocated".into());
            }
            let mut id = 0;
            let result = IOPMAssertionCreateWithName(kind, 255, name, &mut id);
            CFRelease(kind.cast());
            CFRelease(name.cast());
            if result == 0 {
                Ok(Lease(id))
            } else {
                Err("macOS refused the sleep inhibitor".into())
            }
        }
    })
    .map_err(|_| "Power owner is unavailable")?
}
#[cfg(target_os = "macos")]
async fn release(app: &AppHandle, lease: &Lease) -> Result<(), String> {
    let id = lease.0;
    app.run_on_main_thread_blocking(move || {
        #[link(name = "IOKit", kind = "framework")]
        unsafe extern "C" {
            fn IOPMAssertionRelease(id: u32) -> i32;
        }
        // SAFETY: the ID belongs to the successful acquire in this owner.
        if unsafe { IOPMAssertionRelease(id) } == 0 {
            Ok(())
        } else {
            Err("macOS sleep inhibitor release is unconfirmed".into())
        }
    })
    .map_err(|_| "Power owner is unavailable")?
}
