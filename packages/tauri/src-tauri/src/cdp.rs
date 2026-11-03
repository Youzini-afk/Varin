//! Native-only CDP requests for trusted workbench capture/cache operations.
//! This object is never exposed as a generic renderer command.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Webview;
use tauri_runtime_cef::{DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};
use tokio::sync::{oneshot, watch};
type Reply = Result<Value, String>;
#[derive(Clone)]
enum OriginalClose {
    Application(crate::lifecycle::CloseReceipt),
    Owned(watch::Receiver<bool>),
}
impl OriginalClose {
    fn closed(&self) -> bool {
        match self {
            Self::Application(receipt) => receipt.closed(),
            Self::Owned(receipt) => *receipt.borrow(),
        }
    }
    async fn wait(&self) -> Result<(), String> {
        match self {
            Self::Application(receipt) => {
                receipt.wait_termination().await;
                Ok(())
            }
            Self::Owned(receipt) => crate::cdp_settlement::wait_closed(receipt.clone()).await,
        }
    }
}
#[derive(Clone)]
pub struct Session {
    view: Webview,
    pending: Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>,
    close: OriginalClose,
    document: watch::Sender<()>,
}
impl Session {
    /// Reuse an existing native owner's observer and settlement registry. This
    /// is private diagnostic access, never a renderer command or second owner.
    pub(crate) fn from_owned(
        view: Webview,
        pending: Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>,
        close: watch::Receiver<bool>,
        document: watch::Sender<()>,
    ) -> Self {
        Self {
            view,
            pending,
            close: OriginalClose::Owned(close),
            document,
        }
    }
    pub fn attach(view: Webview, close: crate::lifecycle::CloseReceipt) -> Result<Self, String> {
        let pending: Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>> = Arc::default();
        let replies = pending.clone();
        view.on_dev_tools_protocol(move |message| {
            if let DevToolsProtocol::Message(bytes) = message {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(id) = value["id"].as_i64().and_then(|id| i32::try_from(id).ok()) {
                        if let Some(reply) = replies.lock().unwrap().remove(&id) {
                            let _ = reply.send(if value["error"].is_object() {
                                Err("Native page operation failed".into())
                            } else {
                                Ok(value["result"].clone())
                            });
                        }
                    }
                }
            }
        })
        .map_err(|_| "Native page observer could not attach")?;
        let ended = pending.clone();
        let original_close = close.clone();
        tauri::async_runtime::spawn(async move {
            close.wait_termination().await;
            for (_, reply) in ended.lock().unwrap().drain() {
                let _ = reply.send(Err(
                    "Page closed before its reply; outcome is unknown".into()
                ));
            }
        });
        Ok(Self {
            view,
            pending,
            close: OriginalClose::Application(original_close),
            document: watch::channel(()).0,
        })
    }
    pub fn document_ended(&self) {
        self.document.send_replace(());
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(
                "The original application document ended; effect outcome is unknown".into(),
            ));
        }
    }
    pub async fn request(&self, method: &str, params: Value) -> Reply {
        let document = self.document.subscribe();
        if self.close.closed() {
            return Err("The original native page is closed".into());
        }
        let id = allocate_devtools_message_id()
            .map_err(|_| "Native page message identity unavailable")?;
        let message = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|_| "Native page message could not be encoded")?;
        let (send, receive) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Native page observer unavailable")?
            .insert(id, send);
        if self.close.closed()
            || document.has_changed().unwrap_or(true)
            || self.view.send_dev_tools_message(&message).is_err()
        {
            self.pending.lock().unwrap().remove(&id);
            return Err("Native page dispatch is unconfirmed".into());
        }
        // The close callback may already have drained the map before insertion.
        // Retaining the original close receipt settles that late waiter too.
        let result = crate::cdp_settlement::settle(
            receive,
            crate::cdp_settlement::wait_original(self.close.wait(), document),
        )
        .await;
        self.pending
            .lock()
            .map_err(|_| "Native page observer unavailable")?
            .remove(&id);
        result
    }
}
