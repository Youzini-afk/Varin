//! Identity matching is independent from the OS query so ambiguity is tested
//! without a fake desktop pretending to establish Windows behavior.
use crate::protocol::{Failure, Rect, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRecord {
    #[serde(default)]
    pub index: usize,
    #[serde(default)]
    pub runtime_id: Vec<i32>,
    #[serde(default)]
    pub automation_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub control_type: String,
    #[serde(default)]
    pub localized_control_type: String,
    #[serde(default)]
    pub class_name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub native_window_handle: isize,
    pub frame: Option<Rect>,
    #[serde(default)]
    pub actions: Vec<String>,
}

pub fn relocate(observed: &ElementRecord, live: &[ElementRecord]) -> Result<Option<usize>> {
    if !observed.runtime_id.is_empty() {
        if let Some(index) = live
            .iter()
            .position(|item| item.runtime_id == observed.runtime_id)
        {
            return Ok(Some(index));
        }
    }
    let ids: Vec<usize> = live
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            !observed.automation_id.trim().is_empty()
                && item.automation_id == observed.automation_id
                && item.control_type == observed.control_type
        })
        .map(|(index, _)| index)
        .collect();
    let mut candidates = if ids.is_empty() {
        live.iter()
            .enumerate()
            .filter(|(_, item)| {
                !observed.name.trim().is_empty()
                    && item.name == observed.name
                    && item.control_type == observed.control_type
            })
            .map(|(index, _)| index)
            .collect()
    } else {
        ids
    };
    if candidates.len() > 1
        && !observed.automation_id.trim().is_empty()
        && !observed.name.trim().is_empty()
    {
        let named: Vec<usize> = candidates
            .iter()
            .copied()
            .filter(|index| live[*index].name == observed.name)
            .collect();
        if !named.is_empty() {
            candidates = named;
        }
    }
    match candidates.as_slice() {
        [] => Ok(None), [index] => Ok(Some(*index)),
        _ => Err(Failure::new("target-changed", "Observed element has multiple matching controls; observe again and choose a distinguishable element")),
    }
}

pub fn check_geometry(
    actual: Rect,
    expected: Option<Rect>,
    dpi: f64,
    expected_dpi: Option<f64>,
) -> Result<()> {
    if !actual.valid() {
        return Err(Failure::new(
            "target-unavailable",
            "The selected window has no usable bounds",
        ));
    }
    if expected.is_some_and(|bounds| bounds != actual) {
        return Err(Failure::new(
            "target-changed",
            "Window geometry changed since the observation; observe again",
        ));
    }
    if expected_dpi.is_some_and(|expected| expected != dpi) {
        return Err(Failure::new(
            "target-changed",
            "Window DPI changed since the observation; observe again",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn element(id: &str, name: &str, runtime: i32) -> ElementRecord {
        ElementRecord {
            automation_id: id.into(),
            name: name.into(),
            runtime_id: vec![runtime],
            control_type: "ControlType.Button".into(),
            ..Default::default()
        }
    }
    #[test]
    fn runtime_identity_precedes_names() {
        let live = [element("primary", "Save", 1), element("other", "Save", 2)];
        assert_eq!(
            relocate(&element("primary", "Save", 2), &live).unwrap(),
            Some(1)
        );
    }
    #[test]
    fn unique_id_precedes_duplicate_names() {
        let live = [element("primary", "Save", 1), element("other", "Save", 2)];
        assert_eq!(
            relocate(&element("primary", "Save", 90), &live).unwrap(),
            Some(0)
        );
    }
    #[test]
    fn duplicate_names_are_rejected() {
        let live = [element("primary", "Save", 1), element("other", "Save", 2)];
        assert_eq!(
            relocate(&element("", "Save", 90), &live).unwrap_err().code,
            "target-changed"
        );
    }
    #[test]
    fn empty_runtime_ids_are_not_identity() {
        let mut observed = element("missing", "Absent", 1);
        observed.runtime_id.clear();
        let mut live = element("other", "Other", 2);
        live.runtime_id.clear();
        assert!(relocate(&observed, &[live]).unwrap().is_none());
    }
    #[test]
    fn duplicate_ids_use_unique_name_only_when_available() {
        let live = [element("same", "Save", 1), element("same", "Cancel", 2)];
        assert_eq!(
            relocate(&element("same", "Save", 90), &live).unwrap(),
            Some(0)
        );
        assert!(relocate(&element("same", "Unknown", 90), &live).is_err());
    }
    #[test]
    fn geometry_and_dpi_are_checked_independently() {
        let bounds = Rect {
            x: -400.0,
            y: 20.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(check_geometry(bounds, Some(bounds), 1.5, Some(1.5)).is_ok());
        assert!(check_geometry(bounds, None, 1.5, Some(2.0)).is_err());
        assert!(check_geometry(
            Rect {
                x: -399.0,
                ..bounds
            },
            Some(bounds),
            1.5,
            None
        )
        .is_err());
    }
}
