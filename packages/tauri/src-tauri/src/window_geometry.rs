//! Restore the original desktop geometry in global display-independent pixels.
use crate::geometry::{self, Display, Rect};
use serde_json::{Value, json};
pub fn restored(value: &Value, displays: &[Display]) -> Option<(Rect, u64, bool, bool)> {
    let number = |key: &str| value[key].as_f64().filter(|n| n.is_finite());
    let rectangle = Rect {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?.max(900.),
        height: number("height")?.max(560.),
    };
    let display = geometry::nearest(displays, rectangle, false)?;
    let area = display.work_area();
    let width = rectangle.width.min(area.width.max(800.));
    let height = rectangle.height.min(area.height.max(520.));
    let x = if width >= area.width {
        area.x
    } else {
        rectangle.x.clamp(area.x, area.x + area.width - width)
    };
    let y = if height >= area.height {
        area.y
    } else {
        rectangle.y.clamp(area.y, area.y + area.height - height)
    };
    Some((
        Rect {
            x,
            y,
            width,
            height,
        },
        display.id,
        value["maximized"] == true,
        value["fullscreen"] == true,
    ))
}
pub fn stored(rect: Rect, maximized: bool, fullscreen: bool) -> Value {
    json!({"x":rect.x,"y":rect.y,"width":rect.width.max(800.),"height":rect.height.max(520.),"maximized":maximized,"fullscreen":fullscreen})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restore_unplugged_screen_is_visible_and_preserves_state() {
        let area = Rect {
            x: 0.,
            y: 24.,
            width: 1920.,
            height: 1056.,
        };
        let displays = [Display::new(
            1,
            Rect {
                x: 0.,
                y: 0.,
                width: 1920.,
                height: 1080.,
            },
            area,
            1.,
        )];
        let(rect,id,maximized,fullscreen)=restored(&json!({"x":-4000,"y":4000,"width":4000,"height":2500,"maximized":true,"fullscreen":false}),&displays).unwrap();
        assert_eq!(rect, area);
        assert_eq!(id, 1);
        assert!(maximized);
        assert!(!fullscreen);
    }
    #[test]
    fn windows_mixed_dpi_keeps_the_original_connected_monitor_lane() {
        let main = Rect {
            x: 0.,
            y: 0.,
            width: 3840.,
            height: 2160.,
        };
        let other = Rect {
            x: 3840.,
            y: 0.,
            width: 1920.,
            height: 1080.,
        };
        let displays = geometry::layout(
            vec![
                Display::new(1, main, main, 2.),
                Display::new(2, other, other, 1.),
            ],
            1,
            true,
        );
        let (rect, id, _, _) = restored(
            &json!({"x":2000,"y":50,"width":950,"height":600}),
            &displays,
        )
        .unwrap();
        assert_eq!(id, 2);
        assert_eq!(rect.x, 2000.);
        assert_eq!(displays[1].to_physical(rect.x, rect.y), (3920., 50.));
    }
    #[test]
    fn missing_invalid_or_nonfinite_geometry_never_moves_the_window() {
        assert!(restored(&json!({"x":0,"y":0,"width":"huge","height":20}), &[]).is_none());
    }
}

#[cfg(feature = "desktop")]
pub fn displays(app: &tauri::AppHandle) -> Result<Vec<Display>, String> {
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    let id = |m: &tauri::Monitor| {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        m.name().hash(&mut hash);
        m.position().x.hash(&mut hash);
        m.position().y.hash(&mut hash);
        hash.finish()
    };
    let primary = app
        .primary_monitor()
        .map_err(|_| "Primary display unavailable")?
        .map(|m| id(&m));
    let monitors = app
        .available_monitors()
        .map_err(|_| "Display geometry unavailable")?;
    let displays = monitors
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            let a = m.work_area();
            Display::new(
                id(m),
                Rect {
                    x: p.x as f64,
                    y: p.y as f64,
                    width: s.width as f64,
                    height: s.height as f64,
                },
                Rect {
                    x: a.position.x as f64,
                    y: a.position.y as f64,
                    width: a.size.width as f64,
                    height: a.size.height as f64,
                },
                m.scale_factor(),
            )
        })
        .collect();
    Ok(geometry::layout(
        displays,
        primary.unwrap_or(0),
        cfg!(windows),
    ))
}
#[cfg(feature = "desktop")]
pub fn snapshot(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<Value, String> {
    let displays = displays(app)?;
    let p = window
        .outer_position()
        .map_err(|_| "Window position unavailable")?;
    let s = window.outer_size().map_err(|_| "Window size unavailable")?;
    let physical = Rect {
        x: p.x as f64,
        y: p.y as f64,
        width: s.width as f64,
        height: s.height as f64,
    };
    let display =
        geometry::nearest(&displays, physical, true).ok_or("Window display unavailable")?;
    let (x, y) = display.to_logical(physical.x, physical.y);
    Ok(stored(
        Rect {
            x,
            y,
            width: physical.width / display.scale,
            height: physical.height / display.scale,
        },
        window
            .is_maximized()
            .map_err(|_| "Maximized state unavailable")?,
        window
            .is_fullscreen()
            .map_err(|_| "Fullscreen state unavailable")?,
    ))
}
#[cfg(feature = "desktop")]
pub fn restore(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    value: &Value,
) -> Result<(), String> {
    let displays = displays(app)?;
    let Some((rect, id, maximized, fullscreen)) = restored(value, &displays) else {
        return Ok(());
    };
    let display = displays
        .iter()
        .find(|d| d.id == id)
        .ok_or("Restore display unavailable")?;
    let (x, y) = display.to_physical(rect.x, rect.y);
    let outer = window
        .outer_size()
        .map_err(|_| "Window frame size unavailable")?;
    let inner = window
        .inner_size()
        .map_err(|_| "Window content size unavailable")?;
    let width = (rect.width * display.scale - (outer.width as f64 - inner.width as f64)).max(1.);
    let height =
        (rect.height * display.scale - (outer.height as f64 - inner.height as f64)).max(1.);
    window
        .set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ))
        .map_err(|_| "Window position could not be restored")?;
    window
        .set_size(tauri::PhysicalSize::new(
            width.round() as u32,
            height.round() as u32,
        ))
        .map_err(|_| "Window size could not be restored")?;
    if maximized {
        window
            .maximize()
            .map_err(|_| "Window maximize could not be restored")?;
    }
    if fullscreen {
        window
            .set_fullscreen(true)
            .map_err(|_| "Window fullscreen could not be restored")?;
    }
    Ok(())
}
