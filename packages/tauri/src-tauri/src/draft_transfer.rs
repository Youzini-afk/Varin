//! Native, per-target draft handoff receipts. Focus and delivery are not acceptance.
use crate::window_registry::{WindowRecord, WorkbenchAuthorityKey, workbench_authority_key};
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::sync::oneshot;

type Receipt = Result<(), String>;
#[derive(Default)]
pub(crate) struct Broker {
    pending: HashMap<String, Pending>,
}
struct Pending {
    source: String,
    source_document: String,
    target: String,
    authority: WorkbenchAuthorityKey,
    target_document: Option<String>,
    bytes: usize,
    deadline: std::time::Instant,
    transfer: Value,
    reply: oneshot::Sender<Receipt>,
}
pub(crate) fn validate(transfer: &Value) -> Receipt {
    if transfer["schemaVersion"] != 1 || !transfer["draft"].is_object() {
        return Err("Unsupported draft transfer".into());
    }
    for key in ["sourceDraftKey", "snapshotId", "directory", "projectId"] {
        if transfer[key].as_str().is_none()
            || (matches!(key, "sourceDraftKey" | "snapshotId") && transfer[key] == "")
        {
            return Err(format!("Draft transfer {key} is required"));
        }
    }
    for key in ["threadId", "branchId"] {
        if !transfer[key].is_null() && transfer[key].as_str().is_none_or(str::is_empty) {
            return Err(format!("Draft transfer {key} is invalid"));
        }
    }
    if transfer["threadId"].is_null() != transfer["branchId"].is_null() {
        return Err("Both thread and branch identities are required".into());
    }
    if transfer["sourceHostGeneration"].as_u64().is_none() {
        return Err("Draft source Host generation is required".into());
    }
    serialized_bytes(transfer)?;
    Ok(())
}
// Count without constructing a second potentially large serialized payload.
fn serialized_bytes(value: &Value) -> Result<usize, String> {
    struct Budget(usize);
    impl std::io::Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > crate::host_codec::MESSAGE_BYTES {
                return Err(std::io::Error::other("Native message budget exceeded"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut budget = Budget(0);
    serde_json::to_writer(&mut budget, value)
        .map_err(|_| "Draft transfer exceeds the native message budget")?;
    Ok(budget.0)
}
impl Broker {
    pub fn admit<C, D>(
        &mut self,
        windows: &HashMap<String, WindowRecord<C, D>>,
        source: &str,
        target: &str,
        transfer: Value,
    ) -> Result<(String, oneshot::Receiver<Receipt>), String> {
        validate(&transfer)?;
        if self
            .pending
            .values()
            .any(|pending| pending.source == source)
        {
            return Err("A draft transfer from this window is already pending".into());
        }
        let bytes = serialized_bytes(&transfer)?;
        if self
            .pending
            .values()
            .map(|pending| pending.bytes)
            .sum::<usize>()
            .saturating_add(bytes)
            > crate::host_codec::MESSAGE_BYTES
        {
            return Err("Pending drafts exceed the native message budget; retry after another transfer completes".into());
        }
        let source_record = windows.get(source).ok_or("Draft source is closed")?;
        let target_record = windows.get(target).ok_or("Draft target is closed")?;
        let authority = workbench_authority_key(
            source_record
                .bootstrap
                .as_ref()
                .ok_or("Draft source is not ready")?,
        )?;
        if workbench_authority_key(
            target_record
                .bootstrap
                .as_ref()
                .ok_or("Draft target is not ready")?,
        )? != authority
        {
            return Err("Draft target changed its connection authority".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, receiver) = oneshot::channel();
        self.pending.insert(
            id.clone(),
            Pending {
                source: source.into(),
                source_document: source_record.document_nonce.clone(),
                target: target.into(),
                authority,
                target_document: None,
                bytes,
                deadline: std::time::Instant::now() + std::time::Duration::from_secs(30),
                transfer,
                reply,
            },
        );
        Ok((id, receiver))
    }
    fn current<C, D>(pending: &Pending, windows: &HashMap<String, WindowRecord<C, D>>) -> Receipt {
        if std::time::Instant::now() >= pending.deadline {
            return Err("Draft acknowledgment timed out; acceptance is unknown".into());
        }
        for (label, document) in [
            (&pending.source, Some(&pending.source_document)),
            (&pending.target, pending.target_document.as_ref()),
        ] {
            let record = windows
                .get(label)
                .ok_or("Draft transfer window closed; acceptance is unknown")?;
            if document.is_some_and(|nonce| nonce != &record.document_nonce) {
                return Err("Draft transfer document changed; acceptance is unknown".into());
            }
            if record
                .bootstrap
                .as_ref()
                .is_none_or(|value| !workbench_authority_key(value).is_ok_and(|key| key == pending.authority))
            {
                return Err("Draft transfer connection authority changed; acceptance is unknown".into());
            }
        }
        Ok(())
    }
    /// Bind the receiver document only when its readiness receipt permits emission.
    pub fn delivery<C, D>(
        &mut self,
        windows: &HashMap<String, WindowRecord<C, D>>,
        target: &str,
        id: &str,
    ) -> Result<Option<Value>, String> {
        let Some(pending) = self.pending.get_mut(id) else {
            return Ok(None);
        };
        if pending.target != target {
            return Err("Wrong draft transfer target".into());
        }
        Self::current(pending, windows)?;
        let record = &windows[target];
        if !record.renderer_ready {
            return Err("Draft target document is not ready".into());
        }
        if pending.target_document.is_some() {
            return Err("Draft transfer was already delivered".into());
        }
        pending.target_document = Some(record.document_nonce.clone());
        let bootstrap = record.bootstrap.as_ref().unwrap();
        Ok(Some(
            json!({"transferId":id,"apiBaseUrl":bootstrap["apiBaseUrl"],"relayHostId":bootstrap["relayHostId"],"transfer":pending.transfer.take()}),
        ))
    }
    pub fn complete<C, D>(
        &mut self,
        windows: &HashMap<String, WindowRecord<C, D>>,
        caller: &str,
        id: &str,
        accepted: bool,
        reason: Option<&str>,
    ) -> Receipt {
        let pending = self
            .pending
            .get(id)
            .ok_or("Draft transfer is no longer pending")?;
        if pending.target != caller {
            return Err("Only the selected draft receiver may acknowledge".into());
        }
        if pending.target_document.is_none() {
            return Err("Draft transfer has not been delivered".into());
        }
        if let Err(error) = Self::current(pending, windows) {
            self.cancel(id, &error);
            return Err(error);
        }
        let pending = self.pending.remove(id).unwrap();
        let result = if accepted {
            Ok(())
        } else {
            Err(reason
                .filter(|s| !s.is_empty())
                .unwrap_or("Receiver did not accept the draft")
                .to_owned())
        };
        let _ = pending.reply.send(result);
        Ok(())
    }
    pub fn cancel(&mut self, id: &str, reason: &str) {
        if let Some(pending) = self.pending.remove(id) {
            let _ = pending.reply.send(Err(reason.into()));
        }
    }
    pub fn window_ended(&mut self, label: &str, document_only: bool) {
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| {
                p.source == label
                    || (p.target == label && (!document_only || p.target_document.is_some()))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel(
                &id,
                "Draft transfer window or document changed; acceptance is unknown",
            );
        }
    }
    pub fn reconcile<C, D>(&mut self, windows: &HashMap<String, WindowRecord<C, D>>) {
        let invalid: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(id, p)| Self::current(p, windows).err().map(|e| (id.clone(), e)))
            .collect();
        for (id, error) in invalid {
            self.cancel(&id, &error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::watch;
    fn windows() -> HashMap<String, WindowRecord<(), ()>> {
        ["mini-1", "main", "workbench-other"].into_iter().map(|label| (label.into(), WindowRecord {
            mini_thread: None, document_nonce: format!("{label}-document"), renderer_ready: true,
            navigation: vec![], native_ready: watch::channel(Some(Ok(false))).0,
            origin: url::Url::parse("http://tauri.localhost").unwrap(),
            bootstrap: Some(json!({"apiBaseUrl":"https://host.example","relayHostId":"relay-1","clientToken":"secret","requestHeaders":{}})), close: Some(()), cdp: None,
        })).collect()
    }
    fn transfer() -> Value {
        json!({"schemaVersion":1,"sourceDraftKey":"draft-1","snapshotId":"snapshot-1","sourceHostGeneration":3,"directory":" /untouched ","projectId":"p","draft":{"text":"private prompt","attachments":[{"id":"a","nested":{"raw":"preserved"}}]},"future":{"opaque":true}})
    }
    #[test]
    fn malformed_and_oversized_payloads_never_enter_the_broker() {
        let windows = windows();
        let mut broker = Broker::default();
        for (key, value) in [
            ("schemaVersion", json!(2)),
            ("sourceDraftKey", json!("")),
            ("snapshotId", json!(null)),
            ("sourceHostGeneration", json!(-1)),
            ("draft", json!("text")),
            ("threadId", json!("partial")),
        ] {
            let mut draft = transfer();
            draft[key] = value;
            assert!(broker.admit(&windows, "mini-1", "main", draft).is_err());
        }
        let mut draft = transfer();
        draft["draft"]["text"] = json!("x".repeat(crate::host_codec::MESSAGE_BYTES));
        assert!(broker.admit(&windows, "mini-1", "main", draft).is_err());
        assert!(broker.pending.is_empty());
    }
    #[tokio::test]
    async fn readiness_queue_stores_only_id_and_expiration_prevents_delivery() {
        let mut windows = windows();
        let mut broker = Broker::default();
        windows.get_mut("main").unwrap().renderer_ready = false;
        let bootstrap = windows["mini-1"].bootstrap.clone().unwrap();
        let (id, receipt) = broker
            .admit(&windows, "mini-1", "main", transfer())
            .unwrap();
        let action = json!({"type":"transfer-draft","transferId":id});
        assert!(
            crate::window_registry::queue_navigation(&mut windows, "main", &bootstrap, action)
                .unwrap()
                .is_none()
        );
        assert!(windows["main"].navigation[0].get("transfer").is_none());
        broker.cancel(&id, "Draft acknowledgment timed out; acceptance is unknown");
        assert!(receipt.await.unwrap().is_err());
        let target = windows.get_mut("main").unwrap();
        target.renderer_ready = true;
        for action in std::mem::take(&mut target.navigation) {
            assert_eq!(
                broker
                    .delivery(&windows, "main", action["transferId"].as_str().unwrap())
                    .unwrap(),
                None
            );
        }
    }
    #[tokio::test]
    async fn acknowledgment_not_focus_or_emission_accepts_unchanged_payload() {
        let windows = windows();
        let mut broker = Broker::default();
        let original = transfer();
        let (id, mut receipt) = broker
            .admit(&windows, "mini-1", "main", original.clone())
            .unwrap();
        assert!(matches!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(broker.complete(&windows, "main", &id, true, None).is_err());
        let detail = broker.delivery(&windows, "main", &id).unwrap().unwrap();
        assert_eq!(detail["transfer"], original);
        assert!(detail.get("clientToken").is_none());
        assert!(matches!(
            receipt.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        broker.complete(&windows, "main", &id, true, None).unwrap();
        assert_eq!(receipt.await.unwrap(), Ok(()));
        assert!(broker.pending.is_empty());
    }
    #[tokio::test]
    async fn binds_committed_ready_document_and_rejects_forged_receiver() {
        let mut windows = windows();
        let mut broker = Broker::default();
        windows.get_mut("main").unwrap().renderer_ready = false;
        let (id, receipt) = broker
            .admit(&windows, "mini-1", "main", transfer())
            .unwrap();
        assert!(broker.delivery(&windows, "main", &id).is_err());
        broker.window_ended("main", true); // Initial navigation after native creation.
        let target = windows.get_mut("main").unwrap();
        target.document_nonce = "committed-document".into();
        target.renderer_ready = true;
        broker.delivery(&windows, "main", &id).unwrap();
        assert!(
            broker
                .complete(&windows, "workbench-other", &id, true, None)
                .is_err()
        );
        broker
            .complete(
                &windows,
                "main",
                &id,
                false,
                Some("Receiver has a conflicting draft"),
            )
            .unwrap();
        assert_eq!(
            receipt.await.unwrap().unwrap_err(),
            "Receiver has a conflicting draft"
        );
    }
    #[tokio::test]
    async fn changed_document_host_and_closed_windows_reject_receipts() {
        for change in [
            "source-document",
            "target-document",
            "source-host",
            "target-host",
            "source-close",
            "target-close",
        ] {
            let mut windows = windows();
            let mut broker = Broker::default();
            let (id, receipt) = broker
                .admit(&windows, "mini-1", "main", transfer())
                .unwrap();
            broker.delivery(&windows, "main", &id).unwrap();
            let label = if change.starts_with("source") {
                "mini-1"
            } else {
                "main"
            };
            if change.ends_with("close") {
                windows.remove(label);
            } else if change.ends_with("document") {
                windows.get_mut(label).unwrap().document_nonce = "replacement".into();
            } else {
                windows.get_mut(label).unwrap().bootstrap.as_mut().unwrap()["relayHostId"] =
                    json!("other-host");
            }
            assert!(
                broker.complete(&windows, "main", &id, true, None).is_err(),
                "{change}"
            );
            assert!(receipt.await.unwrap().is_err(), "{change}");
            assert!(broker.pending.is_empty());
        }
    }
    #[tokio::test]
    async fn timeouts_cancel_payload_and_late_acknowledgments() {
        let windows = windows();
        let mut broker = Broker::default();
        let (id, receipt) = broker
            .admit(&windows, "mini-1", "main", transfer())
            .unwrap();
        assert!(
            broker
                .admit(&windows, "mini-1", "main", transfer())
                .is_err()
        );
        broker.delivery(&windows, "main", &id).unwrap();
        broker.pending.get_mut(&id).unwrap().deadline = std::time::Instant::now();
        assert!(broker.complete(&windows, "main", &id, true, None).is_err());
        assert!(receipt.await.unwrap().unwrap_err().contains("timed out"));
        assert_eq!(broker.delivery(&windows, "main", &id).unwrap(), None);
        let (id, receipt) = broker
            .admit(&windows, "mini-1", "main", transfer())
            .unwrap();
        broker.cancel(&id, "Draft acknowledgment timed out; acceptance is unknown");
        assert!(receipt.await.unwrap().is_err());
        assert!(broker.complete(&windows, "main", &id, true, None).is_err());
        assert_eq!(broker.delivery(&windows, "main", &id).unwrap(), None);
    }
    #[tokio::test]
    async fn same_endpoint_different_authorities_never_receive_a_draft() {
        for (field, replacement) in [("clientToken", json!("other-secret")),
            ("requestHeaders", json!({"X-Tenant":"other-tenant"}))] {
            let mut windows = windows();
            windows.get_mut("main").unwrap().bootstrap.as_mut().unwrap()[field] = replacement;
            let mut broker = Broker::default();
            assert!(broker.admit(&windows, "mini-1", "main", transfer()).is_err());
            assert!(broker.pending.is_empty());
        }
    }

    #[tokio::test]
    async fn credential_changes_cancel_in_flight_transfers_even_when_both_windows_rotate_together() {
        for labels in [vec!["mini-1"], vec!["main"], vec!["mini-1", "main"]] {
            for (field, replacement) in [("clientToken", json!("rotated-secret")),
                ("requestHeaders", json!({"X-Tenant":"different-tenant"}))] {
                let mut windows = windows();
                let mut broker = Broker::default();
                let (id, receipt) = broker.admit(&windows, "mini-1", "main", transfer()).unwrap();
                broker.delivery(&windows, "main", &id).unwrap();
                for label in &labels {
                    windows.get_mut(*label).unwrap().bootstrap.as_mut().unwrap()[field] = replacement.clone();
                }
                // The runtime-change owner calls this before completing its update.
                broker.reconcile(&windows);
                assert!(receipt.await.unwrap().is_err());
                assert!(broker.pending.is_empty());
                assert!(broker.complete(&windows, "main", &id, true, None).is_err());
            }
        }
    }

    #[tokio::test]
    async fn normalized_same_authority_accepts_without_exposing_its_credentials() {
        let mut windows = windows();
        for record in windows.values_mut() {
            record.bootstrap.as_mut().unwrap()["requestHeaders"] = json!({"Authorization":"Bearer secret", "X-Tenant":"one"});
        }
        windows.get_mut("main").unwrap().bootstrap.as_mut().unwrap()["requestHeaders"] = json!({"x-tenant":"one", "authorization":"Bearer secret"});
        windows.get_mut("main").unwrap().bootstrap.as_mut().unwrap()["apiBaseUrl"] = json!("https://HOST.example:443/#ignored");
        let mut broker = Broker::default();
        let (id, receipt) = broker.admit(&windows, "mini-1", "main", transfer()).unwrap();
        let delivered = broker.delivery(&windows, "main", &id).unwrap().unwrap();
        assert!(delivered.get("clientToken").is_none());
        assert!(delivered.get("requestHeaders").is_none());
        assert!(!delivered.to_string().contains("Bearer secret"));
        broker.reconcile(&windows);
        broker.complete(&windows, "main", &id, true, None).unwrap();
        assert!(receipt.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn lifecycle_rejects_promptly_without_waiting_for_ack() {
        for (label, document_only) in [
            ("mini-1", true),
            ("main", true),
            ("mini-1", false),
            ("main", false),
        ] {
            let windows = windows();
            let mut broker = Broker::default();
            let (id, receipt) = broker
                .admit(&windows, "mini-1", "main", transfer())
                .unwrap();
            broker.delivery(&windows, "main", &id).unwrap();
            broker.window_ended(label, document_only);
            assert!(receipt.await.unwrap().is_err());
        }
        let mut windows = windows();
        let mut broker = Broker::default();
        let (_, receipt) = broker
            .admit(&windows, "mini-1", "main", transfer())
            .unwrap();
        windows.get_mut("main").unwrap().bootstrap.as_mut().unwrap()["apiBaseUrl"] =
            json!("https://other.example");
        broker.reconcile(&windows);
        assert!(receipt.await.unwrap().is_err());
    }
}
