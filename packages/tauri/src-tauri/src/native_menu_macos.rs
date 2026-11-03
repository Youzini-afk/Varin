//! AppKit additions not represented by muda: original 16 pt template row icons
//! and macOS 14.4+ subtitles. All selectors run on the AppKit main thread.
use super::{TrayPresentation, TrayRow};
use objc2::{msg_send, rc::Retained, runtime::AnyObject, sel};
use objc2_foundation::{NSSize, NSString};
use tauri::tray::TrayIcon;

pub(super) fn decorate_tray(
    tray: &TrayIcon<tauri::DynRuntime>,
    presentation: &TrayPresentation,
) -> Result<(), String> {
    let presentation = presentation.clone();
    tray.with_inner_blocking(move |tray| {
        let Some(status) = tray.ns_status_item() else {
            return;
        };
        // SAFETY: the status item belongs to the live tray, all objects below are
        // retained for this call, and with_inner_blocking enters the main thread.
        unsafe {
            let menu: Option<Retained<AnyObject>> = msg_send![&*status, menu];
            let Some(menu) = menu else {
                return;
            };
            let mut index = 2usize;
            if !presentation.approvals.is_empty() {
                index += 1;
                decorate_rows(
                    &menu,
                    &presentation.approvals,
                    super::policy::VISIBLE_APPROVALS,
                    &mut index,
                );
                index += 1;
            }
            index += 1;
            decorate_rows(
                &menu,
                &presentation.sessions,
                super::policy::VISIBLE_SESSIONS,
                &mut index,
            );
        }
    })
    .map_err(super::error)
}
unsafe fn item(menu: &AnyObject, index: usize) -> Option<Retained<AnyObject>> {
    unsafe {
        let count: isize = msg_send![menu, numberOfItems];
        if index >= count.max(0) as usize {
            return None;
        }
        msg_send![menu,itemAtIndex:index as isize]
    }
}
unsafe fn decorate_rows(menu: &AnyObject, rows: &[TrayRow], limit: usize, index: &mut usize) {
    for row in rows.iter().take(limit) {
        unsafe {
            if let Some(item) = item(menu, *index) {
                decorate(&item, row);
            }
        }
        *index += 1;
    }
    if rows.len() > limit {
        unsafe {
            if let Some(parent_item) = item(menu, *index) {
                let submenu: Option<Retained<AnyObject>> = msg_send![&*parent_item, submenu];
                if let Some(submenu) = submenu {
                    for (index, row) in rows.iter().skip(limit).enumerate() {
                        if let Some(item) = item(&submenu, index) {
                            decorate(&item, row);
                        }
                    }
                }
            }
        }
        *index += 1;
    }
}
unsafe fn decorate(item: &AnyObject, row: &TrayRow) {
    unsafe {
        let image: Option<Retained<AnyObject>> = msg_send![item, image];
        if let Some(image) = image {
            let _: () = msg_send![&*image,setTemplate:true];
            let _: () = msg_send![&*image,setSize:NSSize::new(16.,16.)];
        }
        if let Some(subtitle) = &row.subtitle {
            // Electron's sublabel is likewise available only on macOS >=14.4.
            let supports: bool = msg_send![item,respondsToSelector:sel!(setSubtitle:)];
            if supports {
                let subtitle = NSString::from_str(subtitle);
                let _: () = msg_send![item,setSubtitle:&*subtitle];
            }
        }
    }
}
