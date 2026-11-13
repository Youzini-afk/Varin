//! UI Automation objects live exclusively on the operation worker's MTA.
//! Cache requests retrieve the properties used by each query together, rather
//! than issuing a cross-process call for every field in every tree node.
use crate::{
    protocol::{Failure, Rect, Request, Result, limit_text, text_limit},
    targeting::{self, ElementRecord},
};
use serde_json::{Map, Value, json};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    marker::PhantomData,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, FILETIME, HWND},
        System::{
            Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, SAFEARRAY},
            Ole::{
                SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetElemsize,
                SafeArrayGetLBound, SafeArrayGetUBound,
            },
            Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
        UI::{
            Accessibility::*,
            WindowsAndMessaging::{
                DispatchMessageW, EVENT_OBJECT_DESTROY, MSG, OBJID_WINDOW, PM_REMOVE, PeekMessageW,
                WINEVENT_OUTOFCONTEXT,
            },
        },
    },
    core::{BSTR, Interface},
};

#[derive(Clone)]
struct RetainedElement {
    element: IUIAutomationElement,
    window: String,
    runtime_id: Vec<i32>,
}
#[derive(Clone)]
struct RetainedWindow {
    root: IUIAutomationElement,
    process: (u32, u64),
    token: String,
}
#[derive(Default)]
struct Retained {
    next: u64,
    elements: HashMap<String, RetainedElement>,
    windows: HashMap<isize, RetainedWindow>,
}

pub struct Rendered {
    pub records: Vec<ElementRecord>,
    pub lines: Vec<String>,
    pub complete: bool,
    pub reason: Option<&'static str>,
    pub next_offset: Option<usize>,
}

pub struct Automation {
    api: IUIAutomation,
    observation: IUIAutomationCacheRequest,
    identity: IUIAutomationCacheRequest,
    all: IUIAutomationCondition,
    retained: RefCell<Retained>,
    session: String,
    window_events: HWINEVENTHOOK,
    // Do not accidentally move this apartment's COM objects to a control or
    // capture thread if windows-rs adds an agile marker in a future release.
    _apartment: PhantomData<Rc<()>>,
}
impl Automation {
    /// The caller initializes COM as MTA before constructing this owner, and
    /// drops it before CoUninitialize. The capture-only role never constructs it.
    pub fn new() -> Result<Self> {
        unsafe {
            let api: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let all = api.CreateTrueCondition()?;
            let identity = api.CreateCacheRequest()?;
            identity.SetTreeScope(TreeScope_Element)?;
            identity.SetTreeFilter(&all)?;
            for property in [
                UIA_RuntimeIdPropertyId,
                UIA_AutomationIdPropertyId,
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
            ] {
                identity.AddProperty(property)?;
            }
            let observation = identity.Clone()?;
            for property in [
                UIA_LocalizedControlTypePropertyId,
                UIA_ClassNamePropertyId,
                UIA_NativeWindowHandlePropertyId,
                UIA_BoundingRectanglePropertyId,
                UIA_IsPasswordPropertyId,
                UIA_HasKeyboardFocusPropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_ToggleToggleStatePropertyId,
                UIA_SelectionItemIsSelectedPropertyId,
                UIA_ValueValuePropertyId,
                UIA_ValueIsReadOnlyPropertyId,
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
            ] {
                observation.AddProperty(property)?;
            }
            for pattern in [
                UIA_InvokePatternId,
                UIA_TogglePatternId,
                UIA_SelectionItemPatternId,
                UIA_ExpandCollapsePatternId,
                UIA_ScrollItemPatternId,
                UIA_ScrollPatternId,
                UIA_ValuePatternId,
                UIA_TextPatternId,
            ] {
                observation.AddPattern(pattern)?;
            }
            let window_events = SetWinEventHook(
                EVENT_OBJECT_DESTROY,
                EVENT_OBJECT_DESTROY,
                None,
                Some(window_destroyed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if window_events.is_invalid() {
                return Err(Failure::new(
                    "driver-error",
                    "Could not establish native window-lifetime tracking",
                ));
            }
            Ok(Self {
                api,
                observation,
                identity,
                all,
                retained: RefCell::new(Retained::default()),
                window_events,
                session: format!(
                    "{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ),
                _apartment: PhantomData,
            })
        }
    }
    pub fn validate_target(&self, expected: &Value) -> Result<()> {
        if expected
            .get("uiaWindowId")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.starts_with(&format!("{}:w", self.session)))
        {
            return Err(Failure::new(
                "target_lost",
                "The native driver session changed; observe again",
            ));
        }
        Ok(())
    }
    pub fn root(&self, hwnd: HWND, expected: &Value) -> Result<IUIAutomationElement> {
        self.validate_target(expected)?;
        self.drain_window_events();
        if let Some(token) = expected.get("uiaWindowId").and_then(Value::as_str) {
            if self
                .retained
                .borrow()
                .windows
                .get(&(hwnd.0 as isize))
                .is_none_or(|window| window.token != token)
            {
                return Err(Failure::new(
                    "window_lost",
                    "The original window lifetime ended; observe again",
                ));
            }
        }
        let root = unsafe {
            self.api
                .ElementFromHandleBuildCache(hwnd, &self.observation)?
        };
        let pid = unsafe { root.CurrentProcessId()? } as u32;
        let process = (pid, process_creation(pid)?);
        let previous = self
            .retained
            .borrow()
            .windows
            .get(&(hwnd.0 as isize))
            .cloned();
        let same = match &previous {
            Some(window) if window.process == process => {
                unsafe { window.root.CurrentProcessId() }.is_ok_and(|old_pid| old_pid as u32 == pid)
                    && unsafe { self.api.CompareElements(&window.root, &root) }
                        .is_ok_and(|same| same.as_bool())
            }
            _ => false,
        };
        if let Some(token) = expected.get("uiaWindowId").and_then(Value::as_str) {
            if !same || previous.as_ref().is_none_or(|window| window.token != token) {
                return Err(Failure::new(
                    "window_lost",
                    "The original window instance is no longer available; observe again",
                ));
            }
        }
        if !same {
            let mut retained = self.retained.borrow_mut();
            if let Some(previous) = previous {
                retained
                    .elements
                    .retain(|_, element| element.window != previous.token);
            }
            retained.next += 1;
            let token = format!("{}:w{}", self.session, retained.next);
            retained.windows.insert(
                hwnd.0 as isize,
                RetainedWindow {
                    root: root.clone(),
                    process,
                    token,
                },
            );
        }
        Ok(root)
    }
    fn drain_window_events(&self) {
        // Out-of-context WinEvent callbacks are delivered on their registering
        // thread. Drain that thread's queue at native request boundaries, so a
        // destroy/reopen with a reused HWND cannot inherit an old window token.
        // The callback touches only scalar handles, never COM or the input lock.
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                DispatchMessageW(&message);
            }
        }
        let destroyed = DESTROYED_WINDOWS.with(|events| std::mem::take(&mut *events.borrow_mut()));
        let mut retained = self.retained.borrow_mut();
        for hwnd in destroyed {
            if let Some(window) = retained.windows.remove(&hwnd) {
                retained
                    .elements
                    .retain(|_, element| element.window != window.token);
            }
        }
    }
    pub fn validate_window(&self, root: &IUIAutomationElement) -> Result<()> {
        self.drain_window_events();
        self.window_token(root).map(|_| ())
    }
    pub fn native_target(&self, root: &IUIAutomationElement) -> Result<Value> {
        Ok(json!({"uiaWindowId":self.window_token(root)?}))
    }
    fn window_token(&self, root: &IUIAutomationElement) -> Result<String> {
        for window in self.retained.borrow().windows.values() {
            if unsafe { self.api.CompareElements(&window.root, root)? }.as_bool() {
                return Ok(window.token.clone());
            }
        }
        Err(Failure::new(
            "window_lost",
            "The original window identity is unavailable",
        ))
    }
    fn retain(
        &self,
        root: &IUIAutomationElement,
        element: &IUIAutomationElement,
        record: &mut ElementRecord,
    ) -> Result<()> {
        let window = self.window_token(root)?;
        let existing = self
            .retained
            .borrow()
            .elements
            .iter()
            .find_map(|(token, entry)| {
                (entry.window == window
                    && !record.runtime_id.is_empty()
                    && entry.runtime_id == record.runtime_id)
                    .then(|| token.clone())
            });
        if let Some(token) = existing {
            record.native_element_id = Some(token);
            return Ok(());
        }
        let mut retained = self.retained.borrow_mut();
        retained.next += 1;
        let token = format!("{}:e{}", self.session, retained.next);
        retained.elements.insert(
            token.clone(),
            RetainedElement {
                element: element.clone(),
                window,
                runtime_id: record.runtime_id.clone(),
            },
        );
        record.native_element_id = Some(token);
        Ok(())
    }
    pub fn retained_checkpoint(&self) -> HashSet<String> {
        self.retained.borrow().elements.keys().cloned().collect()
    }
    pub fn rollback_retained(&self, checkpoint: &HashSet<String>) {
        self.retained
            .borrow_mut()
            .elements
            .retain(|token, _| checkpoint.contains(token));
    }
    pub fn release(&self, records: &[Value]) {
        let mut retained = self.retained.borrow_mut();
        for record in records {
            if let Some(token) = record.get("nativeElementId").and_then(Value::as_str) {
                retained.elements.remove(token);
            }
        }
        // Window roots stay until the next window-instance validation; they also
        // bind window-only waits that legitimately retain no element records.
    }
    pub fn record(
        &self,
        element: &IUIAutomationElement,
        index: usize,
        bounds: &Rect,
        limit: Option<usize>,
    ) -> Result<ElementRecord> {
        let cached = unsafe { element.BuildUpdatedCache(&self.observation)? };
        Ok(record_cached(&cached, index, bounds, limit))
    }
    pub fn render(
        &self,
        window_root: &IUIAutomationElement,
        root: &IUIAutomationElement,
        bounds: &Rect,
        request: &Request,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<Rendered> {
        let nodes = request.positive("max_tree_nodes", 1200);
        let depth = request
            .value("max_tree_depth")
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(if request.text("view") == "outline" {
                3
            } else {
                64
            });
        let limit = text_limit(request.value("text_limit"));
        let mut result = Rendered {
            records: vec![],
            lines: vec![],
            complete: true,
            reason: None,
            next_offset: None,
        };
        let mut visited = HashSet::new();
        checkpoint()?;
        let root = unsafe { root.BuildUpdatedCache(&self.observation)? };
        let walker = unsafe { self.api.RawViewWalker()? };
        let mut stack = vec![(root, 0usize, None::<usize>)];
        while let Some((element, level, parent)) = stack.pop() {
            checkpoint()?;
            if result.records.len() >= nodes {
                result.complete = false;
                result.reason = Some("node_limit");
                if let Some(parent) = parent {
                    result.records[parent].has_more_children = true;
                }
                continue;
            }
            let mut record = record_cached(&element, result.records.len(), bounds, limit);
            if !record.runtime_id.is_empty() && !visited.insert(record.runtime_id.clone()) {
                result.complete = false;
                result.reason.get_or_insert("provider_incomplete");
                continue;
            }
            record.parent_index = parent;
            record.depth = level;
            self.retain(window_root, &element, &mut record)?;
            let index = record.index;
            // A one-child probe establishes expandability without reading an
            // entire omitted branch at the outline/depth boundary.
            if level >= depth || result.records.len() + 1 >= nodes {
                match first_child(&walker, &element) {
                    Ok(Some(_)) => {
                        record.has_children = Some(true);
                        record.has_more_children = true;
                        result.complete = false;
                        result.reason.get_or_insert(if level >= depth {
                            "depth_limit"
                        } else {
                            "node_limit"
                        });
                    }
                    Ok(None) => record.has_children = Some(false),
                    Err(_) => {
                        result.complete = false;
                        result.reason.get_or_insert("provider_incomplete");
                    }
                }
            } else {
                checkpoint()?;
                match unsafe {
                    element.FindAllBuildCache(TreeScope_Children, &self.all, &self.observation)
                } {
                    Ok(children) => {
                        let count = unsafe { children.Length()? };
                        record.has_children = Some(count > 0);
                        for child_index in (0..count).rev() {
                            checkpoint()?;
                            match unsafe { children.GetElement(child_index) } {
                                Ok(child) => stack.push((child, level + 1, Some(index))),
                                Err(_) => {
                                    record.has_more_children = true;
                                    result.complete = false;
                                    result.reason.get_or_insert("provider_incomplete");
                                }
                            }
                        }
                    }
                    Err(_) => {
                        record.has_more_children = true;
                        result.complete = false;
                        result.reason.get_or_insert("provider_incomplete");
                    }
                }
            }
            checkpoint()?;
            result.lines.push(tree_line(&record, level));
            result.records.push(record);
        }
        checkpoint()?;
        Ok(result)
    }
    pub fn relocate(
        &self,
        root: &IUIAutomationElement,
        observed: &ElementRecord,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<Option<IUIAutomationElement>> {
        checkpoint()?;
        if let Some(token) = &observed.native_element_id {
            let retained = self
                .retained
                .borrow()
                .elements
                .get(token)
                .cloned()
                .ok_or_else(|| {
                    Failure::new(
                        "target_lost",
                        "The retained control reference expired; observe again",
                    )
                })?;
            if retained.window != self.window_token(root)? {
                return Err(Failure::new(
                    "window_lost",
                    "The control belongs to a different window instance",
                ));
            }
            // Read current identity, not the observation cache. A recycled
            // provider object or an element moved to another window is not the
            // target just because its name still matches.
            let current = runtime_id(&retained.element);
            if (!retained.runtime_id.is_empty() && current != retained.runtime_id)
                || !self.contains(root, &retained.element)?
            {
                return Err(Failure::new(
                    "target_lost",
                    "The original control is no longer in its window",
                ));
            }
            checkpoint()?;
            return Ok(Some(retained.element));
        }
        // Compatibility records have no retained identity. Use native property
        // conditions, never a presentation-limited tree. Failed native searches
        // propagate rather than claiming uniqueness in an incomplete scan.
        let mut candidates = Vec::new();
        let mut records = Vec::new();
        let mut condition = self.all.clone();
        if !observed.runtime_id.is_empty() {
            // Older Host records have no retained handle. A full identity-only
            // lookup is needed once to preserve RuntimeId priority even if the
            // control's mutable label or AutomationId changed.
        } else if !observed.automation_id.is_empty() {
            condition =
                self.string_condition(UIA_AutomationIdPropertyId, &observed.automation_id, false)?;
        } else if !observed.name.is_empty() {
            condition = self.string_condition(UIA_NamePropertyId, &observed.name, false)?;
        }
        let elements =
            unsafe { root.FindAllBuildCache(TreeScope_Subtree, &condition, &self.identity)? };
        for index in 0..unsafe { elements.Length()? } {
            checkpoint()?;
            let element = unsafe { elements.GetElement(index)? };
            records.push(identity_cached(&element));
            candidates.push(element);
        }
        let matched = targeting::relocate(observed, &records)?;
        checkpoint()?;
        Ok(matched.map(|index| candidates.swap_remove(index)))
    }
    fn string_condition(
        &self,
        property: UIA_PROPERTY_ID,
        value: &str,
        contains: bool,
    ) -> Result<IUIAutomationCondition> {
        let value = windows::Win32::System::Variant::VARIANT::from(value);
        Ok(unsafe {
            self.api.CreatePropertyConditionEx(
                property,
                &value,
                if contains {
                    PropertyConditionFlags_MatchSubstring
                } else {
                    PropertyConditionFlags_None
                },
            )?
        })
    }
    fn match_condition(&self, query: &Value) -> Result<IUIAutomationCondition> {
        let mut condition = self.all.clone();
        let Some(query) = query.as_object() else {
            return Ok(condition);
        };
        for (name, value) in query {
            let property = match name.as_str() {
                "name" => UIA_NamePropertyId,
                "value" => UIA_ValueValuePropertyId,
                "enabled" => UIA_IsEnabledPropertyId,
                "selected" => UIA_SelectionItemIsSelectedPropertyId,
                "focused" => UIA_HasKeyboardFocusPropertyId,
                "checked" => UIA_ToggleToggleStatePropertyId,
                "expanded" => UIA_ExpandCollapseExpandCollapseStatePropertyId,
                "role" => UIA_ControlTypePropertyId,
                "nameMatch" | "valueMatch" => continue,
                _ => {
                    return Err(Failure::new(
                        "unsupported",
                        "The query contains an unsupported control property",
                    ));
                }
            };
            let next = if name == "name" || name == "value" {
                let (text, contains) = if let Some(text) = value.as_str() {
                    (
                        text,
                        query.get(&format!("{name}Match")).and_then(Value::as_str)
                            == Some("contains"),
                    )
                } else {
                    (
                        value.get("value").and_then(Value::as_str).ok_or_else(|| {
                            Failure::new("invalid-request", "Text match requires a string value")
                        })?,
                        value.get("mode").and_then(Value::as_str) == Some("contains"),
                    )
                };
                self.string_condition(property, text, contains)?
            } else {
                let variant = match name.as_str() {
                    "role" => windows::Win32::System::Variant::VARIANT::from(
                        role_control_type(value.as_str().unwrap_or(""))
                            .ok_or_else(|| {
                                Failure::new(
                                    "unsupported",
                                    "This role has no Windows UIA equivalent",
                                )
                            })?
                            .0,
                    ),
                    "checked" => windows::Win32::System::Variant::VARIANT::from(match value {
                        Value::Bool(true) => ToggleState_On.0,
                        Value::Bool(false) => ToggleState_Off.0,
                        Value::String(text) if text == "mixed" => ToggleState_Indeterminate.0,
                        _ => {
                            return Err(Failure::new(
                                "invalid-request",
                                "Invalid checked-state query",
                            ));
                        }
                    }),
                    "expanded" => windows::Win32::System::Variant::VARIANT::from(
                        if value.as_bool().ok_or_else(|| {
                            Failure::new("invalid-request", "Expanded must be a boolean")
                        })? {
                            ExpandCollapseState_Expanded.0
                        } else {
                            ExpandCollapseState_Collapsed.0
                        },
                    ),
                    _ => windows::Win32::System::Variant::VARIANT::from(
                        value.as_bool().ok_or_else(|| {
                            Failure::new("invalid-request", "Control state match must be a boolean")
                        })?,
                    ),
                };
                unsafe { self.api.CreatePropertyCondition(property, &variant)? }
            };
            condition = unsafe { self.api.CreateAndCondition(&condition, &next)? };
            let required_pattern = match name.as_str() {
                "checked" => Some(UIA_IsTogglePatternAvailablePropertyId),
                "expanded" => Some(UIA_IsExpandCollapsePatternAvailablePropertyId),
                "selected" => Some(UIA_IsSelectionItemPatternAvailablePropertyId),
                "value" => Some(UIA_IsValuePatternAvailablePropertyId),
                _ => None,
            };
            if let Some(property) = required_pattern {
                let available = unsafe {
                    self.api.CreatePropertyCondition(
                        property,
                        &windows::Win32::System::Variant::VARIANT::from(true),
                    )?
                };
                condition = unsafe { self.api.CreateAndCondition(&condition, &available)? };
            }
        }
        // Password values must never enter a query result or become a value
        // oracle. Filter value queries on the native provider side too.
        if query.contains_key("value") {
            let safe = unsafe {
                self.api.CreatePropertyCondition(
                    UIA_IsPasswordPropertyId,
                    &windows::Win32::System::Variant::VARIANT::from(false),
                )?
            };
            condition = unsafe { self.api.CreateAndCondition(&condition, &safe)? };
        }
        Ok(condition)
    }
    pub fn query(
        &self,
        window_root: &IUIAutomationElement,
        root: &IUIAutomationElement,
        bounds: &Rect,
        request: &Request,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<Rendered> {
        let condition = self.match_condition(request.value("match"))?;
        if request.value("max_tree_depth").is_number()
            || request.value("max_tree_nodes").is_number()
        {
            return self.query_bounded(window_root, root, bounds, request, checkpoint);
        }
        checkpoint()?;
        // UIA performs filtering within the chosen subtree. The provider returns
        // only matching property caches, not a serialized full-window tree.
        let matches =
            unsafe { root.FindAllBuildCache(TreeScope_Subtree, &condition, &self.observation)? };
        checkpoint()?;
        let count = unsafe { matches.Length()? }.max(0) as usize;
        let offset = request
            .value("offset")
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0);
        let limit = request.positive("limit", request.positive("max_tree_nodes", 100));
        let end = offset.saturating_add(limit).min(count);
        let mut result = Rendered {
            records: vec![],
            lines: vec![],
            complete: end >= count,
            reason: (end < count).then_some("result_limit"),
            next_offset: (end < count).then_some(end),
        };
        for index in offset..end {
            checkpoint()?;
            let element = unsafe { matches.GetElement(index as i32)? };
            let mut record = record_cached(
                &element,
                index,
                bounds,
                text_limit(request.value("text_limit")),
            );
            self.retain(window_root, &element, &mut record)?;
            record.ancestor_names = self.ancestors(root, &element, &checkpoint)?;
            result.lines.push(tree_line(&record, 0));
            result.records.push(record);
        }
        checkpoint()?;
        Ok(result)
    }
    fn query_bounded(
        &self,
        window_root: &IUIAutomationElement,
        root: &IUIAutomationElement,
        bounds: &Rect,
        request: &Request,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<Rendered> {
        let retained_before: HashSet<String> =
            self.retained.borrow().elements.keys().cloned().collect();
        let mut read = request.clone();
        read.params.insert("text_limit".into(), json!("max"));
        let rendered = self.render(window_root, root, bounds, &read, &checkpoint)?;
        let offset = request
            .value("offset")
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0);
        let limit = request.positive("limit", 100);
        let mut complete = rendered.complete;
        let mut reason = rendered.reason;
        let mut matches = vec![];
        for record in &rendered.records {
            match targeting::matches(record, request.value("match")) {
                Some(true) => matches.push(record.clone()),
                Some(false) => (),
                None => {
                    complete = false;
                    reason.get_or_insert("unavailable_properties");
                }
            }
        }
        let end = offset.saturating_add(limit).min(matches.len());
        let more = end < matches.len();
        let mut records = Vec::new();
        for mut record in matches.into_iter().skip(offset).take(limit) {
            let mut parent = record.parent_index;
            while let Some(index) = parent {
                let ancestor = &rendered.records[index];
                if !ancestor.name.is_empty() {
                    record.ancestor_names.push(ancestor.name.clone());
                }
                parent = ancestor.parent_index;
            }
            record.ancestor_names.reverse();
            record.parent_index = None;
            record.index = offset + records.len();
            record.name = limit_text(&record.name, text_limit(request.value("text_limit")));
            record.value = limit_text(&record.value, text_limit(request.value("text_limit")));
            records.push(record);
        }
        // Never release a target retained by an earlier observation just because
        // this bounded query did not select it. Newly discovered non-results do
        // not need a persistent COM reference.
        let selected: HashSet<_> = records
            .iter()
            .filter_map(|record| record.native_element_id.as_deref())
            .collect();
        self.retained.borrow_mut().elements.retain(|token, _| {
            retained_before.contains(token) || selected.contains(token.as_str())
        });
        let lines = records.iter().map(|record| tree_line(record, 0)).collect();
        Ok(Rendered {
            records,
            lines,
            complete: complete && !more,
            reason: if more { Some("result_limit") } else { reason },
            next_offset: more.then_some(end),
        })
    }
    fn ancestors(
        &self,
        root: &IUIAutomationElement,
        element: &IUIAutomationElement,
        checkpoint: &impl Fn() -> Result<()>,
    ) -> Result<Vec<String>> {
        let walker = unsafe { self.api.RawViewWalker()? };
        let mut names = vec![];
        let mut current = element.clone();
        let mut visited = HashSet::new();
        while !unsafe { self.api.CompareElements(root, &current)? }.as_bool() {
            checkpoint()?;
            let id = runtime_id(&current);
            if !id.is_empty() && !visited.insert(id) {
                break;
            }
            let Ok(parent) =
                (unsafe { walker.GetParentElementBuildCache(&current, &self.identity) })
            else {
                break;
            };
            let name = unsafe { parent.CachedName() }
                .map(|name| name.to_string())
                .unwrap_or_default();
            if !name.is_empty() {
                names.push(name);
            }
            current = parent;
        }
        names.reverse();
        Ok(names)
    }
    pub fn properties(
        &self,
        element: &IUIAutomationElement,
        request: &Request,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<Value> {
        // One element cache refresh, no FindAll, no focus/selection tree read.
        checkpoint()?;
        let cache = unsafe { element.BuildUpdatedCache(&self.observation)? };
        checkpoint()?;
        let record = record_cached(&cache, 0, &Rect::default(), None);
        let value_complete = text_limit(request.value("text_limit"))
            .is_none_or(|limit| record.value.chars().count() <= limit);
        let mut available = json!(&record);
        available["actions"] = json!(record.actions);
        let name = unsafe { cache.CachedName() }.ok();
        if name.is_none() {
            available.as_object_mut().unwrap().remove("name");
        }
        if record.role.is_empty() {
            available.as_object_mut().unwrap().remove("role");
        }
        if !record.value_available || !value_complete {
            available.as_object_mut().unwrap().remove("value");
        }
        let defaults = [
            "name", "value", "role", "enabled", "checked", "selected", "expanded", "focused",
            "actions",
        ];
        let requested: Vec<&str> = request
            .value("properties")
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_else(|| defaults.to_vec());
        let mut properties = Map::new();
        let mut unavailable = vec![];
        for name in requested {
            if defaults.contains(&name) {
                if let Some(value) = available.get(name).filter(|value| !value.is_null()) {
                    properties.insert(name.to_owned(), value.clone());
                    continue;
                }
            }
            unavailable.push(name);
        }
        Ok(
            json!({"ok":true, "properties":properties,"unavailableProperties":unavailable,"complete":true}),
        )
    }
    /// Return focus only when UIA ancestry places it in this exact window.
    /// Sharing a PID with the selected window is not sufficient.
    pub fn focused_element(
        &self,
        root: &IUIAutomationElement,
    ) -> Result<Option<IUIAutomationElement>> {
        let Ok(focused) = (unsafe { self.api.GetFocusedElementBuildCache(&self.observation) })
        else {
            return Ok(None);
        };
        if self.contains(root, &focused)? {
            Ok(Some(focused))
        } else {
            Ok(None)
        }
    }
    /// UIA fragments without native child HWNDs still need an exact subtree
    /// boundary before their semantic operations or focus can be used.
    pub fn contains(
        &self,
        root: &IUIAutomationElement,
        element: &IUIAutomationElement,
    ) -> Result<bool> {
        let walker = unsafe { self.api.RawViewWalker()? };
        let mut candidate = element.clone();
        let mut visited = HashSet::new();
        loop {
            if unsafe { self.api.CompareElements(root, &candidate)? }.as_bool() {
                return Ok(true);
            }
            let id = runtime_id(&candidate);
            // Providers normally supply runtime IDs. The interface address is a
            // local fallback only for loop detection, never target relocation.
            let key = if id.is_empty() {
                format!("pointer:{:p}", candidate.as_raw())
            } else {
                format!("runtime:{id:?}")
            };
            if !visited.insert(key) {
                return Ok(false);
            }
            match unsafe { walker.GetParentElement(&candidate) } {
                Ok(parent) => candidate = parent,
                Err(_) => return Ok(false),
            }
        }
    }
    pub fn focused(
        &self,
        root: &IUIAutomationElement,
        bounds: &Rect,
        limit: Option<usize>,
    ) -> Result<(Option<String>, Option<String>)> {
        let Some(focused) = self.focused_element(root)? else {
            return Ok((None, None));
        };
        let record = record_cached(&focused, 0, bounds, limit);
        let role = if record.localized_control_type.trim().is_empty() {
            &record.control_type
        } else {
            &record.localized_control_type
        };
        let summary = if record.name.trim().is_empty() {
            role.to_owned()
        } else {
            format!("{role} {}", record.name)
        };
        let selected = if unsafe { focused.CachedIsPassword() }
            .map(|flag| flag.as_bool())
            .unwrap_or(true)
        {
            None
        } else {
            // An extra UTF-16 unit is insufficient for a whole Unicode scalar.
            // Request enough units to apply the shared scalar-based text limit.
            let max = limit
                .and_then(|value| value.checked_add(1))
                .and_then(|value| value.checked_mul(2))
                .and_then(|value| i32::try_from(value).ok())
                .unwrap_or(-1);
            unsafe {
                focused
                    .GetCachedPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    .ok()
                    .and_then(|pattern| pattern.GetSelection().ok())
                    .and_then(|selection| {
                        if selection.Length().ok()? > 0 {
                            selection.GetElement(0).ok()
                        } else {
                            None
                        }
                    })
                    .and_then(|range| range.GetText(max).ok())
                    .map(|text| limit_text(&text.to_string(), limit))
            }
        };
        Ok((Some(summary), selected))
    }
}

thread_local! {
    static DESTROYED_WINDOWS: RefCell<HashSet<isize>> = RefCell::new(HashSet::new());
}
unsafe extern "system" fn window_destroyed(
    _: HWINEVENTHOOK,
    _: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _: u32,
    _: u32,
) {
    if object == OBJID_WINDOW.0 && child == 0 && !hwnd.0.is_null() {
        DESTROYED_WINDOWS.with(|events| {
            events.borrow_mut().insert(hwnd.0 as isize);
        });
    }
}
impl Drop for Automation {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWinEvent(self.window_events);
        }
    }
}
fn first_child(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
) -> Result<Option<IUIAutomationElement>> {
    // Preserve successful null (leaf) separately from a provider failure. The
    // generated non-null wrapper otherwise maps both to an error.
    unsafe {
        let mut raw = std::ptr::null_mut();
        (walker.vtable().GetFirstChildElement)(walker.as_raw(), element.as_raw(), &mut raw).ok()?;
        Ok(if raw.is_null() {
            None
        } else {
            Some(IUIAutomationElement::from_raw(raw))
        })
    }
}
fn process_creation(pid: u32) -> Result<u64> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)?;
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result = GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user);
        let _ = CloseHandle(process);
        result?;
        Ok((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64)
    }
}
#[allow(non_upper_case_globals)]
fn role(value: UIA_CONTROLTYPE_ID) -> String {
    match value {
        UIA_CheckBoxControlTypeId => "checkbox".into(),
        UIA_EditControlTypeId => "textbox".into(),
        UIA_RadioButtonControlTypeId => "radio".into(),
        UIA_ComboBoxControlTypeId => "combobox".into(),
        UIA_HyperlinkControlTypeId => "link".into(),
        UIA_ListItemControlTypeId => "listitem".into(),
        UIA_MenuItemControlTypeId => "menuitem".into(),
        UIA_TabItemControlTypeId => "tab".into(),
        UIA_TabControlTypeId => "tablist".into(),
        UIA_PaneControlTypeId => "pane".into(),
        UIA_DataGridControlTypeId => "grid".into(),
        UIA_DataItemControlTypeId => "row".into(),
        other => control_type(other)
            .trim_start_matches("ControlType.")
            .to_ascii_lowercase(),
    }
}
fn role_control_type(name: &str) -> Option<UIA_CONTROLTYPE_ID> {
    (UIA_ButtonControlTypeId.0..=UIA_AppBarControlTypeId.0)
        .map(UIA_CONTROLTYPE_ID)
        .find(|value| role(*value) == name || control_type(*value) == name)
}

fn cached_bool(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<bool> {
    let value = unsafe { element.GetCachedPropertyValueEx(property, true) }.ok()?;
    if value.vt() != windows::Win32::System::Variant::VT_BOOL {
        return None;
    }
    bool::try_from(&value).ok()
}
fn cached_i32(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<i32> {
    let value = unsafe { element.GetCachedPropertyValueEx(property, true) }.ok()?;
    if value.vt() != windows::Win32::System::Variant::VT_I4 {
        return None;
    }
    i32::try_from(&value).ok()
}
fn string(value: windows::core::Result<BSTR>) -> String {
    value.map(|value| value.to_string()).unwrap_or_default()
}
fn identity_cached(element: &IUIAutomationElement) -> ElementRecord {
    unsafe {
        ElementRecord {
            runtime_id: runtime_id(element),
            automation_id: string(element.CachedAutomationId()),
            name: string(element.CachedName()),
            control_type: element
                .CachedControlType()
                .map(control_type)
                .unwrap_or_default(),
            ..Default::default()
        }
    }
}
fn record_cached(
    element: &IUIAutomationElement,
    index: usize,
    bounds: &Rect,
    limit: Option<usize>,
) -> ElementRecord {
    let mut record = identity_cached(element);
    record.index = index;
    record.name = limit_text(&record.name, limit);
    unsafe {
        if let Ok(control) = element.CachedControlType() {
            record.role = role(control);
            record.platform_role = control_type(control);
        }
        record.enabled = cached_bool(element, UIA_IsEnabledPropertyId);
        record.focused = cached_bool(element, UIA_HasKeyboardFocusPropertyId);
        record.checked = element
            .GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .ok()
            .and_then(|_| cached_i32(element, UIA_ToggleToggleStatePropertyId).map(ToggleState))
            .and_then(|value| {
                if value == ToggleState_Off {
                    Some(json!(false))
                } else if value == ToggleState_On {
                    Some(json!(true))
                } else if value == ToggleState_Indeterminate {
                    Some(json!("mixed"))
                } else {
                    None
                }
            });
        record.selected = element
            .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .ok()
            .and_then(|_| cached_bool(element, UIA_SelectionItemIsSelectedPropertyId));
        record.expanded = element
            .GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
            .ok()
            .and_then(|_| {
                cached_i32(element, UIA_ExpandCollapseExpandCollapseStatePropertyId)
                    .map(ExpandCollapseState)
            })
            .and_then(|value| {
                if value == ExpandCollapseState_Expanded {
                    Some(true)
                } else if value == ExpandCollapseState_Collapsed {
                    Some(false)
                } else {
                    None
                }
            });
        record.localized_control_type = string(element.CachedLocalizedControlType());
        record.class_name = string(element.CachedClassName());
        record.native_window_handle = element
            .CachedNativeWindowHandle()
            .map(|hwnd| hwnd.0 as isize)
            .unwrap_or(0);
        record.frame = element.CachedBoundingRectangle().ok().and_then(|rect| {
            let frame = Rect {
                x: rect.left as f64 - bounds.x,
                y: rect.top as f64 - bounds.y,
                width: (rect.right as i64 - rect.left as i64) as f64,
                height: (rect.bottom as i64 - rect.top as i64) as f64,
            };
            frame.valid().then_some(frame)
        });
        if !element
            .CachedIsPassword()
            .map(|flag| flag.as_bool())
            .unwrap_or(true)
        {
            if let Some(value) = element
                .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
                .and_then(|pattern| pattern.CachedValue().ok())
            {
                record.value_available = true;
                record.value = limit_text(&value.to_string(), limit);
            }
        }
        let actions = &mut record.actions;
        if element
            .GetCachedPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .is_ok()
        {
            actions.push("Invoke".into());
        }
        if element
            .GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .is_ok()
        {
            actions.push("Toggle".into());
        }
        if element
            .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .is_ok()
        {
            actions.push("Select".into());
        }
        if let Ok(pattern) = element
            .GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        {
            match pattern.CachedExpandCollapseState() {
                Ok(state) if state == ExpandCollapseState_Collapsed => {
                    actions.push("Expand".into())
                }
                Ok(state) if state == ExpandCollapseState_Expanded => {
                    actions.push("Collapse".into())
                }
                Err(_) => {
                    actions.push("Expand".into());
                    actions.push("Collapse".into());
                }
                _ => (),
            }
        }
        if element
            .GetCachedPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
            .is_ok()
        {
            actions.push("ScrollIntoView".into());
        }
        if element
            .GetCachedPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
            .is_ok()
        {
            actions.push("Scroll".into());
        }
        if element
            .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok()
            .and_then(|pattern| pattern.CachedIsReadOnly().ok())
            .is_some_and(|value| !value.as_bool())
        {
            actions.push("SetValue".into());
        }
    }
    record
}
fn runtime_id(element: &IUIAutomationElement) -> Vec<i32> {
    struct Array(*mut SAFEARRAY);
    impl Drop for Array {
        fn drop(&mut self) {
            unsafe {
                let _ = SafeArrayDestroy(self.0);
            }
        }
    }
    unsafe {
        let Ok(raw) = element.GetRuntimeId() else {
            return Vec::new();
        };
        if raw.is_null() {
            return Vec::new();
        }
        let array = Array(raw);
        if SafeArrayGetDim(array.0) != 1
            || SafeArrayGetElemsize(array.0) != std::mem::size_of::<i32>() as u32
        {
            return Vec::new();
        }
        let (Ok(lower), Ok(upper)) = (
            SafeArrayGetLBound(array.0, 1),
            SafeArrayGetUBound(array.0, 1),
        ) else {
            return Vec::new();
        };
        let mut result = Vec::new();
        for index in lower..=upper {
            let mut value: i32 = 0;
            if SafeArrayGetElement(array.0, &index, &mut value as *mut _ as _).is_err() {
                return Vec::new();
            }
            result.push(value);
        }
        result
    }
}
fn control_type(value: UIA_CONTROLTYPE_ID) -> String {
    let names = [
        "Button",
        "Calendar",
        "CheckBox",
        "ComboBox",
        "Edit",
        "Hyperlink",
        "Image",
        "ListItem",
        "List",
        "Menu",
        "MenuBar",
        "MenuItem",
        "ProgressBar",
        "RadioButton",
        "ScrollBar",
        "Slider",
        "Spinner",
        "StatusBar",
        "Tab",
        "TabItem",
        "Text",
        "ToolBar",
        "ToolTip",
        "Tree",
        "TreeItem",
        "Custom",
        "Group",
        "Thumb",
        "DataGrid",
        "DataItem",
        "Document",
        "SplitButton",
        "Window",
        "Pane",
        "Header",
        "HeaderItem",
        "Table",
        "TitleBar",
        "Separator",
        "SemanticZoom",
        "AppBar",
    ];
    value
        .0
        .checked_sub(UIA_ButtonControlTypeId.0)
        .and_then(|index| usize::try_from(index).ok())
        .and_then(|index| names.get(index))
        .map(|name| format!("ControlType.{name}"))
        .unwrap_or_else(|| format!("ControlType.{}", value.0))
}
fn tree_line(record: &ElementRecord, depth: usize) -> String {
    let role = if record.localized_control_type.trim().is_empty() {
        &record.control_type
    } else {
        &record.localized_control_type
    };
    let title = if !record.name.trim().is_empty() {
        record.name.clone()
    } else if !record.automation_id.trim().is_empty() {
        format!("ID: {}", record.automation_id)
    } else {
        String::new()
    };
    let mut line = format!("{}{} {role} {title}", "\t".repeat(depth + 1), record.index);
    if !record.value.trim().is_empty() && record.value != title {
        line.push_str(&format!(
            " Value: {}",
            record.value.replace('\r', "\\r").replace('\n', "\\n")
        ));
    }
    if !record.actions.is_empty() {
        line.push_str(&format!(
            " Secondary Actions: {}",
            record.actions.join(", ")
        ));
    }
    if let Some(frame) = record.frame {
        line.push_str(&format!(
            " Frame: {{x: {:.0}, y: {:.0}, width: {:.0}, height: {:.0}}}",
            frame.x, frame.y, frame.width, frame.height
        ));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_type_names_preserve_the_wire_identifiers() {
        assert_eq!(control_type(UIA_EditControlTypeId), "ControlType.Edit");
        assert_eq!(control_type(UIA_WindowControlTypeId), "ControlType.Window");
        assert_eq!(control_type(UIA_AppBarControlTypeId), "ControlType.AppBar");
    }
    #[test]
    fn tree_lines_preserve_readable_values_actions_and_relative_frames() {
        let record = ElementRecord {
            index: 3,
            automation_id: "input".into(),
            localized_control_type: "edit".into(),
            value: "a\nb".into(),
            actions: vec!["SetValue".into()],
            frame: Some(Rect {
                x: 12.0,
                y: 20.0,
                width: 50.0,
                height: 30.0,
            }),
            ..Default::default()
        };
        assert_eq!(
            tree_line(&record, 1),
            "\t\t3 edit ID: input Value: a\\nb Secondary Actions: SetValue Frame: {x: 12, y: 20, width: 50, height: 30}"
        );
    }
}
