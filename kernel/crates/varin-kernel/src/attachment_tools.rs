//! Attachment preparation belongs to the original resource owner, outside Catalog's lock.
//! The frozen invocation supplies the Source and caller; model arguments only select files.
use crate::host_query::OwnerChannel;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use varin_runtime::Catalog;
use varin_runtime::catalog::attachments::{Attachment, AttachmentSelection};
use varin_runtime::catalog::tool_content::ToolInvocationSnapshot;
use varin_runtime::execution::{CancellationToken, ExecutionError, ToolCall, ToolExecutionContext};
use varin_runtime::output::{OutputSource, ResolvedMedia};

fn error(message: impl ToString) -> ExecutionError {
    ExecutionError::new("attachment_preparation", message.to_string())
}

pub(crate) fn selector_schema() -> Value {
    json!({"type":"array","description":"Files to deliver as fixed versions. Choose an existing attachment reference or a path in your current Source; the recipient's project does not resolve these paths.","items":{"oneOf":[
        {"type":"object","properties":{"ref":{"type":"string","minLength":1}},"required":["ref"],"additionalProperties":false},
        {"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}
    ]}})
}

/// Verify the actual original call before asking a resource owner to read any bytes.
pub(crate) fn authorize_invocation(
    catalog: &Arc<Mutex<Catalog>>,
    context: &ToolExecutionContext,
    call: &ToolCall,
) -> Result<ToolInvocationSnapshot, ExecutionError> {
    original_invocation(catalog, context, call, true)
}
pub(crate) fn original_invocation(
    catalog: &Arc<Mutex<Catalog>>,
    context: &ToolExecutionContext,
    call: &ToolCall,
    live: bool,
) -> Result<ToolInvocationSnapshot, ExecutionError> {
    let read = catalog
        .lock()
        .map_err(error)?
        .capture_tool_invocation(context, &call.call_id)
        .map_err(error)?;
    let invocation = read.load().map_err(error)?;
    if invocation.context != *context || invocation.call != *call {
        return Err(error(
            "attachment sender differs from its original invocation",
        ));
    }
    let schema = if call.name == "send" {
        Some(crate::message_tools::schema())
    } else {
        crate::collaboration::schemas(Vec::new())
            .into_iter()
            .chain(crate::family_tools::schemas())
            .find(|schema| schema.name == call.name)
    }
    .ok_or_else(|| error("attachment capability is not selected"))?;
    // The frozen declaration is authoritative for already admitted calls. New
    // descriptions or reference inputs must not invalidate their original proof.
    if !invocation.tools.iter().any(|selected| {
        selected.name == schema.name && selected.version == call.schema_version
    }) {
        return Err(error(
            "attachment capability differs from its original frozen schema",
        ));
    }
    catalog
        .lock()
        .map_err(error)?
        .validate_tool_invocation(&invocation, live)
        .map_err(error)?;
    Ok(invocation)
}

/// A history/report read already selected and authorized these exact typed parts. The
/// resource owner still proves the original source can read each file before sharing it.
/// A denied file remains visible as metadata, with explicit unreadable status.
pub(crate) fn report_access(
    bridge: Option<&OwnerChannel>,
    catalog: &Arc<Mutex<Catalog>>,
    context: &ToolExecutionContext,
    call: &ToolCall,
    source: Option<(&str, &str)>,
    attachments: &[Attachment],
    cancel: &CancellationToken,
) -> Result<Vec<Value>, ExecutionError> {
    let mut refs = Vec::new();
    for attachment in attachments {
        attachment.validate().map_err(error)?;
        if !refs.contains(&attachment.reference) {
            refs.push(attachment.reference.clone());
        }
    }
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    // Policy reads have no synthetic effect Operation. Validate their original graph
    // call plus current resource owner, rather than requiring an effect admission row.
    let invocation = original_invocation(catalog, context, call, false)?;
    let epoch = catalog.lock().map_err(error)?.epoch();
    let validate = || -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("attachment history read cancelled"));
        }
        catalog
            .lock()
            .map_err(error)?
            .validate_resource_snapshot_owner(&context.run_id, epoch, &context.origin)
            .map_err(error)
    };
    validate()?;
    let unreadable = |reason: &str| {
        refs.iter()
            .map(|reference| json!({"ref":reference,"status":"unreadable","reason":reason}))
            .collect()
    };
    let Some(bridge) = bridge else {
        return Ok(unreadable("Attachment resource owner is unavailable"));
    };
    let Some(checkpoint) = invocation.frozen.resource_checkpoint_id.as_deref() else {
        return Ok(unreadable(
            "Attachment reader has no original resource checkpoint",
        ));
    };
    let mut request = json!({"kind":"attachment_report","refs":refs});
    if let Some((thread, branch)) = source {
        request["sourceThreadId"] = json!(thread);
        request["sourceBranchId"] = json!(branch);
    }
    let response = bridge.query_draining(
        json!({"runId":context.run_id,"origin":context.origin,
        "callId":call.call_id,"resourceCheckpointId":checkpoint,"request":request}),
        cancel,
    );
    validate()?;
    let response = match response {
        Ok(response) => response,
        Err(failure) => return Ok(unreadable(&failure.message)),
    };
    if response["status"] != "ready" {
        return Ok(unreadable(&owner_failure(&response).message));
    }
    let Some(access) = response["attachmentAccess"].as_array() else {
        return Ok(unreadable(
            "Attachment owner did not confirm file readability",
        ));
    };
    Ok(refs.iter().map(|reference| {
        let matched:Vec<_> = access.iter().filter(|item| item["ref"] == *reference).collect();
        match matched.as_slice() {
            [item] if matches!(item["status"].as_str(), Some("ready" | "unreadable")) => (*item).clone(),
            _ => json!({"ref":reference,"status":"unreadable","reason":"Attachment owner did not confirm this file's readability"}),
        }
    }).collect())
}

#[derive(Default)]
pub(crate) struct PreparedAttachments {
    pub attachments: Vec<Attachment>,
    pub media: Vec<ResolvedMedia>,
    query: Option<Value>,
    bridge: Option<OwnerChannel>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    status: String,
    attachments: Vec<Attachment>,
}

fn prepared_response(
    value: Value,
    _context: &ToolExecutionContext,
    selections: &[AttachmentSelection],
) -> Result<PreparedAttachments, ExecutionError> {
    if value["status"] != "ready" {
        return Err(owner_failure(&value));
    }
    let ready: Ready = serde_json::from_value(value).map_err(error)?;
    if ready.status != "ready" || ready.attachments.len() != selections.len() {
        return Err(error(
            "every selected attachment must be ready before delivery",
        ));
    }
    for (index, (selection, attachment)) in selections.iter().zip(&ready.attachments).enumerate() {
        attachment
            .validate()
            .map_err(error)
            .map_err(|failure| failure.with_details(json!({"attachmentIndex":index})))?;
        if let AttachmentSelection::Ref { reference } = selection {
            let expected = varin_runtime::catalog::attachments::material_attachment_reference(reference);
            if !reference.starts_with("file:") && expected.as_ref().unwrap_or(reference) != &attachment.reference {
                return Err(
                    error("attachment owner changed the selected fixed reference")
                        .with_details(json!({"attachmentIndex":index,"ref":reference})),
                );
            }
        }
    }
    Ok(PreparedAttachments {
        attachments: ready.attachments,
        ..PreparedAttachments::default()
    })
}

pub(crate) fn prepare(
    bridge: Option<&OwnerChannel>,
    catalog: &Arc<Mutex<Catalog>>,
    context: &ToolExecutionContext,
    call: &ToolCall,
    target_thread_id: &str,
    target_branch_id: &str,
    selections: &[AttachmentSelection],
    cancel: &CancellationToken,
) -> Result<PreparedAttachments, ExecutionError> {
    if selections.is_empty() {
        return Ok(PreparedAttachments::default());
    }
    for selection in selections {
        selection.validate().map_err(error)?;
    }
    let invocation = authorize_invocation(catalog, context, call)?;
    // Resolve only declared attachment selectors, retaining the original call.
    // File observations stay typed until their byte owner captures that version.
    let selections = {
        let owner = catalog.lock().map_err(error)?;
        selections.iter().map(|selection| -> Result<AttachmentSelection,ExecutionError> {
            if let AttachmentSelection::Ref {reference} = selection {
                if reference.starts_with("file:") {
                    let target:crate::resource_references::FileTarget=crate::resource_references::resolve(&owner,varin_runtime::catalog::model_references::ReferenceKind::File,reference)?;
                    if let crate::resource_references::FileTarget::Attachment {reference}=target {return Ok(AttachmentSelection::Ref {reference});}
                }
            }
            Ok(selection.clone())
        }).collect::<Result<Vec<_>,_>>()?
    };
    let checkpoint = invocation
        .frozen
        .resource_checkpoint_id
        .as_deref()
        .ok_or_else(|| error("attachment sender has no frozen resource checkpoint"))?;
    let bridge = bridge.ok_or_else(|| error("attachment resource owner is unavailable"))?;
    let query = json!({
        "runId":context.run_id,"origin":context.origin,"callId":call.call_id,
        "resourceCheckpointId":checkpoint,
        "request":{"kind":"attachment_prepare","operationId":context.operation_id,
            "targetThreadId":target_thread_id,"targetBranchId":target_branch_id,"attachments":selections}
    });
    let guard = PreparedAttachments {
        query: Some(query.clone()),
        bridge: Some(bridge.clone()),
        ..PreparedAttachments::default()
    };
    // A lost transport reply is uncertainty, not proof that the owner stopped.
    let response = bridge.query_draining(query, cancel)?;
    let completed = matches!(
        response["status"].as_str(),
        Some("ready" | "failed" | "missing" | "denied" | "invalid" | "cancelled" | "stale")
    );
    let mut prepared =
        prepared_response(response, context, &selections).map_err(|mut failure| {
            // The owner may have fixed earlier files before a later selected file failed.
            // Release that original preparation, but retain uncertain/unavailable work.
            if completed {
                guard.release_failed(catalog, &mut failure);
            }
            failure
        })?;
    catalog.lock().map_err(error)?.project_attachments(&mut prepared.attachments, &context.run_id).map_err(error)?;
    prepared.query = guard.query;
    prepared.bridge = guard.bridge;
    Ok(prepared)
}

impl PreparedAttachments {
    /// Only native image projection requests bytes; ordinary files remain lazy references.
    pub(crate) fn hydrate_images(
        &mut self,
        context: &ToolExecutionContext,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        let Some(bridge) = &self.bridge else {
            return Ok(());
        };
        for (index, attachment) in self.attachments.iter().enumerate() {
            if !attachment.is_direct_image() {
                continue;
            }
            let mut bytes = Vec::new();
            let mut offset = 0u64;
            loop {
                let mut query = self.query.as_ref().expect("prepared owner query").clone();
                query["request"] = json!({"kind":"attachment","ref":attachment.reference,
                    "view":"bytes","offset":offset,"limit":262144});
                let response = bridge.query_draining(query, cancel)?;
                if response["status"] != "ready" {
                    let mut failure = owner_failure(&response);
                    let details = failure.details.get_or_insert_with(|| json!({}));
                    if !details.is_object() {
                        *details = json!({"detail":details.clone()});
                    }
                    details["attachmentIndex"] = json!(index);
                    details["ref"] = json!(attachment.reference);
                    details["stage"] = json!("image_read");
                    return Err(failure);
                }
                let returned: Attachment =
                    serde_json::from_value(response["attachment"].clone()).map_err(error)?;
                if !returned.same_resource(attachment) || response["offset"].as_u64() != Some(offset) {
                    return Err(error(
                        "attachment image read changed its fixed version or offset",
                    ));
                }
                let chunk = STANDARD
                    .decode(
                        response["bytesBase64"]
                            .as_str()
                            .ok_or_else(|| error("attachment image bytes are missing"))?,
                    )
                    .map_err(error)?;
                let end = offset
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| error("attachment image offset overflow"))?;
                if end > attachment.byte_length {
                    return Err(error("attachment image exceeds its fixed byte length"));
                }
                bytes.extend_from_slice(&chunk);
                if response["eof"] == true {
                    if end != attachment.byte_length {
                        return Err(error("attachment image ended before its fixed byte length"));
                    }
                    break;
                }
                if end == offset || response["nextOffset"].as_u64() != Some(end) {
                    return Err(error(
                        "attachment image read did not advance to the next byte",
                    ));
                }
                offset = end;
            }
            self.media.push(ResolvedMedia {
                media_type: attachment.mime_type.clone(),
                source: OutputSource::Tool {
                    context: context.clone(),
                },
                data_base64: STANDARD.encode(bytes),
            });
        }
        Ok(())
    }

    /// Release only this unpublished operation's temporary relation, never accepted delivery.
    /// Keep a cleanup failure visible: cancellation intent is not evidence of owner completion.
    pub(crate) fn release_failed(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        failure: &mut ExecutionError,
    ) {
        let (Some(bridge), Some(original)) = (&self.bridge, &self.query) else {
            return;
        };
        let operation = original["request"]["operationId"]
            .as_str()
            .expect("original operation");
        let published = (|| -> Result<bool, ExecutionError> {
            let catalog = catalog.lock().map_err(error)?;
            if catalog
                .attachment_delivery("input", &format!("message:{operation}"))
                .map_err(error)?
                .is_some()
                || catalog.external_child(operation).map_err(error)?.is_some()
            {
                return Ok(true);
            }
            match catalog.child_task(operation) {
                Ok(_) => Ok(true),
                Err(varin_runtime::RuntimeError::NotFound(_)) => Ok(false),
                Err(failure) => Err(error(failure)),
            }
        })();
        match published {
            Ok(true) => return,
            Err(check) => {
                let details = failure.details.get_or_insert_with(|| json!({}));
                if !details.is_object() {
                    *details = json!({"detail":details.clone()});
                }
                details["attachmentCleanup"] =
                    json!({"state":"pending","code":check.code,"message":check.message});
                return;
            }
            Ok(false) => (),
        }
        let mut query = original.clone();
        query["request"]["kind"] = json!("attachment_release");
        query["request"]
            .as_object_mut()
            .expect("owner request")
            .remove("attachments");
        let cleanup = bridge
            .query_draining(query, &CancellationToken::default())
            .and_then(|response| {
                if matches!(response["status"].as_str(), Some("ready" | "released")) {
                    Ok(())
                } else {
                    Err(owner_failure(&response))
                }
            });
        if let Err(cleanup) = cleanup {
            let details = failure.details.get_or_insert_with(|| json!({}));
            if !details.is_object() {
                *details = json!({"detail":details.clone()});
            }
            details["attachmentCleanup"] =
                json!({"state":"pending","code":cleanup.code,"message":cleanup.message});
        }
    }
}
fn owner_failure(value: &Value) -> ExecutionError {
    if let Some(failure) = value
        .get("error")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
    {
        return failure;
    }
    ExecutionError::new(
        value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("attachment_preparation"),
        value
            .get("reason")
            .or_else(|| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("attachment resource owner failed"),
    )
    .with_details(json!({"status":value.get("status"),"path":value.get("path")}))
}

#[cfg(test)]
#[path = "attachment_tools_review.rs"]
mod review;
