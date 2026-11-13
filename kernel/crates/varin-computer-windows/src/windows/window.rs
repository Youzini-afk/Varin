//! Top-level window inventory and deterministic selection. Selection is kept
//! independent of Win32 so ambiguity and placeholder filtering can be tested
//! without claiming that a simulated desktop validates native behavior.
use crate::protocol::{Failure, Rect, Result};
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
pub struct Window {
    pub handle: isize,
    pub title: String,
    pub bounds: Rect,
    pub visible: bool,
    pub minimized: bool,
    pub cloaked: bool,
    pub auxiliary: bool,
    pub main: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    pub pid: u32,
    pub window_title: String,
    pub windows: Vec<Window>,
}

fn app_windows(windows: &[Window], selected: Option<isize>, foreground: isize) -> Vec<Window> {
    let mut result: Vec<_> = windows
        .iter()
        .filter(|window| {
            selected == Some(window.handle)
                || (window.visible
                    && !window.cloaked
                    && !window.auxiliary
                    && window.bounds.width > 1.0
                    && window.bounds.height > 1.0)
        })
        .cloned()
        .collect();
    result.sort_by(|a, b| {
        (b.handle == foreground)
            .cmp(&(a.handle == foreground))
            .then((!b.minimized).cmp(&(!a.minimized)))
            .then((!b.title.trim().is_empty()).cmp(&(!a.title.trim().is_empty())))
            .then_with(|| {
                (b.bounds.width * b.bounds.height).total_cmp(&(a.bounds.width * a.bounds.height))
            })
    });
    result
}

fn app_match<'a>(apps: &'a [App], query: &str, foreground: isize) -> Option<(&'a App, bool)> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    if let Ok(pid) = query.parse::<u32>() {
        if let Some(app) = apps.iter().find(|app| app.pid == pid) {
            return Some((app, false));
        }
    }
    let mut ordered: Vec<_> = apps.iter().collect();
    ordered.sort_by_key(|app| {
        (
            app_windows(&app.windows, None, foreground).is_empty(),
            !app.windows.iter().any(|window| window.handle == foreground),
        )
    });
    let query = query.to_lowercase();
    let process = query.strip_suffix(".exe").unwrap_or(&query);
    if let Some(app) = ordered
        .iter()
        .find(|app| app.name.to_lowercase() == process)
    {
        return Some((app, false));
    }
    for exact in [true, false] {
        if let Some(app) = ordered.iter().find(|app| {
            app.windows.iter().any(|window| {
                let title = window.title.to_lowercase();
                if exact {
                    title == query
                } else {
                    title.contains(&query)
                }
            })
        }) {
            return Some((app, true));
        }
    }
    None
}

fn select_window<'a>(
    app: &'a App,
    selector: &Value,
    title_query: Option<&str>,
    foreground: isize,
) -> Result<&'a Window> {
    let value = match selector {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => title_query.filter(|s| !s.is_empty()).map(str::to_owned),
    };
    if let Some(selector) = value {
        if let Ok(handle) = selector.parse::<isize>() {
            return app
                .windows
                .iter()
                .find(|window| window.handle == handle)
                .ok_or_else(|| {
                    Failure::new(
                        "target-changed",
                        "Window handle does not belong to the selected application; observe again",
                    )
                });
        }
        let title = selector.to_lowercase();
        let mut matches: Vec<_> = app
            .windows
            .iter()
            .filter(|window| window.title.to_lowercase() == title)
            .collect();
        if matches.is_empty() {
            matches = app
                .windows
                .iter()
                .filter(|window| window.title.to_lowercase().contains(&title))
                .collect();
        }
        return match matches.as_slice() {
            [window] => Ok(*window),
            [] => Err(Failure::new(
                "target-unavailable",
                "No window of the selected application matches the title",
            )),
            _ => Err(Failure::new(
                "target-changed",
                "Multiple windows match the title; choose a window handle from apps",
            )),
        };
    }
    let candidates = app_windows(&app.windows, None, foreground);
    let handle = candidates
        .first()
        .map(|window| window.handle)
        .ok_or_else(|| {
            Failure::new(
                "target-unavailable",
                "No visible application window; select an explicit window from apps",
            )
        })?;
    Ok(app
        .windows
        .iter()
        .find(|window| window.handle == handle)
        .expect("candidate belongs to app"))
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::protocol::Request;
    use serde_json::json;
    use std::{
        collections::{BTreeMap, HashMap, HashSet},
        mem::size_of,
    };
    use windows::{
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM, RECT},
            Graphics::{
                Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
                Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO},
            },
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                    TH32CS_SNAPPROCESS,
                },
                StationsAndDesktops::{
                    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, OpenInputDesktop,
                },
            },
            UI::{HiDpi::GetDpiForWindow, WindowsAndMessaging::*},
        },
        core::BOOL,
    };

    #[derive(Clone, Debug)]
    pub struct Target {
        pub pid: u32,
        pub name: String,
        pub hwnd: HWND,
        pub bounds: Rect,
        pub dpi: f64,
        pub windows: Value,
        pub title: String,
    }

    pub fn bounds(hwnd: HWND) -> Result<Rect> {
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect)?;
        }
        let result = rect_value(rect);
        if result.valid() {
            Ok(result)
        } else {
            Err(Failure::new(
                "target-unavailable",
                "The selected window has no usable bounds",
            ))
        }
    }
    fn rect_value(rect: RECT) -> Rect {
        Rect {
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right as i64 - rect.left as i64) as f64,
            height: (rect.bottom as i64 - rect.top as i64) as f64,
        }
    }
    pub fn dpi(hwnd: HWND) -> f64 {
        unsafe { GetDpiForWindow(hwnd) as f64 / 96.0 }
    }
    pub fn owns(parent: HWND, child: HWND) -> bool {
        parent == child || unsafe { IsChild(parent, child).as_bool() }
    }

    struct Enumeration {
        windows: BTreeMap<u32, Vec<Window>>,
        excluded: HashSet<isize>,
    }
    unsafe extern "system" fn enumerate(hwnd: HWND, parameter: LPARAM) -> BOOL {
        // EnumWindows invokes this callback synchronously on its calling thread.
        let state = unsafe { &mut *(parameter.0 as *mut Enumeration) };
        if state.excluded.contains(&(hwnd.0 as isize)) {
            return true.into();
        }
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if pid == 0 {
            return true.into();
        }
        let length = unsafe { GetWindowTextLengthW(hwnd) }.max(0) as usize;
        let mut title = vec![0u16; length + 1];
        let count = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
        let mut class = [0u16; 256];
        let class_count = unsafe { GetClassNameW(hwnd, &mut class) }.max(0) as usize;
        let class = String::from_utf16_lossy(&class[..class_count]);
        let mut cloaked: u32 = 0;
        unsafe {
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as _,
                size_of::<u32>() as u32,
            );
        }
        let visible = unsafe { IsWindowVisible(hwnd).as_bool() };
        let owner = unsafe { GetWindow(hwnd, GW_OWNER) }.unwrap_or_default();
        state.windows.entry(pid).or_default().push(Window {
            handle: hwnd.0 as isize,
            title: String::from_utf16_lossy(&title[..count]),
            bounds: bounds(hwnd).unwrap_or_default(),
            visible,
            minimized: unsafe { IsIconic(hwnd).as_bool() },
            cloaked: cloaked != 0,
            auxiliary: unsafe {
                GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0
            } || matches!(
                class.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ),
            // Match the .NET MainWindowHandle heuristic: first visible unowned
            // top-level window in the process, independently of auto selection.
            main: visible && owner.0.is_null(),
        });
        true.into()
    }

    pub fn inventory(request: &Request) -> Result<Vec<App>> {
        let excluded = request
            .value("control_windows")
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item.as_i64())
            .filter_map(|item| isize::try_from(item).ok())
            .collect();
        let mut state = Enumeration {
            windows: BTreeMap::new(),
            excluded,
        };
        unsafe {
            EnumWindows(Some(enumerate), LPARAM(&mut state as *mut _ as isize))?;
        }
        let process_names = process_names()?;
        let mut apps = Vec::new();
        for (pid, mut windows) in state.windows {
            let Some(name) = process_names.get(&pid) else {
                continue;
            }; // Process exited during inventory.
            let main = windows.iter().position(|window| window.main);
            for (index, window) in windows.iter_mut().enumerate() {
                window.main = Some(index) == main;
            }
            let title = main
                .and_then(|index| windows.get(index))
                .filter(|window| !window.title.trim().is_empty())
                .or_else(|| {
                    windows
                        .iter()
                        .find(|window| window.visible && !window.title.trim().is_empty())
                })
                .map(|window| window.title.clone())
                .unwrap_or_else(|| "untitled".into());
            apps.push(App {
                name: name.clone(),
                pid,
                window_title: title,
                windows,
            });
        }
        apps.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.pid.cmp(&b.pid))
        });
        Ok(apps)
    }
    fn process_names() -> Result<HashMap<u32, String>> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? };
        struct Snapshot(windows::Win32::Foundation::HANDLE);
        impl Drop for Snapshot {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
        let _snapshot = Snapshot(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut names = HashMap::new();
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                let stem = if name.to_lowercase().ends_with(".exe") {
                    &name[..name.len() - 4]
                } else {
                    &name
                };
                names.insert(entry.th32ProcessID, stem.to_owned());
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        Ok(names)
    }
    fn app_query(request: &Request) -> String {
        request
            .value("app")
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                request
                    .value("app")
                    .as_u64()
                    .map(|pid| pid.to_string())
                    .unwrap_or_default()
            })
    }
    /// Implicit launching is only an absent-app fallback, never recovery for a
    /// missing window selector, hidden window or unreadable DPI.
    pub fn application_exists(request: &Request) -> Result<bool> {
        let apps = inventory(request)?;
        let foreground = unsafe { GetForegroundWindow() }.0 as isize;
        Ok(app_match(&apps, &app_query(request), foreground).is_some())
    }
    /// Revalidate after provider calls/capture. Handle recycling and geometry
    /// changes must not bind a new image or input to an earlier observation.
    pub fn validate_identity(target: &Target) -> Result<()> {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(target.hwnd, Some(&mut pid));
        }
        if !unsafe { IsWindow(Some(target.hwnd)).as_bool() } || pid != target.pid {
            return Err(Failure::new(
                "target-changed",
                "The selected window no longer belongs to the observed application",
            ));
        }
        Ok(())
    }
    pub fn validate(target: &Target) -> Result<()> {
        validate_identity(target)?;
        crate::targeting::check_geometry(
            bounds(target.hwnd)?,
            Some(target.bounds),
            dpi(target.hwnd),
            Some(target.dpi),
        )
    }
    pub fn resolve(request: &Request) -> Result<Target> {
        let apps = inventory(request)?;
        let foreground = unsafe { GetForegroundWindow() }.0 as isize;
        let app_query = app_query(request);
        let (app, by_title) = app_match(&apps, &app_query, foreground).ok_or_else(|| {
            Failure::new(
                "target-unavailable",
                "Application not found in this desktop session",
            )
        })?;
        let selected = select_window(
            app,
            request.value("window"),
            by_title.then_some(app_query.trim()),
            foreground,
        )?;
        let hwnd = HWND(selected.handle as *mut _);
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if !unsafe { IsWindow(Some(hwnd)).as_bool() } || pid != app.pid {
            return Err(Failure::new(
                "target-changed",
                "The selected window changed during observation; observe again",
            ));
        }
        let dpi = dpi(hwnd);
        if dpi <= 0.0 {
            return Err(Failure::new(
                "target-unavailable",
                "Unable to read the selected window's DPI",
            ));
        }
        Ok(Target {
            pid: app.pid,
            name: app.name.clone(),
            hwnd,
            bounds: bounds(hwnd)?,
            dpi,
            windows: json!(app_windows(&app.windows, Some(selected.handle), foreground)),
            title: selected.title.clone(),
        })
    }
    pub fn list_apps(request: &Request) -> Result<Value> {
        let apps = inventory(request)?;
        let text = apps
            .iter()
            .map(|app| {
                format!(
                    "{} -- {} [running, pid={}, window={}]",
                    app.name, app.name, app.pid, app.window_title
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(json!({"ok":true,"text":text,"apps":apps}))
    }

    unsafe extern "system" fn monitor(
        handle: HMONITOR,
        _: HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let output = unsafe { &mut *(data.0 as *mut Vec<Value>) };
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetMonitorInfoW(handle, &mut info).as_bool() } {
            let bounds = rect_value(info.rcMonitor);
            output.push(json!({"x":bounds.x,"y":bounds.y,"width":bounds.width,"height":bounds.height,"primary":info.dwFlags & MONITORINFOF_PRIMARY != 0}));
        }
        true.into()
    }
    pub fn displays() -> Vec<Value> {
        let mut output = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(
                None,
                None,
                Some(monitor),
                LPARAM(&mut output as *mut _ as isize),
            );
        }
        output
    }
    pub fn desktop_available() -> bool {
        match unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) } {
            Ok(desktop) => {
                unsafe {
                    let _ = CloseDesktop(desktop);
                }
                !displays().is_empty()
            }
            Err(_) => false,
        }
    }
}
#[cfg(windows)]
pub use native::*;

#[cfg(test)]
mod tests {
    use super::*;
    fn window(handle: isize, title: &str) -> Window {
        Window {
            handle,
            title: title.into(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            visible: true,
            minimized: false,
            cloaked: false,
            auxiliary: false,
            main: false,
        }
    }
    fn app(name: &str, pid: u32, windows: Vec<Window>) -> App {
        App {
            name: name.into(),
            pid,
            window_title: String::new(),
            windows,
        }
    }
    #[test]
    fn process_identity_precedes_document_titles() {
        let apps = [
            app("Explorer", 1, vec![window(1, "Varin")]),
            app("Varin", 2, vec![window(2, "Home")]),
        ];
        assert_eq!(app_match(&apps, "varin.exe", 1).unwrap().0.pid, 2);
        assert_eq!(app_match(&apps, "Varin", 1).unwrap().0.pid, 2);
        assert_eq!(app_match(&apps, "1", 2).unwrap().0.pid, 1);
    }
    #[test]
    fn visible_process_precedes_same_name_hidden_helper() {
        let mut hidden = window(1, "Helper");
        hidden.visible = false;
        let apps = [
            app("Varin", 1, vec![hidden]),
            app("Varin", 2, vec![window(2, "Work")]),
        ];
        assert_eq!(app_match(&apps, "Varin", 0).unwrap().0.pid, 2);
    }
    #[test]
    fn placeholder_hidden_cloaked_and_shell_windows_are_not_auto_targets() {
        let mut placeholder = window(1, "Auxiliary");
        placeholder.bounds.width = 1.0;
        let mut hidden = window(2, "Hidden");
        hidden.visible = false;
        let mut cloaked = window(3, "Cloaked");
        cloaked.cloaked = true;
        let mut shell = window(4, "Shell");
        shell.auxiliary = true;
        let windows = vec![placeholder, hidden, cloaked, shell, window(5, "Files")];
        assert_eq!(
            app_windows(&windows, None, 1)
                .iter()
                .map(|w| w.handle)
                .collect::<Vec<_>>(),
            [5]
        );
        assert_eq!(
            app_windows(&windows, Some(2), 5)
                .iter()
                .map(|w| w.handle)
                .collect::<Vec<_>>(),
            [5, 2]
        );
    }
    #[test]
    fn explicit_handle_is_exact_and_ambiguous_titles_fail() {
        let mut hidden = window(2, "Report");
        hidden.visible = false;
        let app = app("Editor", 1, vec![window(1, "Report"), hidden]);
        assert_eq!(
            select_window(&app, &serde_json::json!(2), None, 1)
                .unwrap()
                .handle,
            2
        );
        assert_eq!(
            select_window(&app, &serde_json::json!("Report"), None, 1)
                .unwrap_err()
                .code,
            "target-changed"
        );
        assert!(select_window(&app, &serde_json::json!(99), None, 1).is_err());
    }
    #[test]
    fn title_matching_is_case_insensitive_and_exact_before_substring() {
        let app = app(
            "Editor",
            1,
            vec![window(1, "Report - Editor"), window(2, "REPORT")],
        );
        assert_eq!(
            select_window(&app, &serde_json::json!("report"), None, 1)
                .unwrap()
                .handle,
            2
        );
        assert_eq!(
            select_window(&app, &Value::Null, Some("Report -"), 2)
                .unwrap()
                .handle,
            1
        );
    }
    #[test]
    fn foreground_then_minimization_title_and_area_determine_auto_selection() {
        let mut minimized = window(1, "Minimized");
        minimized.minimized = true;
        let app = app("Editor", 1, vec![minimized, window(2, "Report")]);
        assert_eq!(
            select_window(&app, &Value::Null, None, 0).unwrap().handle,
            2
        );
        assert_eq!(
            select_window(&app, &Value::Null, None, 1).unwrap().handle,
            1
        );
    }
}
