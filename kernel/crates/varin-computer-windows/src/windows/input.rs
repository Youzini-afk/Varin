//! One ordered input owner. Only short, nonblocking input sends hold the gate.
//! UIA, synchronous window messages and capture must NEVER execute under it.
use crate::protocol::{Failure, Point, RequestState, Result, normalize_pointer};
use serde_json::Value;
use std::{collections::BTreeMap, mem::size_of, sync::Mutex};
use windows::Win32::{
    Foundation::{GetLastError, HWND, LPARAM, POINT, WPARAM},
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

#[derive(Clone, Copy)]
enum ReleaseEvent {
    Global(INPUT),
    Posted {
        hwnd: isize,
        message: u32,
        wparam: usize,
        lparam: isize,
    },
}
#[derive(Default)]
struct State {
    request: RequestState,
    recent: Option<String>,
    read_only: bool,
    held: BTreeMap<String, ReleaseEvent>,
    window: isize,
    target: isize,
    pid: u32,
    focus: isize,
    original: isize,
    last: isize,
}
#[derive(Default)]
pub struct InputOwner {
    state: Mutex<State>,
}

impl InputOwner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
    pub fn begin(&self, id: &str) -> Result<()> {
        self.begin_request(id, false)
    }
    pub fn begin_request(&self, id: &str, read_only: bool) -> Result<()> {
        let mut state = self.lock();
        state.window = 0;
        state.target = 0;
        state.pid = 0;
        state.focus = 0;
        state.recent = Some(id.to_owned());
        state.read_only = read_only;
        state.request.begin(id)
    }
    pub fn end(&self) {
        let mut state = self.lock();
        state.request.end();
        state.window = 0;
        state.target = 0;
        state.pid = 0;
        state.focus = 0;
    }
    pub fn checkpoint(&self) -> Result<()> {
        self.lock().request.check()
    }
    pub fn semantic(&self) -> Result<()> {
        let mut state = self.lock();
        assert_target(&state)?;
        state.request.attempt_semantic()
    }
    pub fn mechanism(&self, mechanism: &str) {
        self.lock().request.mechanism(mechanism);
    }
    pub fn observed_state(&self, state: Value) {
        self.lock().request.observed_state(state);
    }
    pub fn verify(&self) {
        self.lock().request.verify();
    }
    pub fn receipt(&self, error: Option<&Failure>) -> Value {
        self.lock().request.receipt(error)
    }
    pub fn failure(&self, error: &Failure) -> Value {
        self.lock().request.failure(error)
    }

    pub fn bind_window(&self, hwnd: HWND, pid: u32) -> Result<()> {
        let mut state = self.lock();
        state.request.check()?;
        state.target = hwnd.0 as isize;
        state.pid = pid;
        assert_target(&state)
    }
    pub fn activate(&self, hwnd: HWND, pid: u32) -> Result<()> {
        self.bind_window(hwnd, pid)?;
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return Err(Failure::new(
                    "target-unavailable",
                    "The target window no longer exists",
                ));
            }
            let previous = GetForegroundWindow();
            if previous != hwnd {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindowAsync(hwnd, SW_RESTORE);
                }
                let _ = SetForegroundWindow(hwnd);
                if GetForegroundWindow() != hwnd {
                    let foreground = GetWindowThreadProcessId(GetForegroundWindow(), None);
                    let current = GetCurrentThreadId();
                    let attached = foreground != 0
                        && foreground != current
                        && AttachThreadInput(current, foreground, true).as_bool();
                    let _ = SetForegroundWindow(hwnd);
                    if attached {
                        let _ = AttachThreadInput(current, foreground, false);
                    }
                }
                if GetForegroundWindow() != hwnd {
                    return Err(Failure::new(
                        "focus-changed",
                        "The target window could not obtain foreground focus",
                    ));
                }
            }
            let mut state = self.lock();
            state.request.check()?;
            if previous != hwnd && state.original == 0 {
                state.original = previous.0 as isize;
            }
            state.window = hwnd.0 as isize;
            state.last = hwnd.0 as isize;
        }
        Ok(())
    }
    pub fn bind_keyboard(&self) -> Result<()> {
        let mut state = self.lock();
        assert_target(&state)?;
        let focus = native_focus(HWND(state.window as *mut _))?;
        if focus.0.is_null() || !owns(HWND(state.target as *mut _), focus) {
            return Err(Failure::new(
                "focus-changed",
                "The target has no keyboard focus",
            ));
        }
        state.focus = focus.0 as isize;
        Ok(())
    }
    pub fn send(&self, events: &[INPUT]) -> Result<()> {
        let mut state = self.lock();
        assert_target(&state)?;
        send_locked(&mut state, events)
    }
    /// Send the absolute move and button/wheel in one OS input batch. Physical
    /// user movement cannot redirect a down/wheel between a separate move and
    /// dispatch (notably during the drag's settling allowance).
    pub fn pointer(&self, at: Point, events: &[INPUT]) -> Result<()> {
        let mut state = self.lock();
        assert_target(&state)?;
        let point = POINT {
            x: coordinate(at.x)?,
            y: coordinate(at.y)?,
        };
        unsafe {
            if state.target != 0 && !owns(HWND(state.target as *mut _), WindowFromPoint(point)) {
                return Err(Failure::new(
                    "target-changed",
                    "The pointer target is covered by another window",
                ));
            }
            let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            let x = normalize_pointer(point.x, left, width)?;
            let y = normalize_pointer(point.y, top, height)?;
            let movement = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: x,
                        dy: y,
                        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        ..Default::default()
                    },
                },
            };
            let mut batch = Vec::with_capacity(events.len() + 1);
            batch.push(movement);
            batch.extend_from_slice(events);
            send_locked(&mut state, &batch)
        }
    }
    pub fn move_pointer(&self, point: Point) -> Result<()> {
        let mut state = self.lock();
        assert_target(&state)?;
        let point = POINT {
            x: coordinate(point.x)?,
            y: coordinate(point.y)?,
        };
        unsafe {
            if state.window != 0 {
                let hwnd = HWND(state.window as *mut _);
                let owner = WindowFromPoint(point);
                if owner != hwnd && !IsChild(hwnd, owner).as_bool() {
                    return Err(Failure::new(
                        "target-changed",
                        "The pointer target is covered by another window",
                    ));
                }
            }
            SetCursorPos(point.x, point.y).map_err(|_| {
                Failure::new("input-rejected", "Windows did not accept pointer movement")
            })?;
        }
        state.request.accept(1);
        Ok(())
    }
    pub fn post(&self, hwnd: HWND, message: u32, wparam: usize, lparam: isize) -> Result<()> {
        let mut state = self.lock();
        assert_target(&state)?;
        if state.target != 0 && !owns(HWND(state.target as *mut _), hwnd) {
            return Err(Failure::new(
                "target-changed",
                "The control no longer belongs to the selected window",
            ));
        }
        // PostMessage is asynchronous and bounded by the system queue. No SendMessage here.
        unsafe { PostMessageW(Some(hwnd), message, WPARAM(wparam), LPARAM(lparam)) }.map_err(
            |_| {
                Failure::new(
                    "input-rejected",
                    "Windows did not accept the window input message",
                )
            },
        )?;
        state.request.accept(1);
        let transition = match message {
            WM_KEYDOWN | WM_KEYUP => Some((
                format!("post:{}:key:{wparam}", hwnd.0 as usize),
                WM_KEYUP,
                message == WM_KEYUP,
            )),
            WM_LBUTTONDOWN | WM_LBUTTONUP => Some((
                format!("post:{}:left", hwnd.0 as usize),
                WM_LBUTTONUP,
                message == WM_LBUTTONUP,
            )),
            WM_RBUTTONDOWN | WM_RBUTTONUP => Some((
                format!("post:{}:right", hwnd.0 as usize),
                WM_RBUTTONUP,
                message == WM_RBUTTONUP,
            )),
            WM_MBUTTONDOWN | WM_MBUTTONUP => Some((
                format!("post:{}:middle", hwnd.0 as usize),
                WM_MBUTTONUP,
                message == WM_MBUTTONUP,
            )),
            _ => None,
        };
        if let Some((key, up, is_up)) = transition {
            if is_up {
                state.held.remove(&key);
            } else {
                state.held.insert(
                    key,
                    ReleaseEvent::Posted {
                        hwnd: hwnd.0 as isize,
                        message: up,
                        wparam: if up == WM_KEYUP { wparam } else { 0 },
                        lparam,
                    },
                );
            }
        }
        Ok(())
    }
    /// A successful acknowledgement is after fencing and release, in the same
    /// critical section as SendInput/PostMessage; no old request can send after it.
    pub fn cancel(&self, request: &str) -> bool {
        let mut state = self.lock();
        // The Host can cancel after the native response was written but before
        // it observed that response. Preserve the just-finished input identity.
        if state.recent.as_deref() == Some(request) && !state.request.is_active(request) {
            return state.read_only || release_held(&mut state);
        }
        state.request.cancel(request);
        if state.request.is_active(request) && !state.read_only {
            release_held(&mut state)
        } else {
            true
        }
    }
    pub fn interrupt(&self, restore: bool) -> bool {
        let mut state = self.lock();
        state.request.retire();
        let released = release_held(&mut state);
        let focus = take_focus(&mut state, restore);
        drop(state);
        restore_focus(focus);
        released
    }
    pub fn release(&self, restore: bool) -> Result<()> {
        let mut state = self.lock();
        let released = release_held(&mut state);
        let focus = take_focus(&mut state, restore);
        drop(state);
        restore_focus(focus);
        if released {
            Ok(())
        } else {
            Err(Failure::new(
                "input-rejected",
                "Windows did not confirm release of managed input",
            ))
        }
    }
}

pub fn coordinate(value: f64) -> Result<i32> {
    if !value.is_finite() || value.round() < i32::MIN as f64 || value.round() > i32::MAX as f64 {
        return Err(Failure::new(
            "invalid-request",
            "Coordinate is outside the Windows desktop coordinate range",
        ));
    }
    Ok(value.round() as i32)
}
fn native_focus(hwnd: HWND) -> Result<HWND> {
    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetGUIThreadInfo(GetWindowThreadProcessId(hwnd, None), &mut info) }
        .map_err(|_| Failure::new("focus-changed", "The target keyboard focus is unavailable"))?;
    Ok(info.hwndFocus)
}
fn assert_target(state: &State) -> Result<()> {
    state.request.check()?;
    if state.target != 0 {
        let target = HWND(state.target as *mut _);
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(target, Some(&mut pid));
        }
        if !unsafe { IsWindow(Some(target)).as_bool() } || pid != state.pid {
            return Err(Failure::new(
                "target-changed",
                "The selected window identity changed; observe again",
            ));
        }
    }
    if state.window != 0 && unsafe { GetForegroundWindow().0 as isize } != state.window {
        return Err(Failure::new(
            "focus-changed",
            "The target window lost foreground focus",
        ));
    }
    if state.focus != 0
        && (native_focus(HWND(state.window as *mut _))?.0 as isize != state.focus
            || !owns(HWND(state.target as *mut _), HWND(state.focus as *mut _)))
    {
        return Err(Failure::new(
            "focus-changed",
            "Keyboard focus moved to another control",
        ));
    }
    Ok(())
}
fn owns(root: HWND, child: HWND) -> bool {
    root == child || unsafe { IsChild(root, child).as_bool() }
}
fn take_focus(state: &mut State, restore: bool) -> Option<(isize, isize)> {
    if !restore {
        return None;
    }
    let result = Some((state.original, state.last));
    state.original = 0;
    state.last = 0;
    result
}
fn restore_focus(pair: Option<(isize, isize)>) {
    if let Some((original, last)) = pair {
        unsafe {
            if original != 0
                && IsWindow(Some(HWND(original as *mut _))).as_bool()
                && GetForegroundWindow().0 as isize == last
            {
                let _ = SetForegroundWindow(HWND(original as *mut _));
            }
        }
    }
}
fn release_held(state: &mut State) -> bool {
    state.held.retain(|_, event| !match *event {
        ReleaseEvent::Global(input) => unsafe {
            SendInput(&[input], size_of::<INPUT>() as i32) == 1
        },
        ReleaseEvent::Posted {
            hwnd,
            message,
            wparam,
            lparam,
        } => unsafe {
            PostMessageW(
                Some(HWND(hwnd as *mut _)),
                message,
                WPARAM(wparam),
                LPARAM(lparam),
            )
            .is_ok()
        },
    });
    state.held.is_empty()
}
fn send_locked(state: &mut State, events: &[INPUT]) -> Result<()> {
    let sent = unsafe { SendInput(events, size_of::<INPUT>() as i32) } as usize;
    for event in events.iter().take(sent) {
        if let Some((key, up, is_up)) = held_event(*event) {
            if is_up {
                state.held.remove(&key);
            } else {
                state.held.insert(key, ReleaseEvent::Global(up));
            }
        }
    }
    state.request.accept(sent as u64);
    if sent != events.len() {
        return Err(Failure::new(
            "input-rejected",
            format!(
                "Windows accepted {sent} of {} input events (error {}). OS acceptance does not confirm target application completion",
                events.len(),
                unsafe { GetLastError().0 }
            ),
        ));
    }
    Ok(())
}
fn held_event(event: INPUT) -> Option<(String, INPUT, bool)> {
    unsafe {
        if event.r#type == INPUT_KEYBOARD {
            let key = event.Anonymous.ki;
            return Some((
                format!("key:{}:{}", key.wVk.0, key.wScan),
                key_event(key.wVk.0, key.wScan, key.dwFlags | KEYEVENTF_KEYUP),
                key.dwFlags.contains(KEYEVENTF_KEYUP),
            ));
        }
        if event.r#type == INPUT_MOUSE {
            let mouse = event.Anonymous.mi;
            for (down, up) in [
                (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            ] {
                if mouse.dwFlags.contains(down) || mouse.dwFlags.contains(up) {
                    return Some((
                        format!("mouse:{}", down.0),
                        mouse_event(up, 0),
                        mouse.dwFlags.contains(up),
                    ));
                }
            }
        }
        None
    }
}
pub fn key_event(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
pub fn mouse_event(flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                mouseData: data,
                ..Default::default()
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_read_does_not_release_another_requests_held_input() {
        let owner = InputOwner::default();
        // An internal held-event sentinel, not a sent key. No native dispatch
        // should be attempted by either active or just-finished read cancellation.
        owner.lock().held.insert(
            "sentinel".into(),
            ReleaseEvent::Posted {
                hwnd: 0,
                message: WM_NULL,
                wparam: 0,
                lparam: 0,
            },
        );
        owner.begin_request("read", true).unwrap();
        assert!(owner.cancel("read"));
        assert_eq!(owner.lock().held.len(), 1);
        assert_eq!(owner.checkpoint().unwrap_err().code, "cancelled");
        owner.end();
        assert!(owner.cancel("read"));
        assert_eq!(owner.lock().held.len(), 1);
        owner.begin_request("other-read", true).unwrap();
        assert!(owner.checkpoint().is_ok());
        assert!(owner.cancel("unrelated"));
        assert!(owner.checkpoint().is_ok());
        assert_eq!(owner.lock().held.len(), 1);
    }
}
