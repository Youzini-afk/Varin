//! UI Automation objects live exclusively on the operation worker's MTA.
//! Cache requests retrieve the properties used by each query together, rather
//! than issuing a cross-process call for every field in every tree node.
use crate::{
    protocol::{limit_text, text_limit, Rect, Request, Result},
    targeting::{self, ElementRecord},
};
use std::{collections::HashSet, marker::PhantomData, rc::Rc};
use windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::HWND,
        System::{
            Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, SAFEARRAY},
            Ole::{
                SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetElemsize,
                SafeArrayGetLBound, SafeArrayGetUBound,
            },
        },
        UI::Accessibility::*,
    },
};

pub struct Automation {
    api: IUIAutomation,
    observation: IUIAutomationCacheRequest,
    identity: IUIAutomationCacheRequest,
    all: IUIAutomationCondition,
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
            Ok(Self {
                api,
                observation,
                identity,
                all,
                _apartment: PhantomData,
            })
        }
    }
    pub fn root(&self, hwnd: HWND) -> Result<IUIAutomationElement> {
        Ok(unsafe {
            self.api
                .ElementFromHandleBuildCache(hwnd, &self.observation)?
        })
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
        root: &IUIAutomationElement,
        bounds: &Rect,
        request: &Request,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<(Vec<ElementRecord>, Vec<String>)> {
        let nodes = request.positive("max_tree_nodes", 1200);
        let depth = request.positive("max_tree_depth", 64);
        let limit = text_limit(request.value("text_limit"));
        let mut records = Vec::new();
        let mut lines = Vec::new();
        let mut visited = HashSet::new();
        checkpoint()?;
        let root = unsafe { root.BuildUpdatedCache(&self.observation)? };
        let mut stack = vec![(root, 0usize)];
        while let Some((element, level)) = stack.pop() {
            checkpoint()?;
            if records.len() >= nodes {
                break;
            }
            if level > depth {
                continue;
            }
            let record = record_cached(&element, records.len(), bounds, limit);
            if !record.runtime_id.is_empty() && !visited.insert(record.runtime_id.clone()) {
                continue;
            }
            lines.push(tree_line(&record, level));
            records.push(record);
            if level >= depth || records.len() >= nodes {
                continue;
            }
            checkpoint()?;
            // A disappearing provider branch should not discard an otherwise
            // useful observation. Cancellation is checked outside this fallback.
            if let Ok(children) = unsafe {
                element.FindAllBuildCache(TreeScope_Children, &self.all, &self.observation)
            } {
                checkpoint()?;
                let count = unsafe { children.Length() }.unwrap_or(0);
                for index in (0..count).rev() {
                    checkpoint()?;
                    if let Ok(child) = unsafe { children.GetElement(index) } {
                        stack.push((child, level + 1));
                    }
                }
            }
        }
        checkpoint()?;
        Ok((records, lines))
    }
    pub fn relocate(
        &self,
        root: &IUIAutomationElement,
        observed: &ElementRecord,
        checkpoint: impl Fn() -> Result<()>,
    ) -> Result<Option<IUIAutomationElement>> {
        checkpoint()?;
        let mut elements = vec![unsafe { root.BuildUpdatedCache(&self.identity)? }];
        // Identity matching must inspect the complete selected subtree, not the
        // presentation budget from the previous observation.
        if let Ok(descendants) =
            unsafe { root.FindAllBuildCache(TreeScope_Descendants, &self.all, &self.identity) }
        {
            checkpoint()?;
            for index in 0..unsafe { descendants.Length()? } {
                checkpoint()?;
                if let Ok(element) = unsafe { descendants.GetElement(index) } {
                    elements.push(element);
                }
            }
        }
        let mut identities = Vec::with_capacity(elements.len());
        for element in &elements {
            checkpoint()?;
            identities.push(identity_cached(element));
        }
        let matched = targeting::relocate(observed, &identities)?;
        checkpoint()?;
        Ok(matched.map(|index| elements.swap_remove(index)))
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
            record.value = element
                .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
                .and_then(|pattern| pattern.CachedValue().ok())
                .map(|text| limit_text(&text.to_string(), limit))
                .unwrap_or_default();
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
            .is_ok()
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
        assert_eq!(tree_line(&record, 1), "\t\t3 edit ID: input Value: a\\nb Secondary Actions: SetValue Frame: {x: 12, y: 20, width: 50, height: 30}");
    }
}
