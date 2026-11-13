use super::{
    Output, capture,
    input::{InputOwner, coordinate, key_event, mouse_event},
    uia::Automation,
    window,
};
use crate::{
    protocol::{Failure, Point, Rect, Request, Result, handshake, limit_text, text_limit},
    targeting::{ElementRecord, check_geometry},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    mem::size_of,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, GetLastError, HWND, LPARAM, POINT, SetLastError,
            WIN32_ERROR, WPARAM,
        },
        Graphics::Gdi::ScreenToClient,
        System::Threading::GetProcessId,
        UI::{
            Accessibility::*,
            Input::KeyboardAndMouse::*,
            Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW},
            WindowsAndMessaging::*,
        },
    },
    core::{BSTR, PCWSTR},
};

pub struct Runtime {
    owner: Arc<InputOwner>,
    output: Output,
    capture_only: bool,
    automation: Option<Automation>,
    last_input: HashMap<u32, Instant>,
}
impl Runtime {
    pub fn new(owner: Arc<InputOwner>, output: Output, capture_only: bool) -> Self {
        Self {
            owner,
            output,
            capture_only,
            automation: None,
            last_input: HashMap::new(),
        }
    }
    fn automation(&mut self) -> Result<&Automation> {
        if self.automation.is_none() {
            self.automation = Some(Automation::new()?);
        }
        Ok(self.automation.as_ref().unwrap())
    }
    pub fn execute(&mut self, request: &Request) -> Result<Value> {
        let retained = self
            .automation
            .as_ref()
            .map(Automation::retained_checkpoint)
            .unwrap_or_default();
        let result = self.execute_inner(request);
        if result.is_err() {
            if let Some(automation) = &self.automation {
                automation.rollback_retained(&retained);
            }
        }
        result
    }
    fn execute_inner(&mut self, request: &Request) -> Result<Value> {
        self.owner.checkpoint()?;
        if matches!(request.tool.as_str(), "ping" | "capabilities") {
            let mut response = handshake();
            response["ok"] = json!(true);
            if request.tool == "capabilities" {
                let available = window::desktop_available();
                response["capabilities"] = json!({"platform":"windows","driver":"windows-uia","driverVersion":env!("VARIN_COMPUTER_VERSION"),
                    "applicationTools":{"browser":false,"office":false},"observeTree":available&&!self.capture_only,"screenshot":available,
                    "elementAction":available&&!self.capture_only,
                    "semanticQuery":available&&!self.capture_only,"scopedObservation":available&&!self.capture_only,
                    "semanticActions":if available&&!self.capture_only {json!(["set_checked","set_expanded","select","scroll_into_view"])} else {json!([])},"semanticEvents":"polling","coordinateInput":available&&!self.capture_only,"textInput":available&&!self.capture_only,
                    "drag":available&&!self.capture_only,"dpiAware":true,"displays":window::displays(),"multiWindow":true,"occludedCapture":true,
                    "interruptibleInput":!self.capture_only,"sessionType":"windows-console","status":if available {"ready"} else {"unavailable"}});
                if !available {
                    response["capabilities"]["detail"] =
                        json!("No accessible interactive Windows desktop is available");
                }
            }
            return Ok(response);
        }
        if self.capture_only && request.tool != "capture_frame" {
            return Err(Failure::new(
                "unsupported",
                "The capture helper accepts only read-only desktop frames",
            ));
        }
        match request.tool.as_str() {
            "capture_frame" => {
                let quality = request.value("quality").as_f64().unwrap_or(65.0);
                Ok(json!({"ok":true,"frame":capture::desktop(quality)?}))
            }
            "release_input" => {
                self.owner.release(true)?;
                Ok(json!({"ok":true,"released":true}))
            }
            "list_apps" => window::list_apps(request),
            "query_elements" => self.query(request),
            "release_elements" => {
                if let Some(automation) = &self.automation {
                    automation.release(
                        request
                            .value("elements")
                            .as_array()
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                    );
                }
                Ok(json!({"ok":true}))
            }
            "get_app_state" => Ok(json!({"ok":true,"snapshot":self.snapshot(request)?})),
            "inject_input" => {
                self.human_input(request)?;
                Ok(json!({"ok":true}))
            }
            "open" => open(&self.owner, request),
            "click"
            | "perform_secondary_action"
            | "scroll"
            | "drag"
            | "type_text"
            | "press_key"
            | "set_value"
            | "set_checked"
            | "set_expanded"
            | "select"
            | "scroll_into_view" => self.action(request),
            _ => Err(Failure::new(
                "unsupported",
                "This Computer operation is not implemented by the Windows driver",
            )),
        }
    }
    fn target(&self, request: &Request) -> Result<window::Target> {
        match window::resolve(request) {
            Ok(target) => Ok(target),
            Err(error)
                if error.code == "target-unavailable"
                    && request.value("element").is_null()
                    && request.value("within").is_null()
                    && request.value("platform_target").is_null()
                    && env_flag("VARIN_COMPUTER_ALLOW_APP_LAUNCH")
                    && !window::application_exists(request)? =>
            {
                self.owner.semantic()?;
                let child = std::process::Command::new(request.text("app"))
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|_| error.clone())?;
                let mut lookup = request.clone();
                lookup
                    .params
                    .insert("app".into(), json!(child.id().to_string()));
                for _ in 0..20 {
                    self.owner.checkpoint()?;
                    thread::sleep(Duration::from_millis(250));
                    if let Ok(target) = window::resolve(&lookup) {
                        return Ok(target);
                    }
                }
                Err(error)
            }
            Err(error) => Err(error),
        }
    }
    fn query(&mut self, request: &Request) -> Result<Value> {
        if !request.value("platform_target").is_null() {
            self.automation()?
                .validate_target(request.value("platform_target"))?;
        }
        let target = window::resolve(request).map_err(|error| {
            if matches!(error.code, "target-unavailable" | "target-changed") {
                Failure::new(
                    if request
                        .value("platform_target")
                        .get("uiaWindowId")
                        .is_some()
                    {
                        "window_lost"
                    } else {
                        "window_not_found"
                    },
                    error.message,
                )
            } else {
                error
            }
        })?;
        let owner = self.owner.clone();
        let automation = self.automation()?;
        let root = automation.root(target.hwnd, request.value("platform_target"))?;
        let native_target = automation.native_target(&root)?;
        if !request.value("element").is_null() {
            let record = parse_element(request.value("element"))?;
            let element = automation
                .relocate(&root, &record, || owner.checkpoint())?
                .ok_or_else(|| {
                    Failure::new(
                        "target_lost",
                        "The requested control is no longer available",
                    )
                })?;
            let result = automation.properties(&element, request, || owner.checkpoint())?;
            automation.validate_window(&root)?;
            window::validate_identity(&target)?;
            owner.checkpoint()?;
            return Ok(result);
        }
        let rendered = if request.boolean("window_only") {
            super::uia::Rendered {
                records: vec![],
                lines: vec![],
                complete: true,
                reason: None,
                next_offset: None,
            }
        } else {
            let region = if request.value("within").is_null() {
                root.clone()
            } else {
                automation
                    .relocate(&root, &parse_element(request.value("within"))?, || {
                        owner.checkpoint()
                    })?
                    .ok_or_else(|| {
                        Failure::new("target_lost", "The requested region is no longer available")
                    })?
            };
            automation.query(&root, &region, &target.bounds, request, || {
                owner.checkpoint()
            })?
        };
        automation.validate_window(&root)?;
        window::validate_identity(&target)?;
        owner.checkpoint()?;
        Ok(
            json!({"ok":true,"complete":rendered.complete,"nextOffset":rendered.next_offset,"reason":rendered.reason,
            "snapshot":{"app":{"name":target.name,"bundleIdentifier":target.name,"pid":target.pid},
                "windowTitle":target.title,"windowHandle":target.hwnd.0 as isize,"windowBounds":target.bounds,"dpiScale":target.dpi,
                "nativeTarget":native_target,"treeLines":rendered.lines,"elements":rendered.records,
                "complete":rendered.complete,"truncatedReason":rendered.reason,"screenshotPngBase64":null,"screenshotSource":null}}),
        )
    }
    fn snapshot(&mut self, request: &Request) -> Result<Value> {
        let target = self.target(request)?;
        if let Some(last) = self.last_input.remove(&target.pid) {
            if let Some(remaining) = Duration::from_millis(120).checked_sub(last.elapsed()) {
                thread::sleep(remaining);
            }
        }
        self.owner.checkpoint()?;
        let owner = self.owner.clone();
        let automation = self.automation()?;
        let root = automation.root(target.hwnd, request.value("platform_target"))?;
        let region = if request.value("within").is_null() {
            root.clone()
        } else {
            automation
                .relocate(&root, &parse_element(request.value("within"))?, || {
                    owner.checkpoint()
                })?
                .ok_or_else(|| {
                    Failure::new("target_lost", "The requested region is no longer available")
                })?
        };
        let rendered = automation.render(&root, &region, &target.bounds, request, || {
            owner.checkpoint()
        })?;
        let native_target = automation.native_target(&root)?;
        owner.checkpoint()?;
        let (focused, selected) = automation
            .focused(
                &root,
                &target.bounds,
                text_limit(request.value("text_limit")),
            )
            .unwrap_or((None, None));
        let mut snapshot = json!({"app":{"name":target.name,"bundleIdentifier":target.name,"pid":target.pid},"windowTitle":limit_text(&target.title,text_limit(request.value("text_limit"))),
            "windowHandle":target.hwnd.0 as isize,"windowBounds":target.bounds,"dpiScale":target.dpi,"windows":target.windows,
            "treeLines":rendered.lines,"elements":rendered.records,"complete":rendered.complete,"truncatedReason":rendered.reason,"view":request.text("view"),"nativeTarget":native_target,"focusedSummary":focused,"selectedText":selected,
            "screenshotPngBase64":null,"screenshotSource":null});
        if request.boolean("screenshot") {
            owner.checkpoint()?;
            let raster = capture::window(target.hwnd, target.bounds)?;
            snapshot["screenshotPngBase64"] = raster["screenshotPngBase64"].clone();
            snapshot["screenshotSource"] = raster["screenshotSource"].clone();
        }
        automation.validate_window(&root)?;
        window::validate(&target)?;
        owner.checkpoint()?;
        Ok(snapshot)
    }
    fn action(&mut self, request: &Request) -> Result<Value> {
        let target = self.target(request)?;
        let owner = self.owner.clone();
        owner.bind_window(target.hwnd, target.pid)?;
        let coordinate_bound = request.value("element").is_null()
            || matches!(request.tool.as_str(), "drag" | "type_text" | "press_key")
            || (request.tool == "click"
                && (!matches!(request.text("click_method"), "" | "auto" | "accessibility")
                    || request.positive("click_count", 1) != 1
                    || matches!(request.text("mouse_button"), "right" | "middle")))
            || (request.tool == "scroll");
        let expected = if coordinate_bound {
            optional_rect(request.value("expected_bounds"))?
        } else {
            None
        };
        let expected_dpi = if coordinate_bound {
            request.value("expected_dpi").as_f64()
        } else {
            None
        };
        check_geometry(target.bounds, expected, target.dpi, expected_dpi)?;
        let automation = self.automation()?;
        let root = automation.root(target.hwnd, request.value("platform_target"))?;
        let element = if request.value("element").is_null() {
            None
        } else {
            let record = parse_element(request.value("element"))?;
            Some(
                automation
                    .relocate(&root, &record, || owner.checkpoint())?
                    .ok_or_else(|| {
                        Failure::new(
                            "target-unavailable",
                            "Observed element no longer exists; observe again",
                        )
                    })?,
            )
        };
        owner.checkpoint()?;
        if let Some(element) = element.as_ref() {
            if !automation.contains(&root, element)? {
                return Err(Failure::new(
                    "target-changed",
                    "The observed control moved outside the selected window; observe again",
                ));
            }
        }
        automation.validate_window(&root)?;
        window::validate_identity(&target)?;
        let bounds = window::bounds(target.hwnd)?;
        check_geometry(bounds, expected, window::dpi(target.hwnd), expected_dpi)?;
        if request.text("capture_source") == "screen" && expected.is_some() && element.is_none() {
            let points = if request.tool == "drag" {
                vec![
                    point(request, "from_x", "from_y", bounds),
                    point(request, "to_x", "to_y", bounds),
                ]
            } else if matches!(request.tool.as_str(), "click" | "scroll") {
                vec![point(request, "x", "y", bounds)]
            } else {
                vec![]
            };
            for point in points {
                ensure_point_owner(target.hwnd, point)?;
            }
        }
        let frame = if coordinate_bound {
            element.as_ref().map(element_rect).transpose()?.flatten()
        } else {
            element
                .as_ref()
                .and_then(|element| element_rect(element).ok().flatten())
        };
        let post_hwnd = match element.as_ref() {
            Some(element) => unsafe { element.CurrentNativeWindowHandle().unwrap_or_default() },
            None => target.hwnd,
        };
        let post_hwnd = if post_hwnd.0.is_null() {
            target.hwnd
        } else {
            post_hwnd
        };
        if !window::owns(target.hwnd, post_hwnd) {
            return Err(Failure::new(
                "target-changed",
                "The control handle no longer belongs to the selected window",
            ));
        }
        let scroll_pattern = element.as_ref().and_then(|element| unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
                .ok()
        });
        let semantic = matches!(
            request.tool.as_str(),
            "set_value"
                | "perform_secondary_action"
                | "set_checked"
                | "set_expanded"
                | "select"
                | "scroll_into_view"
        ) || matches!(request.text("click_method"), "accessibility" | "app_post")
            || request.text("input") == "app_post"
            || (request.tool == "scroll" && scroll_pattern.is_some());
        owner.mechanism(
            if request.text("input") == "app_post" || request.text("click_method") == "app_post" {
                "app_post"
            } else if semantic {
                "accessibility"
            } else {
                "global"
            },
        );
        let mechanism = if semantic {
            "semantic"
        } else if matches!(request.tool.as_str(), "type_text" | "press_key") {
            "keyboard"
        } else {
            "pointer"
        };
        let gesture_point = match request.tool.as_str() {
            "click" | "scroll" | "perform_secondary_action" => {
                frame.map(Rect::center).or_else(|| {
                    if request.value("x").is_number() {
                        Some(point(request, "x", "y", bounds))
                    } else {
                        None
                    }
                })
            }
            "drag" => Some(point(request, "from_x", "from_y", bounds)),
            _ => None,
        };
        let gesture_to = if request.tool == "drag" {
            Some(point(request, "to_x", "to_y", bounds))
        } else {
            None
        };
        self.output.gesture(
            request,
            "target",
            mechanism,
            gesture_point,
            gesture_to,
            Some(frame.unwrap_or(bounds)),
        );
        let result = (|| -> Result<()> {
            match request.tool.as_str() {
                "click" => {
                    let method = match request.text("click_method") {
                        "" | "auto"
                            if element.is_some()
                                && request.positive("click_count", 1) == 1
                                && matches!(request.text("mouse_button"), "" | "left") =>
                        {
                            "auto"
                        }
                        "" | "auto" => "global",
                        other => other,
                    };
                    match method {
                        "auto" => {
                            let selected = element.as_ref().unwrap();
                            ensure_enabled(selected)?;
                            owner.mechanism("accessibility");
                            if !preferred_click(&owner, selected)? {
                                // This branch is reachable only before any native
                                // semantic method was called, never after timeout/error.
                                owner.mechanism("global");
                                let expected = optional_rect(request.value("expected_bounds"))?;
                                activate(&owner, target.hwnd, target.pid, request, expected)?;
                                let at = action_point(
                                    element.as_ref(),
                                    request,
                                    window::bounds(target.hwnd)?,
                                )?;
                                self.output.gesture(
                                    request,
                                    "target",
                                    "pointer",
                                    Some(at),
                                    None,
                                    None,
                                );
                                click(&owner, at, request.text("mouse_button"), 1)?;
                            }
                        }
                        "accessibility" => {
                            let element = element.as_ref().ok_or_else(|| {
                                Failure::new(
                                    "invalid-request",
                                    "Accessibility click requires an observed element",
                                )
                            })?;
                            if matches!(request.text("mouse_button"), "right" | "middle") {
                                return Err(Failure::new(
                                    "unsupported",
                                    "Accessibility click does not support secondary mouse buttons",
                                ));
                            }
                            ensure_enabled(element)?;
                            if request.positive("click_count", 1) != 1 {
                                return Err(Failure::new(
                                    "unsupported",
                                    "Accessibility click represents one primary action, not a multi-click",
                                ));
                            }
                            if !preferred_click(&owner, element)? {
                                return Err(Failure::new(
                                    "unsupported",
                                    "The control has no supported accessibility click action",
                                ));
                            }
                        }
                        "global" => {
                            activate(&owner, target.hwnd, target.pid, request, expected)?;
                            let at = action_point(
                                element.as_ref(),
                                request,
                                window::bounds(target.hwnd)?,
                            )?;
                            self.output
                                .gesture(request, "target", "pointer", Some(at), None, None);
                            click(
                                &owner,
                                at,
                                request.text("mouse_button"),
                                request.positive("click_count", 1),
                            )?;
                        }
                        "app_post" => post_click(
                            &owner,
                            post_hwnd,
                            action_point(element.as_ref(), request, bounds)?,
                            request.text("mouse_button"),
                            request.positive("click_count", 1),
                        )?,
                        _ => {
                            return Err(Failure::new(
                                "invalid-request",
                                "Unsupported click method",
                            ));
                        }
                    }
                }
                "perform_secondary_action" => secondary(
                    &owner,
                    element.as_ref().ok_or_else(|| {
                        Failure::new(
                            "invalid-request",
                            "Secondary action requires an observed element",
                        )
                    })?,
                    request.text("action"),
                )?,
                "scroll" => {
                    if let Some(scroll) = scroll_pattern {
                        let (horizontal, vertical) = scroll_amount(request.text("direction"))?;
                        for _ in 0..repeat_pages(request)? {
                            owner.semantic()?;
                            unsafe {
                                scroll.Scroll(horizontal, vertical)?;
                            }
                            pause(&owner, 40)?;
                        }
                    } else {
                        let at = action_point(element.as_ref(), request, bounds)?;
                        if request.text("input") == "app_post" {
                            post_scroll(
                                &owner,
                                post_hwnd,
                                at,
                                request.text("direction"),
                                request.number("pages"),
                            )?;
                        } else {
                            activate(&owner, target.hwnd, target.pid, request, expected)?;
                            let at = action_point(
                                element.as_ref(),
                                request,
                                window::bounds(target.hwnd)?,
                            )?;
                            self.output
                                .gesture(request, "target", "pointer", Some(at), None, None);
                            scroll(
                                &owner,
                                at,
                                request.text("direction"),
                                request.number("pages"),
                            )?;
                        }
                    }
                }
                "drag" => {
                    let from = point(request, "from_x", "from_y", bounds);
                    let to = point(request, "to_x", "to_y", bounds);
                    if request.text("input") == "app_post" {
                        post_drag(&owner, post_hwnd, from, to, |at| {
                            self.output.gesture(
                                request,
                                "dispatched",
                                "semantic",
                                Some(at),
                                None,
                                None,
                            )
                        })?;
                    } else {
                        activate(&owner, target.hwnd, target.pid, request, expected)?;
                        let live_bounds = window::bounds(target.hwnd)?;
                        let from = point(request, "from_x", "from_y", live_bounds);
                        let to = point(request, "to_x", "to_y", live_bounds);
                        drag(&owner, from, to, |at| {
                            self.output.gesture(
                                request,
                                "dispatched",
                                "pointer",
                                Some(at),
                                None,
                                None,
                            )
                        })?;
                    }
                }
                "type_text" => {
                    if request.text("input") == "app_post" {
                        let focused = match element.as_ref() {
                            Some(element) => Some(element.clone()),
                            None => self.automation()?.focused_element(&root)?,
                        };
                        post_text(&owner, target.hwnd, focused.as_ref(), request.text("text"))?;
                    } else {
                        activate(&owner, target.hwnd, target.pid, request, expected)?;
                        keyboard_target(&owner, element.as_ref())?;
                        type_text(&owner, request.text("text"))?;
                    }
                }
                "press_key" => {
                    if request.text("input") == "app_post" {
                        post_key(&owner, post_hwnd, request.text("key"))?;
                    } else {
                        activate(&owner, target.hwnd, target.pid, request, expected)?;
                        keyboard_target(&owner, element.as_ref())?;
                        press_key(&owner, request.text("key"))?;
                    }
                }
                "set_checked" | "set_expanded" | "select" | "scroll_into_view" => state_action(
                    &owner,
                    element.as_ref().ok_or_else(|| {
                        Failure::new(
                            "invalid-request",
                            "State action requires an observed element",
                        )
                    })?,
                    request,
                )?,
                "set_value" => set_value(
                    &owner,
                    element.as_ref().ok_or_else(|| {
                        Failure::new("invalid-request", "Set value requires an observed element")
                    })?,
                    request.text("value"),
                )?,
                _ => unreachable!(),
            }
            owner.checkpoint()?;
            let receipt = owner.receipt(None);
            if receipt["effect"] != "none" {
                let actual = if receipt["mechanism"] == "accessibility"
                    || receipt["mechanism"] == "app_post"
                {
                    "semantic"
                } else {
                    mechanism
                };
                self.output
                    .gesture(request, "dispatched", actual, None, None, None);
            }
            Ok(())
        })();
        // Always release automatic held input, including app_post keys/buttons.
        // A release failure is not hidden behind a successful input receipt.
        let released = owner.release(false);
        result?;
        released?;
        if owner.receipt(None)["effect"] != "none" {
            self.last_input.insert(target.pid, Instant::now());
        }
        if matches!(request.text("return_state"), "" | "none") {
            return Ok(json!({"ok":true}));
        }
        let mut observation = request.clone();
        observation.tool = "get_app_state".into();
        observation.params.insert(
            "screenshot".into(),
            json!(request.text("return_state") == "screenshot"),
        );
        match self.snapshot(&observation) {
            Ok(snapshot) => Ok(json!({"ok":true,"snapshot":snapshot})),
            Err(_) => Ok(
                json!({"ok":true,"text":"Input was dispatched; post-action observation failed. Observe again before deciding another action."}),
            ),
        }
    }
    fn human_input(&self, request: &Request) -> Result<()> {
        let at = Point {
            x: request.number("x"),
            y: request.number("y"),
        };
        match request.text("kind") {
            "click" => click(
                &self.owner,
                at,
                request.text("button"),
                request.positive("count", 1),
            ),
            "down" | "up" => {
                let (down, up) = mouse_flags(request.text("button"))?;
                self.owner.pointer(
                    at,
                    &[mouse_event(
                        if request.text("kind") == "down" {
                            down
                        } else {
                            up
                        },
                        0,
                    )],
                )
            }
            "move" => self.owner.move_pointer(at),
            "scroll" => scroll(
                &self.owner,
                at,
                request.text("direction"),
                request.number("pages"),
            ),
            "key" => press_key(&self.owner, request.text("key")),
            "text" => type_text(&self.owner, request.text("text")),
            _ => Err(Failure::new(
                "unsupported",
                "Unsupported human input operation",
            )),
        }
    }
}
fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}
fn optional_rect(value: &Value) -> Result<Option<Rect>> {
    if value.is_null() {
        Ok(None)
    } else {
        serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| Failure::new("invalid-request", "Invalid observed window bounds"))
    }
}
fn point(request: &Request, x: &str, y: &str, bounds: Rect) -> Point {
    Point {
        x: bounds.x + request.number(x),
        y: bounds.y + request.number(y),
    }
}
fn pause(owner: &InputOwner, ms: u64) -> Result<()> {
    owner.checkpoint()?;
    thread::sleep(Duration::from_millis(ms));
    owner.checkpoint()
}
fn element_rect(element: &IUIAutomationElement) -> Result<Option<Rect>> {
    let rect = unsafe { element.CurrentBoundingRectangle()? };
    let result = Rect {
        x: rect.left as f64,
        y: rect.top as f64,
        width: (rect.right as i64 - rect.left as i64) as f64,
        height: (rect.bottom as i64 - rect.top as i64) as f64,
    };
    Ok(result.valid().then_some(result))
}
fn action_point(
    element: Option<&IUIAutomationElement>,
    request: &Request,
    bounds: Rect,
) -> Result<Point> {
    if let Some(element) = element {
        return element_rect(element)?.map(Rect::center).ok_or_else(|| {
            Failure::new(
                "target-unavailable",
                "The observed control has no usable pointer bounds",
            )
        });
    }
    Ok(point(request, "x", "y", bounds))
}
fn ensure_point_owner(hwnd: HWND, point: Point) -> Result<()> {
    let owner = unsafe {
        WindowFromPoint(POINT {
            x: coordinate(point.x)?,
            y: coordinate(point.y)?,
        })
    };
    if !window::owns(hwnd, owner) {
        Err(Failure::new(
            "target-changed",
            "Screenshot coordinate is occluded by another window; observe again",
        ))
    } else {
        Ok(())
    }
}
fn activate(
    owner: &InputOwner,
    hwnd: HWND,
    pid: u32,
    request: &Request,
    expected: Option<Rect>,
) -> Result<()> {
    owner.activate(hwnd, pid)?;
    check_geometry(
        window::bounds(hwnd)?,
        expected,
        window::dpi(hwnd),
        request.value("expected_dpi").as_f64(),
    )
}
fn keyboard_target(owner: &InputOwner, element: Option<&IUIAutomationElement>) -> Result<()> {
    if let Some(element) = element {
        owner.checkpoint()?;
        unsafe {
            if !element.CurrentHasKeyboardFocus()?.as_bool() {
                element.SetFocus()?;
            }
            if !element.CurrentHasKeyboardFocus()?.as_bool() {
                return Err(Failure::new(
                    "focus-changed",
                    "The selected control did not obtain keyboard focus",
                ));
            }
        }
    }
    owner.bind_keyboard()
}
fn mouse_flags(button: &str) -> Result<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS)> {
    match button {
        "" | "left" => Ok((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
        "right" => Ok((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
        "middle" => Ok((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
        _ => Err(Failure::new("invalid-request", "Unsupported mouse button")),
    }
}
fn click(owner: &InputOwner, at: Point, button: &str, count: usize) -> Result<()> {
    let (down, up) = mouse_flags(button)?;
    for _ in 0..count {
        owner.pointer(at, &[mouse_event(down, 0), mouse_event(up, 0)])?;
        pause(owner, 40)?;
    }
    Ok(())
}
fn drag(owner: &InputOwner, from: Point, to: Point, progress: impl Fn(Point)) -> Result<()> {
    owner.move_pointer(from)?;
    pause(owner, 30)?;
    owner.pointer(from, &[mouse_event(MOUSEEVENTF_LEFTDOWN, 0)])?;
    for step in 1..=12 {
        let at = Point {
            x: from.x + (to.x - from.x) * step as f64 / 12.0,
            y: from.y + (to.y - from.y) * step as f64 / 12.0,
        };
        owner.move_pointer(at)?;
        progress(at);
        pause(owner, 20)?;
    }
    owner.pointer(to, &[mouse_event(MOUSEEVENTF_LEFTUP, 0)])
}
fn wheel(direction: &str, pages: f64) -> Result<(MOUSE_EVENT_FLAGS, u32)> {
    let sign = match direction {
        "up" | "right" => 1.0,
        "down" | "left" => -1.0,
        _ => {
            return Err(Failure::new(
                "invalid-request",
                "Unsupported scroll direction",
            ));
        }
    };
    let delta = coordinate(120.0 * pages * sign)?;
    Ok((
        if matches!(direction, "left" | "right") {
            MOUSEEVENTF_HWHEEL
        } else {
            MOUSEEVENTF_WHEEL
        },
        delta as u32,
    ))
}
fn scroll(owner: &InputOwner, at: Point, direction: &str, pages: f64) -> Result<()> {
    let (flag, data) = wheel(direction, pages)?;
    owner.pointer(at, &[mouse_event(flag, data)])
}
fn type_text(owner: &InputOwner, text: &str) -> Result<()> {
    // Keep both UTF-16 surrogate units of each Unicode scalar in one send.
    for character in text.chars() {
        let mut encoded = [0u16; 2];
        let mut events = Vec::with_capacity(4);
        for unit in character.encode_utf16(&mut encoded) {
            events.push(key_event(0, *unit, KEYEVENTF_UNICODE));
            events.push(key_event(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        owner.send(&events)?;
    }
    Ok(())
}
fn chord(text: &str) -> Result<Vec<u16>> {
    let parts: Vec<_> = text.split('+').collect();
    let mut keys = Vec::new();
    for modifier in &parts[..parts.len() - 1] {
        keys.push(match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => 0x11,
            "shift" => 0x10,
            "alt" => 0x12,
            "super" | "win" | "cmd" => 0x5b,
            _ => return Err(Failure::new("invalid-request", "Unsupported key modifier")),
        });
    }
    keys.push(virtual_key(parts.last().copied().unwrap_or(""))?);
    Ok(keys)
}
fn virtual_key(text: &str) -> Result<u16> {
    let key = text.to_ascii_lowercase();
    let code = match key.as_str() {
        "return" | "enter" => 0x0d,
        "tab" => 0x09,
        "escape" | "esc" => 0x1b,
        "backspace" | "back_space" => 0x08,
        "delete" => 0x2e,
        "space" => 0x20,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "home" => 0x24,
        "end" => 0x23,
        "page_up" | "prior" => 0x21,
        "page_down" | "next" => 0x22,
        _ if key
            .strip_prefix('f')
            .and_then(|value| value.parse::<u16>().ok())
            .is_some_and(|number| (1..=12).contains(&number)) =>
        {
            0x70 + key[1..].parse::<u16>().unwrap() - 1
        }
        _ if key
            .strip_prefix("kp_")
            .and_then(|value| value.parse::<u16>().ok())
            .is_some_and(|number| number <= 9) =>
        {
            0x60 + key[3..].parse::<u16>().unwrap()
        }
        _ if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() => {
            key.to_ascii_uppercase().as_bytes()[0] as u16
        }
        _ => return Err(Failure::new("invalid-request", "Unsupported keyboard key")),
    };
    Ok(code)
}
fn press_key(owner: &InputOwner, key: &str) -> Result<()> {
    let keys = chord(key)?;
    let mut events = Vec::new();
    for key in &keys {
        events.push(key_event(*key, 0, KEYBD_EVENT_FLAGS(0)));
    }
    for key in keys.iter().rev() {
        events.push(key_event(*key, 0, KEYEVENTF_KEYUP));
    }
    owner.send(&events)
}
fn client(hwnd: HWND, at: Point) -> Result<isize> {
    let mut at = POINT {
        x: coordinate(at.x)?,
        y: coordinate(at.y)?,
    };
    unsafe {
        ScreenToClient(hwnd, &mut at).ok()?;
    }
    Ok(((at.y as u32 & 0xffff) << 16 | (at.x as u32 & 0xffff)) as i32 as isize)
}
fn post_click(owner: &InputOwner, hwnd: HWND, at: Point, button: &str, count: usize) -> Result<()> {
    let (down, up, flag) = match button {
        "" | "left" => (WM_LBUTTONDOWN, WM_LBUTTONUP, 1),
        "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, 2),
        "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, 16),
        _ => return Err(Failure::new("invalid-request", "Unsupported mouse button")),
    };
    let position = client(hwnd, at)?;
    for _ in 0..count {
        owner.post(hwnd, WM_MOUSEMOVE, 0, position)?;
        owner.post(hwnd, down, flag, position)?;
        pause(owner, 35)?;
        owner.post(hwnd, up, 0, position)?;
        pause(owner, 50)?;
    }
    Ok(())
}
fn post_drag(
    owner: &InputOwner,
    hwnd: HWND,
    from: Point,
    to: Point,
    progress: impl Fn(Point),
) -> Result<()> {
    owner.post(hwnd, WM_MOUSEMOVE, 0, client(hwnd, from)?)?;
    owner.post(hwnd, WM_LBUTTONDOWN, 1, client(hwnd, from)?)?;
    for step in 1..=12 {
        let at = Point {
            x: from.x + (to.x - from.x) * step as f64 / 12.0,
            y: from.y + (to.y - from.y) * step as f64 / 12.0,
        };
        owner.post(hwnd, WM_MOUSEMOVE, 1, client(hwnd, at)?)?;
        progress(at);
        pause(owner, 20)?;
    }
    owner.post(hwnd, WM_LBUTTONUP, 0, client(hwnd, to)?)
}
fn post_scroll(
    owner: &InputOwner,
    hwnd: HWND,
    at: Point,
    direction: &str,
    pages: f64,
) -> Result<()> {
    let (flag, data) = wheel(direction, pages)?;
    // WM_MOUSE(W)HEEL uses screen coordinates, unlike mouse button messages.
    let x = coordinate(at.x)?;
    let y = coordinate(at.y)?;
    let position = (((y as u32 & 0xffff) << 16) | (x as u32 & 0xffff)) as i32 as isize;
    owner.post(
        hwnd,
        if flag == MOUSEEVENTF_HWHEEL {
            WM_MOUSEHWHEEL
        } else {
            WM_MOUSEWHEEL
        },
        ((data & 0xffff) << 16) as usize,
        position,
    )
}
fn post_key(owner: &InputOwner, hwnd: HWND, key: &str) -> Result<()> {
    let keys = chord(key)?;
    for key in &keys {
        owner.post(hwnd, WM_KEYDOWN, *key as usize, 0)?;
    }
    pause(owner, 25)?;
    for key in keys.iter().rev() {
        owner.post(hwnd, WM_KEYUP, *key as usize, 0)?;
    }
    Ok(())
}
fn post_text(
    owner: &InputOwner,
    root: HWND,
    element: Option<&IUIAutomationElement>,
    text: &str,
) -> Result<()> {
    let unsupported = || {
        Failure::new(
            "unsupported",
            "This control does not support background text insertion; use a focused input target or set_value",
        )
    };
    let element = element.ok_or_else(unsupported)?;
    let hwnd = unsafe { element.CurrentNativeWindowHandle()? };
    if hwnd.0.is_null() || !window::owns(root, hwnd) {
        return Err(unsupported());
    }
    let mut class = [0u16; 256];
    let size = unsafe { GetClassNameW(hwnd, &mut class) };
    let class = String::from_utf16_lossy(&class[..size.max(0) as usize]).to_ascii_lowercase();
    if class != "edit" && !class.starts_with("richedit") {
        return Err(unsupported());
    }
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    owner.semantic()?;
    unsafe {
        // EM_REPLACESEL normally returns zero, including on success. Windows
        // reports an explicit UIPI refusal through last-error instead.
        SetLastError(WIN32_ERROR(0));
        let _ = SendMessageW(
            hwnd,
            0x00c2,
            Some(WPARAM(1)),
            Some(LPARAM(text.as_ptr() as isize)),
        );
        if GetLastError() == ERROR_ACCESS_DENIED {
            return Err(Failure::new(
                "input-rejected",
                "Windows denied the requested window text message (error 5)",
            ));
        }
    }
    Ok(())
}
fn ensure_enabled(element: &IUIAutomationElement) -> Result<()> {
    if !unsafe { element.CurrentIsEnabled()? }.as_bool() {
        return Err(Failure::new(
            "input-rejected",
            "The observed control is disabled",
        ));
    }
    Ok(())
}
fn state_action(
    owner: &InputOwner,
    element: &IUIAutomationElement,
    request: &Request,
) -> Result<()> {
    ensure_enabled(element)?;
    owner.mechanism("accessibility");
    unsafe {
        match request.tool.as_str() {
            "set_checked" => {
                let desired = request.value("checked").as_bool().ok_or_else(|| Failure::new("unsupported", "Windows supports setting checked to true or false, not an arbitrary mixed state"))?;
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .map_err(|_| {
                        Failure::new("unsupported", "The control has no Toggle pattern")
                    })?;
                let current = pattern.CurrentToggleState()?;
                let requested = if desired {
                    ToggleState_On
                } else {
                    ToggleState_Off
                };
                if current == requested {
                    owner.observed_state(json!({"checked":desired}));
                    return Ok(());
                }
                if current != ToggleState_On
                    && current != ToggleState_Off
                    && current != ToggleState_Indeterminate
                {
                    return Err(Failure::new(
                        "unsupported",
                        "The control's current checked state is unavailable",
                    ));
                }
                owner.semantic()?;
                pattern.Toggle()?;
                owner.checkpoint()?;
                let observed = pattern.CurrentToggleState()?;
                owner.observed_state(json!({"checked":if observed == ToggleState_Indeterminate {json!("mixed")} else {json!(observed == ToggleState_On)}}));
                if observed != requested {
                    return Err(Failure::new(
                        "verification-failed",
                        "One native toggle did not reach the requested checked state; no second toggle was sent",
                    ));
                }
                owner.verify();
            }
            "set_expanded" => {
                let desired = request
                    .value("expanded")
                    .as_bool()
                    .ok_or_else(|| Failure::new("invalid-request", "Expanded must be a boolean"))?;
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                    .map_err(|_| {
                        Failure::new("unsupported", "The control has no ExpandCollapse pattern")
                    })?;
                let requested = if desired {
                    ExpandCollapseState_Expanded
                } else {
                    ExpandCollapseState_Collapsed
                };
                let current = pattern.CurrentExpandCollapseState()?;
                if current == requested {
                    owner.observed_state(json!({"expanded":desired}));
                    return Ok(());
                }
                if current == ExpandCollapseState_LeafNode {
                    return Err(Failure::new(
                        "unsupported",
                        "A leaf control cannot be expanded or collapsed",
                    ));
                }
                owner.semantic()?;
                if desired {
                    pattern.Expand()?;
                } else {
                    pattern.Collapse()?;
                }
                owner.checkpoint()?;
                let observed = pattern.CurrentExpandCollapseState()?;
                if observed == ExpandCollapseState_Collapsed
                    || observed == ExpandCollapseState_Expanded
                {
                    owner.observed_state(
                        json!({"expanded":observed == ExpandCollapseState_Expanded}),
                    );
                }
                if observed != requested {
                    return Err(Failure::new(
                        "verification-failed",
                        "The control has not reached the requested expanded state",
                    ));
                }
                owner.verify();
            }
            "select" => {
                let mode = request.text("selection");
                if !matches!(mode, "" | "replace" | "add" | "remove") {
                    return Err(Failure::new(
                        "invalid-request",
                        "Selection must be replace, add or remove",
                    ));
                }
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .map_err(|_| {
                        Failure::new("unsupported", "The control has no SelectionItem pattern")
                    })?;
                let selected = pattern.CurrentIsSelected()?.as_bool();
                let only_selected = if selected && matches!(mode, "" | "replace") {
                    pattern
                        .CurrentSelectionContainer()
                        .ok()
                        .and_then(|container| {
                            container
                                .GetCurrentPatternAs::<IUIAutomationSelectionPattern>(
                                    UIA_SelectionPatternId,
                                )
                                .ok()
                        })
                        .and_then(|selection| selection.GetCurrentSelection().ok())
                        .and_then(|selection| selection.Length().ok())
                        == Some(1)
                } else {
                    false
                };
                if (mode == "add" && selected) || (mode == "remove" && !selected) || only_selected {
                    owner.observed_state(json!({"selected":selected}));
                    return Ok(());
                }
                owner.semantic()?;
                match mode {
                    "add" => pattern.AddToSelection()?,
                    "remove" => pattern.RemoveFromSelection()?,
                    _ => pattern.Select()?,
                }
                owner.checkpoint()?;
                let observed = pattern.CurrentIsSelected()?.as_bool();
                owner.observed_state(json!({"selected":observed}));
                if observed != (mode != "remove") {
                    return Err(Failure::new(
                        "verification-failed",
                        "The control has not reached the requested selection state",
                    ));
                }
                owner.verify();
            }
            "scroll_into_view" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
                    .map_err(|_| {
                        Failure::new("unsupported", "The control has no ScrollItem pattern")
                    })?;
                owner.semantic()?;
                pattern.ScrollIntoView()?;
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}
fn pattern_available(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Result<bool> {
    let value = unsafe { element.GetCurrentPropertyValueEx(property, true)? };
    // Do not coerce NotSupported, missing or provider failures to false. Only
    // an actual Boolean false proves no dispatch-capable semantic mechanism.
    if value.vt() != windows::Win32::System::Variant::VT_BOOL {
        return Err(Failure::new(
            "driver-error",
            "The provider did not report pattern availability",
        ));
    }
    Ok(bool::try_from(&value)?)
}
fn preferred_click(owner: &InputOwner, element: &IUIAutomationElement) -> Result<bool> {
    unsafe {
        if pattern_available(element, UIA_IsInvokePatternAvailablePropertyId)? {
            let pattern =
                element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)?;
            owner.semantic()?;
            pattern.Invoke()?;
        } else if pattern_available(element, UIA_IsSelectionItemPatternAvailablePropertyId)? {
            let pattern = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )?;
            owner.semantic()?;
            pattern.Select()?;
        } else if pattern_available(element, UIA_IsTogglePatternAvailablePropertyId)? {
            let pattern =
                element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)?;
            owner.semantic()?;
            pattern.Toggle()?;
        } else {
            return Ok(false);
        }
        Ok(true)
    }
}
fn secondary(owner: &InputOwner, element: &IUIAutomationElement, action: &str) -> Result<()> {
    unsafe {
        match action.to_ascii_lowercase().as_str() {
            "invoke" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)?;
                owner.semantic()?;
                pattern.Invoke()?;
            }
            "toggle" => {
                let pattern = element
                    .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)?;
                owner.semantic()?;
                pattern.Toggle()?;
            }
            "select" => {
                let pattern = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )?;
                owner.semantic()?;
                pattern.Select()?;
            }
            "expand" | "collapse" => {
                let pattern = element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )?;
                owner.semantic()?;
                if action.eq_ignore_ascii_case("expand") {
                    pattern.Expand()?;
                } else {
                    pattern.Collapse()?;
                }
            }
            "scrollintoview" => {
                let pattern = element.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(
                    UIA_ScrollItemPatternId,
                )?;
                owner.semantic()?;
                pattern.ScrollIntoView()?;
            }
            "setfocus" => {
                owner.semantic()?;
                element.SetFocus()?;
            }
            _ => {
                return Err(Failure::new(
                    "unsupported",
                    "Unsupported accessibility secondary action",
                ));
            }
        }
        Ok(())
    }
}
fn scroll_amount(direction: &str) -> Result<(ScrollAmount, ScrollAmount)> {
    match direction {
        "up" => Ok((ScrollAmount_NoAmount, ScrollAmount_LargeDecrement)),
        "down" => Ok((ScrollAmount_NoAmount, ScrollAmount_LargeIncrement)),
        "left" => Ok((ScrollAmount_LargeDecrement, ScrollAmount_NoAmount)),
        "right" => Ok((ScrollAmount_LargeIncrement, ScrollAmount_NoAmount)),
        _ => Err(Failure::new(
            "invalid-request",
            "Unsupported scroll direction",
        )),
    }
}
fn repeat_pages(request: &Request) -> Result<usize> {
    let pages = request.number("pages");
    if !pages.is_finite() || pages.ceil() > usize::MAX as f64 {
        return Err(Failure::new("invalid-request", "Invalid scroll amount"));
    }
    Ok(pages.ceil().max(1.0) as usize)
}
fn set_value(owner: &InputOwner, element: &IUIAutomationElement, value: &str) -> Result<()> {
    ensure_enabled(element)?;
    unsafe {
        let pattern = element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .map_err(|_| {
                Failure::new(
                    "unsupported",
                    "The selected control does not support setting its value",
                )
            })?;
        if pattern.CurrentIsReadOnly()?.as_bool() {
            return Err(Failure::new(
                "unsupported",
                "The selected field is read-only",
            ));
        }
        owner.semantic()?;
        pattern.SetValue(&BSTR::from(value))?;
        if !element.CurrentIsPassword()?.as_bool() {
            if let Ok(observed) = pattern.CurrentValue() {
                if observed.to_string() != value {
                    return Err(Failure::new(
                        "verification-failed",
                        "The field value did not match the requested value",
                    ));
                }
                owner.observed_state(json!({"value":observed.to_string()}));
                owner.verify();
            }
        }
        Ok(())
    }
}
fn open(owner: &InputOwner, request: &Request) -> Result<Value> {
    let supplied = ["url", "path", "command"]
        .into_iter()
        .filter(|key| !request.text(key).is_empty())
        .collect::<Vec<_>>();
    if supplied.len() != 1 {
        return Err(Failure::new(
            "invalid-request",
            "Open requires exactly one of url, path or command",
        ));
    }
    if supplied[0] == "command" {
        let args = match request.value("args") {
            Value::Null => vec![],
            Value::Array(args) => args
                .iter()
                .map(|arg| {
                    arg.as_str().map(str::to_owned).ok_or_else(|| {
                        Failure::new("invalid-request", "Command arguments must be strings")
                    })
                })
                .collect::<Result<Vec<_>>>()?,
            _ => {
                return Err(Failure::new(
                    "invalid-request",
                    "Command arguments must be an array",
                ));
            }
        };
        owner.semantic()?;
        let child = std::process::Command::new(request.text("command"))
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| {
                Failure::new(
                    "driver-error",
                    format!(
                        "Could not launch the requested command (OS error {:?})",
                        error.raw_os_error()
                    ),
                )
            })?;
        return Ok(json!({"ok":true,"pid":child.id()}));
    }
    let wide: Vec<u16> = request
        .text(supplied[0])
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpFile: PCWSTR(wide.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    owner.semantic()?;
    unsafe {
        ShellExecuteExW(&mut execute)?;
        let pid = if !execute.hProcess.is_invalid() {
            let pid = GetProcessId(execute.hProcess);
            let _ = CloseHandle(execute.hProcess);
            pid
        } else {
            0
        };
        Ok(json!({"ok":true,"pid":pid}))
    }
}

fn parse_element(value: &Value) -> Result<ElementRecord> {
    serde_json::from_value(value.clone())
        .map_err(|_| Failure::new("invalid-request", "Invalid observed element record"))
}

#[cfg(test)]
mod semantic_tests {
    use super::*;
    use windows::{
        Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
        core::w,
    };

    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    struct Fixture {
        hwnd: isize,
        worker: Option<thread::JoinHandle<()>>,
    }
    impl Fixture {
        fn new() -> Self {
            let (sender, receiver) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || unsafe {
                // Only test-owned standard controls, with no synthetic physical
                // input, unrelated apps, screenshots or focus acquisition.
                let hwnd = CreateWindowExW(
                    WS_EX_NOACTIVATE,
                    w!("STATIC"),
                    w!("Varin semantic test"),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    20,
                    20,
                    420,
                    240,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap();
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("BUTTON"),
                    w!("Auto save"),
                    WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_AUTOCHECKBOX as u32),
                    20,
                    20,
                    160,
                    24,
                    Some(hwnd),
                    Some(HMENU(101 as *mut _)),
                    None,
                    None,
                )
                .unwrap();
                for (id, y) in [(102, 60), (103, 100)] {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("BUTTON"),
                        w!("Save"),
                        WS_CHILD | WS_VISIBLE,
                        20,
                        y,
                        160,
                        24,
                        Some(hwnd),
                        Some(HMENU(id as *mut _)),
                        None,
                        None,
                    )
                    .unwrap();
                }
                sender.send(hwnd.0 as isize).unwrap();
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                    if !IsWindow(Some(hwnd)).as_bool() {
                        break;
                    }
                }
                if IsWindow(Some(hwnd)).as_bool() {
                    let _ = DestroyWindow(hwnd);
                }
            });
            Self {
                hwnd: receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
                worker: Some(worker),
            }
        }
        fn hwnd(&self) -> HWND {
            HWND(self.hwnd as *mut _)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                let _ = PostMessageW(Some(self.hwnd()), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            if let Some(worker) = self.worker.take() {
                worker.join().unwrap();
            }
        }
    }
    fn request(value: Value) -> Request {
        Request::parse(&value.to_string()).unwrap()
    }

    #[test]
    #[ignore = "requires interactive Windows desktop; creates only test-owned controls"]
    fn retained_native_queries_state_actions_and_window_lifetime() {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap();
        }
        let _com = Com;
        let fixture = Fixture::new();
        let automation = Automation::new().unwrap();
        let root = automation.root(fixture.hwnd(), &Value::Null).unwrap();
        let window_identity = automation.native_target(&root).unwrap();
        let bounds = window::bounds(fixture.hwnd()).unwrap();
        let find_checkbox = request(
            json!({"id":"q","tool":"query_elements","match":{"role":"checkbox","name":"Auto save"}}),
        );
        let found = automation
            .query(&root, &root, &bounds, &find_checkbox, || Ok(()))
            .unwrap();
        assert!(found.complete);
        assert_eq!(found.records.len(), 1);
        let observed = found.records[0].clone();
        assert_eq!(observed.checked, Some(json!(false)));
        let selected = automation
            .relocate(&root, &observed, || Ok(()))
            .unwrap()
            .unwrap();
        let property_query = request(
            json!({"id":"p","tool":"query_elements","properties":["checked","enabled","expanded"]}),
        );
        let properties = automation
            .properties(&selected, &property_query, || Ok(()))
            .unwrap();
        assert_eq!(properties["properties"]["checked"], false);
        assert_eq!(properties["unavailableProperties"], json!(["expanded"]));

        let owner = InputOwner::default();
        let set = request(json!({"id":"set","tool":"set_checked","checked":true}));
        owner.begin("set").unwrap();
        owner
            .bind_window(fixture.hwnd(), std::process::id())
            .unwrap();
        state_action(&owner, &selected, &set).unwrap();
        assert_eq!(owner.receipt(None)["effect"], "verified");
        assert_eq!(owner.receipt(None)["observedState"]["checked"], true);
        owner.end();
        owner.begin("already-set").unwrap();
        owner
            .bind_window(fixture.hwnd(), std::process::id())
            .unwrap();
        state_action(&owner, &selected, &set).unwrap();
        assert_eq!(owner.receipt(None)["effect"], "none");
        owner.end();

        let duplicates = automation
            .query(
                &root,
                &root,
                &bounds,
                &request(
                    json!({"id":"duplicates","tool":"query_elements","match":{"name":"Save"}}),
                ),
                || Ok(()),
            )
            .unwrap();
        assert!(duplicates.complete);
        assert_eq!(duplicates.records.len(), 2);
        // Reading another region does not retire the first reference.
        assert!(
            automation
                .relocate(&root, &observed, || Ok(()))
                .unwrap()
                .is_some()
        );
        let outline = automation
            .render(
                &root,
                &root,
                &bounds,
                &request(json!({"id":"outline","tool":"get_app_state","max_tree_depth":0})),
                || Ok(()),
            )
            .unwrap();
        assert!(!outline.complete);
        assert!(outline.records[0].has_more_children);
        automation.release(&[json!(observed)]);
        assert_eq!(
            automation
                .relocate(&root, &observed, || Ok(()))
                .unwrap_err()
                .code,
            "target_lost"
        );
        let hwnd = fixture.hwnd();
        drop(fixture);
        // Destroy notifications invalidate tokens independently of title/PID,
        // including when the OS subsequently recycles the numeric HWND.
        assert_eq!(
            automation.root(hwnd, &window_identity).unwrap_err().code,
            "window_lost"
        );
    }
}
