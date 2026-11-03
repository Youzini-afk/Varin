//! Native prompts share the window toolkit. GTK3 must never be loaded beside
//! GTK4, and Linux message confirmations must not depend on an unbundled zenity.
use tauri::{AppHandle, Manager};
#[derive(Clone)]
pub enum Buttons {
    Acknowledge(String),
    Confirm { accept: String, cancel: String },
}
pub fn show(
    app: &AppHandle,
    label: Option<&str>,
    title: impl Into<String>,
    message: impl Into<String>,
    buttons: Buttons,
    complete: impl FnOnce(bool) + Send + 'static,
) {
    // Only fixed shell-owned catalog templates are translated. Dynamic OS
    // diagnostics and connection details which are not catalog keys stay intact.
    let locale = app.state::<crate::native_menu::NativeMenus>().locale();
    let title = crate::native_presentation::text(&locale, &title.into());
    let message = crate::native_presentation::text(&locale, &message.into());
    let buttons = match buttons {
        Buttons::Acknowledge(label) => {
            Buttons::Acknowledge(crate::native_presentation::text(&locale, &label))
        }
        Buttons::Confirm { accept, cancel } => Buttons::Confirm {
            accept: crate::native_presentation::text(&locale, &accept),
            cancel: crate::native_presentation::text(&locale, &cancel),
        },
    };
    #[cfg(target_os = "linux")]
    {
        let app_handle = app.clone();
        let label = label.map(str::to_owned);
        let complete = std::sync::Arc::new(std::sync::Mutex::new(Some(complete)));
        let failed = complete.clone();
        let scheduled = app.run_on_main_thread(move || {
            let parent = label
                .as_deref()
                .and_then(|label| app_handle.get_window(label))
                .or_else(|| app_handle.get_window("main"))
                .and_then(|window| window.gtk_window().ok());
            let dialog = gtk4::AlertDialog::builder()
                .message(&title)
                .detail(&message)
                .modal(true)
                .build();
            let accepted = match &buttons {
                Buttons::Acknowledge(label) => {
                    dialog.set_buttons(&[label]);
                    dialog.set_default_button(0);
                    dialog.set_cancel_button(0);
                    0
                }
                Buttons::Confirm { accept, cancel } => {
                    dialog.set_buttons(&[cancel, accept]);
                    dialog.set_default_button(0);
                    dialog.set_cancel_button(0);
                    1
                }
            };
            dialog.choose(
                parent.as_ref(),
                None::<&gtk4::gio::Cancellable>,
                move |result| {
                    if let Some(complete) = complete
                        .lock()
                        .ok()
                        .and_then(|mut callback| callback.take())
                    {
                        complete(result.is_ok_and(|index| index == accepted));
                    }
                },
            );
        });
        if scheduled.is_err() {
            if let Some(complete) = failed.lock().ok().and_then(|mut callback| callback.take()) {
                complete(false);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let _ = label;
        let buttons = match buttons {
            Buttons::Acknowledge(label) => MessageDialogButtons::OkCustom(label),
            Buttons::Confirm { accept, cancel } => {
                MessageDialogButtons::OkCancelCustom(accept, cancel)
            }
        };
        app.dialog()
            .message(message)
            .title(title)
            .buttons(buttons)
            .show(complete);
    }
}
pub async fn confirm(
    app: &AppHandle,
    label: Option<&str>,
    title: impl Into<String>,
    message: impl Into<String>,
    accept: impl Into<String>,
    cancel: impl Into<String>,
) -> bool {
    let (send, receive) = tokio::sync::oneshot::channel();
    show(
        app,
        label,
        title,
        message,
        Buttons::Confirm {
            accept: accept.into(),
            cancel: cancel.into(),
        },
        move |accepted| {
            let _ = send.send(accepted);
        },
    );
    receive.await.unwrap_or(false)
}
pub fn inform(app: &AppHandle, title: impl Into<String>, message: impl Into<String>) {
    show(
        app,
        None,
        title,
        message,
        Buttons::Acknowledge("OK".into()),
        |_| {},
    );
}
