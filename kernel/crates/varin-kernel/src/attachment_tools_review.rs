//! Owner-channel behavior, actual frozen Catalog invocations and typed image projection.
use super::*;
use std::sync::mpsc;
use varin_runtime::execution::ToolOrigin;
#[allow(dead_code)]
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;

fn context() -> ToolExecutionContext {
    let origin = ToolOrigin::ModelStep {
        request_id: "original-request".into(),
    };
    ToolExecutionContext {
        run_id: "sender-run".into(),
        operation_id: origin.operation_id("send"),
        origin,
    }
}
fn attachment(reference: &str, mime: &str, len: u64) -> Attachment {
    Attachment { model_ref: None,
        reference: reference.into(),
        filename: "original.bin".into(),
        mime_type: mime.into(),
        byte_length: len,
    }
}
fn owner() -> (OwnerChannel, mpsc::Receiver<Value>) {
    let (tx, rx) = mpsc::sync_channel(16);
    let bridge = OwnerChannel::new("resource", tx);
    bridge.initialize("attachment-test");
    (bridge, rx)
}
fn reply(bridge: &OwnerChannel, request: &Value, result: Value) {
    bridge.receive(json!({"v":1,"kind":"resource-response","id":request["id"],
        "kernelEpoch":"attachment-test","result":result}));
}
fn prepared(bridge: OwnerChannel, attachments: Vec<Attachment>) -> PreparedAttachments {
    let context = context();
    PreparedAttachments {
        attachments,
        media: Vec::new(),
        bridge: Some(bridge),
        query: Some(json!({
            "runId":context.run_id,"origin":context.origin,"callId":"send","resourceCheckpointId":"original-checkpoint",
            "request":{"kind":"attachment_prepare","operationId":context.operation_id,
                "targetThreadId":"recipient","targetBranchId":"recipient-branch","attachments":[{"path":"original.bin"}]}
        })),
    }
}

#[test]
fn fixed_reference_and_complete_selection_are_required_before_delivery() {
    let selections = vec![
        AttachmentSelection::Ref {
            reference: "attachment:original".into(),
        },
        AttachmentSelection::Path {
            path: "different/original.bin".into(),
        },
    ];
    let first = attachment("attachment:original", "application/octet-stream", 5);
    let second = attachment("attachment:second", "application/octet-stream", 7);
    assert!(
        prepared_response(
            json!({"status":"ready","attachments":[first]}),
            &context(),
            &selections
        )
        .is_err()
    );
    assert!(
        prepared_response(
            json!({"status":"ready","attachments":[second,first]}),
            &context(),
            &selections
        )
        .is_err()
    );
    let accepted = prepared_response(
        json!({"status":"ready","attachments":[first,second]}),
        &context(),
        &selections,
    )
    .unwrap();
    assert_eq!(accepted.attachments, vec![first, second]);
    assert!(accepted.media.is_empty());
}

#[test]
fn original_frozen_sender_is_checked_before_owner_io() {
    let schema = crate::collaboration::schemas(vec![])
        .into_iter()
        .find(|schema| schema.name == "dispatch")
        .unwrap();
    let read =
        crate::tools::KernelToolExecutor::selected_schemas(&std::collections::BTreeSet::from([
            crate::tools::ToolKind::FileRead,
        ]))
        .remove(0);
    let mut f = fixture::Fixture::new_policy_parent_with_schemas(0, read, schema.clone());
    f.input.attachments = vec![AttachmentSelection::Path {
        path: "selected.csv".into(),
    }];
    let call = ToolCall {
        call_id: "dispatch-call".into(),
        name: "dispatch".into(),
        schema_version: schema.version,
        arguments: serde_json::to_value(&f.input).unwrap(),
    };
    f.context = f.admit_policy_call(call.clone());
    let context = f.context.clone();
    let catalog = Arc::new(Mutex::new(f.db));
    assert!(authorize_invocation(&catalog, &context, &call).is_ok());
    let (bridge, frames) = owner();
    let mut forged = call;
    forged.arguments["attachments"] = json!([{"path":"unselected-secret.csv"}]);
    let failure = prepare(
        Some(&bridge),
        &catalog,
        &context,
        &forged,
        "child",
        "branch",
        &f.input.attachments,
        &CancellationToken::default(),
    )
    .err()
    .unwrap();
    assert!(failure.message.contains("original invocation"));
    assert!(
        frames.try_recv().is_err(),
        "forged invocation must not contact a file owner"
    );
}

#[test]
fn native_images_read_exact_chunks_and_preserve_real_provenance() {
    let (bridge, frames) = owner();
    let file = attachment("attachment:image", "image/png", 6);
    let generic = attachment("attachment:data", "application/octet-stream", 900_000);
    let svg = attachment("attachment:vector", "image/svg+xml", 900_000);
    let mut delivery = prepared(
        bridge.clone(),
        vec![generic.clone(), svg.clone(), file.clone()],
    );
    let original = file.clone();
    let worker = std::thread::spawn(move || {
        for (offset, bytes, eof) in [(0, b"abc".as_slice(), false), (3, b"def".as_slice(), true)] {
            let request = frames.recv().unwrap();
            assert_eq!(
                request["query"]["resourceCheckpointId"],
                "original-checkpoint"
            );
            assert_eq!(
                request["query"]["request"],
                json!({"kind":"attachment","ref":"attachment:image","view":"bytes","offset":offset,"limit":262144})
            );
            reply(
                &bridge,
                &request,
                json!({"status":"ready","attachment":original,"bytesBase64":STANDARD.encode(bytes),
                "offset":offset,"nextOffset":offset+bytes.len(),"eof":eof}),
            );
        }
    });
    delivery
        .hydrate_images(&context(), &CancellationToken::default())
        .unwrap();
    worker.join().unwrap();
    assert_eq!(delivery.attachments, vec![generic, svg, file]);
    assert_eq!(delivery.media.len(), 1);
    assert_eq!(
        STANDARD.decode(&delivery.media[0].data_base64).unwrap(),
        b"abcdef"
    );
    assert_eq!(
        delivery.media[0].source,
        OutputSource::Tool { context: context() }
    );
}

#[test]
fn image_read_cancellation_waits_for_original_reader_and_never_accepts_partial_bytes() {
    let (bridge, frames) = owner();
    let file = attachment("attachment:image", "image/png", 6);
    let mut delivery = prepared(bridge.clone(), vec![file]);
    let cancel = CancellationToken::default();
    let owner_cancel = cancel.clone();
    let worker = std::thread::spawn(move || {
        let request = frames.recv().unwrap();
        owner_cancel.cancel();
        let cancelled = frames.recv().unwrap();
        assert_eq!(cancelled["kind"], "resource-cancel");
        assert_eq!(cancelled["id"], request["id"]);
        reply(
            &bridge,
            &request,
            json!({"status":"failed","error":{"code":"original_reader_stopped","message":"cancelled after the reader stopped"}}),
        );
    });
    let failure = delivery.hydrate_images(&context(), &cancel).unwrap_err();
    worker.join().unwrap();
    assert_eq!(failure.code, "original_reader_stopped");
    assert!(delivery.media.is_empty());
}

#[test]
fn failed_unpublished_delivery_releases_only_its_original_target_relation() {
    let root =
        std::env::temp_dir().join(format!("varin-attachment-cleanup-{}", uuid::Uuid::new_v4()));
    let catalog = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
    let (bridge, frames) = owner();
    let delivery = prepared(
        bridge.clone(),
        vec![attachment("attachment:original", "text/plain", 4)],
    );
    let owner_catalog = catalog.clone();
    let worker = std::thread::spawn(move || {
        let request = frames.recv().unwrap();
        assert!(
            owner_catalog.try_lock().is_ok(),
            "resource I/O must not hold the Catalog control lock"
        );
        assert_eq!(
            request["query"]["request"],
            json!({"kind":"attachment_release","operationId":context().operation_id,
            "targetThreadId":"recipient","targetBranchId":"recipient-branch"})
        );
        reply(&bridge, &request, json!({"status":"released"}));
    });
    let mut failure = error("cancelled before acceptance");
    delivery.release_failed(&catalog, &mut failure);
    worker.join().unwrap();
    assert!(failure.details.is_none());
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn typed_source_selection_requires_the_exact_prepared_material_identity() {
    let reference = "varin-material://snap-original?startLine=3&endLine=5";
    let canonical = varin_runtime::catalog::attachments::material_attachment_reference(reference).unwrap();
    let selected = vec![AttachmentSelection::Ref { reference: reference.into() }];
    assert!(prepared_response(json!({"status":"ready","attachments":[attachment(&canonical,"text/plain",4)]}), &context(), &selected).is_ok());
    assert!(prepared_response(json!({"status":"ready","attachments":[attachment("attachment:other","text/plain",4)]}), &context(), &selected).is_err());
}
