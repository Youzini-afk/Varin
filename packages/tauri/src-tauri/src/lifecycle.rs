//! CEF close is a request until on_before_close. A before-unload refusal leaves
//! the application Host alive and can be retried by a later user action.
use std::sync::Arc;
use tauri::{AppHandle, Manager, Webview, WebviewWindowBuilder};
use tauri_runtime_cef::{
    AsCefWebviewAttributes, WebviewCefExt,
    cef::{self, *},
};
use tokio::sync::watch;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Open,
    Pending,
    Cancelled,
    Closed,
}
#[derive(Clone)]
pub struct CloseReceipt(watch::Sender<Outcome>);
impl CloseReceipt {
    pub async fn wait_termination(&self) {
        let mut receipt = self.0.subscribe();
        while *receipt.borrow_and_update() != Outcome::Closed {
            if receipt.changed().await.is_err() {
                return;
            }
        }
    }
    pub fn closed(&self) -> bool {
        *self.0.borrow() == Outcome::Closed
    }
    pub async fn request(&self, view: &Webview) -> Result<(), String> {
        if self.closed() {
            return Ok(());
        }
        if *self.0.borrow() == Outcome::Pending {
            return Err("Window close is already pending".into());
        }
        self.0.send_replace(Outcome::Pending);
        let mut receipt = self.0.subscribe();
        if view.close().is_err() {
            self.0.send_replace(Outcome::Open);
            return Err("Window close could not be requested".into());
        }
        loop {
            let outcome = *receipt.borrow_and_update();
            match outcome {
                Outcome::Closed => return Ok(()),
                Outcome::Cancelled => {
                    return Err("Window close was cancelled; local services remain running".into());
                }
                _ => {}
            }
            receipt
                .changed()
                .await
                .map_err(|_| "Window termination could not be observed")?;
        }
    }
}
pub fn attach(
    builder: &mut WebviewWindowBuilder<'_, tauri::DynRuntime, AppHandle>,
    app: &AppHandle,
    label: &str,
) -> Result<CloseReceipt, String> {
    let (receipt, _) = watch::channel(Outcome::Open);
    let closed = receipt.clone();
    let app = app.clone();
    let label = label.to_owned();
    let dialog_receipt = receipt.clone();
    let attributes = builder
        .runtime_specific_attributes_mut()
        .as_cef_webview_attributes_mut()
        .ok_or("CEF close observer unavailable")?;
    attributes.native_close_handler = Some(Arc::new(move || {
        closed.send_replace(Outcome::Closed);
    }));
    attributes.native_js_dialog_handler = Some(Arc::new(move || {
        BeforeUnloadDialog::new(app.clone(), label.clone(), dialog_receipt.clone())
    }));
    Ok(CloseReceipt(receipt))
}
wrap_jsdialog_handler! {
    struct BeforeUnloadDialog { app:AppHandle, label:String, receipt:watch::Sender<Outcome>, }
    impl JsdialogHandler {
        fn on_before_unload_dialog(&self, _browser:Option<&mut Browser>, _message:Option<&CefString>, _is_reload:std::os::raw::c_int, callback:Option<&mut JsdialogCallback>)->std::os::raw::c_int {
            let Some(callback)=callback.cloned() else {return 0};
            let app=self.app.clone();let label=self.label.clone();let receipt=self.receipt.clone();
            crate::dialogs::show(&self.app,Some(&self.label),"Varin","This window has unsaved changes. Close it anyway?",
                crate::dialogs::Buttons::Confirm{accept:"Close window".into(),cancel:"Keep editing".into()},move |accepted| {
                    if let Some(view)=app.get_webview(&label) {
                        let _=view.with_cef_webview(move |_| {
                            callback.cont(i32::from(accepted),None);
                            if !accepted {receipt.send_replace(Outcome::Cancelled);}
                        });
                    }
                });
            1
        }
    }
}
