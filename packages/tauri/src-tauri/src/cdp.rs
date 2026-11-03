//! Native-only CDP requests for trusted workbench capture/cache operations.
//! This object is never exposed as a generic renderer command.
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Webview;
use tauri_runtime_cef::{DevToolsProtocol, WebviewCefExt, allocate_devtools_message_id};
use tokio::sync::oneshot;
type Reply = Result<Value, String>;
#[derive(Clone)]
pub struct Session {
    view: Webview,
    pending: Arc<Mutex<HashMap<i32, oneshot::Sender<Reply>>>>,
}
impl Session {
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
        tauri::async_runtime::spawn(async move {
            close.wait_termination().await;
            for (_, reply) in ended.lock().unwrap().drain() {
                let _ = reply.send(Err(
                    "Page closed before its reply; outcome is unknown".into()
                ));
            }
        });
        Ok(Self { view, pending })
    }
    pub fn document_ended(&self) {
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(
                "The original application document ended; effect outcome is unknown".into(),
            ));
        }
    }
    pub async fn request(&self, method: &str, params: Value) -> Reply {
        let id = allocate_devtools_message_id()
            .map_err(|_| "Native page message identity unavailable")?;
        let (send, receive) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Native page observer unavailable")?
            .insert(id, send);
        let message = serde_json::to_vec(&json!({"id":id,"method":method,"params":params}))
            .map_err(|_| "Native page message could not be encoded")?;
        if self.view.send_dev_tools_message(&message).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("Native page dispatch is unconfirmed".into());
        }
        receive
            .await
            .map_err(|_| "Native page response was lost; outcome is unknown")?
    }
}
