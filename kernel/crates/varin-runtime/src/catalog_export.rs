//! Selected public history exports retain typed reference associations, not a Catalog dump.
use super::*;
use crate::execution::{Content, ConversationItem, ToolCompletion, ToolOrigin};
use crate::output::{OutputBody, OutputPart, StoredMedia};
use model_references::{ExecutionReference, ModelReference, ReferenceKind};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportModelBinding {
    pub item_id: String,
    pub operation_id: String,
    pub purpose: String,
    pub original: Value,
    pub target: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelReferenceExport {
    pub space_id: String,
    pub references: Vec<ModelReference>,
    pub executions: Vec<ExecutionReference>,
    pub bindings: Vec<ExportModelBinding>,
}
pub struct ModelReferenceExportRead {
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
    epoch: u64,
    thread: String,
    branch: String,
    head: Option<String>,
    items: Vec<String>,
    include_tools: bool,
}
impl Catalog {
    pub fn capture_export_model_references(
        &self,
        thread: &str,
        branch: &str,
        head: Option<&str>,
        items: &[String],
        include_tools: bool,
    ) -> Result<ModelReferenceExportRead> {
        threads::require_branch_available(&self.db, branch)?;
        let actual: String = self.db.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |r| r.get(0),
        )?;
        if actual != thread {
            return Err(RuntimeError::Invalid(
                "Export branch belongs to another conversation".into(),
            ));
        }
        if let Some(head) = head {
            context_jobs::require_ancestor(&self.db, branch, head)?;
        } else if !items.is_empty() {
            return Err(RuntimeError::Invalid(
                "Selected export items need their original history cut".into(),
            ));
        }
        Ok(ModelReferenceExportRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
            epoch: self.epoch,
            thread: thread.into(),
            branch: branch.into(),
            head: head.map(str::to_owned),
            items: items.to_vec(),
            include_tools,
        })
    }
}
// These are named semantic positions in owner-authored projections and tool reference
// arguments. We never inspect data, text, instructions, code, URLs, arbitrary nested JSON
// or provider fields. Opaque extension results stay opaque unless they use this contract.
fn projected_refs(value: &Value, output: &mut BTreeSet<String>) {
    const FIELDS: &[&str] = &[
        "ref",
        "operationRef",
        "executionRef",
        "messageId",
        "itemId",
        "fileRef",
        "attachmentRef",
        "processId",
        "operationId",
        "environmentId",
        "followupId",
        "occurrenceId",
        "jobId",
        "pageId",
        "observationId",
        "revisionRef",
        "settingsRef",
        "materialId",
        "snapshotId",
        "sourceSnapshotId",
        "collectionId",
        "target",
        "sourceAgent",
    ];
    const CONTAINERS: &[&str] = &[
        "read",
        "nextRead",
        "wait",
        "status",
        "cancel",
        "arguments",
        "items",
        "entries",
        "files",
        "attachments",
        "messages",
        "reports",
        "actions",
        "activeActions",
        "executions",
        "tasks",
        "threads",
        "followup",
        "followups",
        "occurrence",
        "occurrences",
        "jobs",
        "members",
        "collections",
        "snapshot",
        "member",
        "page",
        "observation",
        "trigger",
        "registrationTrigger",
        "sources",
        "evidence",
    ];
    match value {
        Value::Array(values) => {
            for value in values {
                projected_refs(value, output);
            }
        }
        Value::Object(fields) => {
            for key in FIELDS {
                if let Some(Value::String(reference)) = fields.get(*key) {
                    output.insert(reference.clone());
                }
            }
            for key in CONTAINERS {
                if let Some(value) = fields.get(*key) {
                    projected_refs(value, output);
                }
            }
        }
        _ => (),
    }
}
fn call_refs(name: &str, arguments: &Value, refs: &mut BTreeSet<String>) {
    // Native schemas declare these fields. A third-party tool with a field named
    // `ref` does not acquire reference semantics merely through its spelling.
    match name {
        "tool_invoke" => {
            if let (Some(name), Some(arguments)) =
                (arguments["name"].as_str(), arguments.get("arguments"))
            {
                call_refs(name, arguments, refs)
            }
        }
        "threads" | "read_thread" | "child_status" | "child_report" | "wait_child"
        | "child_cancel" | "send" | "message_queue" | "dispatch" | "file_read" | "file_write"
        | "file_edit" | "resource_read" | "directory_list" | "file_search" | "process_read"
        | "process_write" | "process_inspect" | "process_stop" | "wait_process" | "script_run"
        | "script_close" | "followup" | "code_retrieval" | "retrieval_control" => {
            projected_refs(arguments, refs)
        }
        _ => (),
    }
}
fn output_refs(output: &OutputBody<StoredMedia>, include_tools: bool, refs: &mut BTreeSet<String>) {
    if include_tools {
        if let Some(value) = &output.model_data {
            projected_refs(value, refs);
        }
    }
    for part in &output.parts {
        if let OutputPart::Attachment { attachment } = part {
            if let Some(reference) = &attachment.model_ref {
                refs.insert(reference.clone());
            }
        }
    }
}
impl ModelReferenceExportRead {
    pub fn load(self) -> Result<ModelReferenceExport> {
        let db = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.execute_batch("BEGIN")?;
        let epoch: u64 = db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |r| {
            read_number(r, 0)
        })?;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "Export belongs to a previous Catalog owner".into(),
            ));
        }
        threads::require_branch_available(&db, &self.branch)?;
        let actual: String = db.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [&self.branch],
            |r| r.get(0),
        )?;
        if actual != self.thread {
            return Err(RuntimeError::Conflict("Export conversation changed".into()));
        }
        if let Some(head) = &self.head {
            context_jobs::require_ancestor(&db, &self.branch, head)?;
        }
        let space_id: String = db.query_row(
            "SELECT space_id FROM model_reference_space WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let mut refs = BTreeSet::new();
        let mut bindings = Vec::new();
        let mut executions = BTreeMap::new();
        for id in self.items.iter().collect::<BTreeSet<_>>() {
            let visible:bool=db.query_row("WITH RECURSIVE selected(id,parent) AS (SELECT id,parent FROM history WHERE id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN selected s ON h.id=s.parent) SELECT EXISTS(SELECT 1 FROM selected WHERE id=?2)",params![self.head,id],|r|r.get(0))?;
            if !visible {
                return Err(RuntimeError::Invalid(
                    "Export item is outside the selected history cut".into(),
                ));
            }
            let item: HistoryItem = record(&db, "history", id)?;
            if item.source == HistorySource::Compaction
                || !self.include_tools && item.source == HistorySource::Tool
            {
                continue;
            }
            let (body, _) = self
                .content
                .load_stored_history_payload(&item.content, &|| false)?;
            let mut call_id = None;
            let mut request_id = None;
            if item.source == HistorySource::User {
                for value in body["fileAttachments"].as_array().into_iter().flatten() {
                    let attachment: attachments::Attachment =
                        serde_json::from_value(value.clone())?;
                    if let Some(reference) = attachment.model_ref {
                        refs.insert(reference);
                    }
                }
            } else if let Ok(conversation) =
                serde_json::from_value::<ConversationItem<StoredMedia>>(body)
            {
                match conversation.content {
                    Content::Output { output } => {
                        output_refs(&output, self.include_tools, &mut refs)
                    }
                    Content::ToolCall { call } if self.include_tools => {
                        call_refs(&call.name, &call.arguments, &mut refs);
                        call_id = Some(call.call_id);
                    }
                    Content::ToolResult { result } if self.include_tools => {
                        call_id = Some(result.call_id);
                        request_id = Some(result.request_id);
                        match result.completion {
                            ToolCompletion::Result { content, .. }
                            | ToolCompletion::JobAccepted {
                                content: Some(content),
                                ..
                            } => output_refs(&content, true, &mut refs),
                            _ => (),
                        }
                    }
                    _ => (),
                }
            }
            if let Ok(execution) = model_references::execution_reference(&db, &item.run_id) {
                executions.insert(execution.reference.clone(), execution);
            }
            if let Some(call_id) = call_id {
                let mut query=db.prepare("SELECT body FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.call.call_id')=?2")?;
                for row in
                    query.query_map(params![item.run_id, call_id], |r| r.get::<_, String>(0))?
                {
                    let operation: Operation = serde_json::from_str(&row?)?;
                    let intent = tool_content::ToolIntent::from_operation(&operation)?;
                    let exact = match intent.origin() {
                        ToolOrigin::ModelStep {
                            request_id: request,
                        } => request_id.as_ref().map_or_else(
                            || {
                                item.id
                                    .starts_with(&crate::execution::model_history_id(request, ""))
                            },
                            |id| id == request,
                        ),
                        ToolOrigin::Driver { invocation_id } => {
                            request_id.as_ref() == Some(invocation_id)
                        }
                        _ => false,
                    };
                    if !exact {
                        continue;
                    }
                    let mut bound=db.prepare("SELECT purpose,original,target FROM model_bound_targets WHERE operation_id=?1 AND purpose!='tool_result_projection' ORDER BY purpose")?;
                    for row in bound.query_map([&operation.id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })? {
                        let (purpose, original, target) = row?;
                        bindings.push(ExportModelBinding {
                            item_id: item.id.clone(),
                            operation_id: operation.id.clone(),
                            purpose,
                            original: serde_json::from_str(&original)?,
                            target: serde_json::from_str(&target)?,
                        });
                    }
                }
            }
        }
        let mut references = Vec::new();
        for reference in refs {
            let Some((prefix, number)) = reference.split_once(':') else {
                if reference.contains('/') {
                    if let Ok(execution) =
                        model_references::resolve_execution_reference(&db, &reference)
                    {
                        executions.insert(execution.reference.clone(), execution);
                    }
                }
                continue;
            };
            let (Some(kind), Ok(number)) =
                (ReferenceKind::from_prefix(prefix), number.parse::<u64>())
            else {
                continue;
            };
            if number == 0 {
                continue;
            }
            let row: Option<(String, String)> = db
                .query_row(
                    "SELECT owner,target FROM model_references WHERE id=?1 AND kind=?2",
                    params![sql_number(number)?, prefix],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((owner, target)) = row {
                references.push(ModelReference {
                    reference,
                    space_id: space_id.clone(),
                    kind,
                    owner,
                    target: serde_json::from_str(&target)?,
                });
            }
        }
        Ok(ModelReferenceExport {
            space_id,
            references,
            executions: executions.into_values().collect(),
            bindings,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::Provenance;
    use crate::test_submission::InputAdmission;
    #[test]
    fn selected_export_retains_only_typed_public_associations() {
        let root = std::env::temp_dir().join(format!("varin-export-{}", id()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("export-thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "export-thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"export"}),
                configuration: json!({}),
            })
            .unwrap();
        let visible = db
            .register_model_reference(
                ReferenceKind::File,
                "selected-owner",
                &json!({"path":"selected.txt","readVersion":"old"}),
                &receipt.run_id,
            )
            .unwrap();
        let hidden = db
            .register_model_reference(
                ReferenceKind::File,
                "hidden-owner",
                &json!({"path":"secret.txt"}),
                &receipt.run_id,
            )
            .unwrap();
        let body: ConversationItem<crate::output::ResolvedMedia> = ConversationItem {
            id: "visible".into(),
            resource_activation: None,
            provenance: Provenance::Assistant,
            opaque: None,
            content: Content::Output {
                output: OutputBody {
                    data: json!({"original":"selected.txt","untyped":{"ref":hidden}}),
                    model_data: Some(json!({"ref":visible,"text":hidden,"untyped":{"ref":hidden}})),
                    parts: vec![OutputPart::Text {
                        text: format!("A quoted literal {hidden} is not a resource grant."),
                    }],
                },
            },
        };
        let selected = db
            .append_history(
                &receipt.run_id,
                db.epoch(),
                Some(&receipt.input_id),
                HistorySource::Assistant,
                serde_json::to_value(body).unwrap(),
                None,
            )
            .unwrap();
        let selected_id = selected.id.clone();
        let space = db.model_reference_space().unwrap();
        let read = db
            .capture_export_model_references(
                "export-thread",
                "main",
                Some(&selected_id),
                &[selected_id.clone()],
                true,
            )
            .unwrap();
        let snapshot = read.load().unwrap();
        assert_eq!(snapshot.space_id, space);
        assert_eq!(snapshot.references.len(), 1);
        assert_eq!(snapshot.references[0].reference, visible);
        assert_eq!(snapshot.references[0].target["readVersion"], "old");
        let without_tools = db
            .capture_export_model_references(
                "export-thread",
                "main",
                Some(&selected_id),
                &[selected_id.clone()],
                false,
            )
            .unwrap()
            .load()
            .unwrap();
        assert!(without_tools.references.is_empty());
        let outside = db
            .capture_export_model_references(
                "export-thread",
                "main",
                Some(&receipt.input_id),
                &[selected_id.clone()],
                true,
            )
            .unwrap();
        assert!(outside.load().is_err());
        let before = serde_json::to_value(snapshot).unwrap();
        drop(db);
        let db = Catalog::open(&root).unwrap();
        let reopened = db
            .capture_export_model_references(
                "export-thread",
                "main",
                Some(&selected_id),
                &[selected_id.clone()],
                true,
            )
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(serde_json::to_value(reopened).unwrap(), before);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
