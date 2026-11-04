//! Material ownership follows the original task family and frozen dispatch background.
//! Bodies are read outside the Catalog lock; Storage remains the material record owner.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialThreadRetention {
    pub thread_id: String,
    pub root_thread_id: String,
    pub release: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialInheritance {
    pub parent_thread_id: String,
    pub child_thread_id: String,
    pub root_thread_id: String,
    pub snapshot_ids: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSourceRetirement {
    pub thread_id: String,
    pub run_id: String,
    pub epoch: u64,
    pub source: launches::SourceSelection,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreparationRetirement {
    pub thread_id: String,
    pub run_id: String,
    pub epoch: u64,
    pub source: launches::SourceSelection,
    pub operation_id: String,
    pub attachments: Vec<AttachmentPathRetirement>,
}
#[derive(Debug, Serialize)]
pub struct AttachmentPathRetirement {
    #[serde(rename = "ref")]
    pub reference: String,
    pub path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRetention {
    /// Global retention hints, not authority. Populated only for full maintenance
    /// reads explicitly requesting them; omitted scans return None, never an empty set.
    pub ui_references: Option<Vec<String>>,
    pub attachment_preparations: Vec<AttachmentPreparationRetirement>,
    pub attachment_sources: Vec<AttachmentSourceRetirement>,
    pub attachments: Vec<super::attachments::AttachmentDelivery>,
    pub threads: Vec<MaterialThreadRetention>,
    pub inheritances: Vec<MaterialInheritance>,
    pub sources: Vec<source_retention::SourceRetirement>,
}
pub struct MaterialRetentionRead {
    ui_retention: Option<crate::content::collection::UiRetentionRead>,
    preparations: Vec<(String, u64, super::tool_content::ToolInvocationRead)>,
    attachment_sources: Vec<AttachmentSourceRetirement>,
    attachments: Vec<super::attachments::AttachmentDelivery>,
    threads: Vec<MaterialThreadRetention>,
    sources: Vec<source_retention::SourceRetirement>,
    children: Vec<(delegated::ChildRelation, String)>,
    reports: Vec<(
        super::attachments::AttachmentDelivery,
        collaboration::ChildReport,
        Vec<HistoryItem>,
    )>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl MaterialRetentionRead {
    pub fn load(self) -> Result<MaterialRetention> {
        let mut inheritances = Vec::new();
        let mut attachments = self.attachments;
        for (child, root_thread_id) in self.children {
            if !child.material_snapshot_ids.is_empty() {
                inheritances.push(MaterialInheritance {
                    parent_thread_id: child.parent_thread_id.clone(),
                    child_thread_id: child.child_thread_id.clone(),
                    root_thread_id,
                    snapshot_ids: child.material_snapshot_ids,
                });
            }
            let Some(context) = child.inherited_context else {
                continue;
            };
            let history: Vec<crate::execution::ConversationItem<crate::output::StoredMedia>> =
                serde_json::from_value(self.content.load(&context.items)?)?;
            let mut files = Vec::new();
            for item in history {
                let output = match item.content {
                    crate::execution::Content::Output { output } => Some(output),
                    crate::execution::Content::ToolResult { result } => match result.completion {
                        crate::execution::ToolCompletion::Result { content, .. } => Some(content),
                        crate::execution::ToolCompletion::JobAccepted { content, .. } => content,
                        _ => None,
                    },
                    _ => None,
                };
                if let Some(output) = output {
                    for part in output.parts {
                        if let crate::output::OutputPart::Attachment { attachment } = part {
                            if !files.iter().any(|file: &super::attachments::Attachment| {
                                file.reference == attachment.reference
                            }) {
                                files.push(attachment);
                            }
                        }
                    }
                }
            }
            if !files.is_empty() {
                attachments.push(super::attachments::AttachmentDelivery {
                    source_thread_id: Some(child.parent_thread_id),
                    source_branch_id: Some(child.parent_branch_id),
                    holder_kind: "context".into(),
                    holder_id: child.operation_id,
                    thread_id: child.child_thread_id,
                    branch_id: child.child_branch_id,
                    attachments: files,
                    input_ref: None,
                });
            }
        }
        for (mut edge, report, history) in self.reports {
            for item in history {
                let (body, _) = self
                    .content
                    .load_stored_history_payload(&item.content, &|| false)?;
                let message: crate::execution::ConversationItem<crate::output::StoredMedia> =
                    serde_json::from_value(body)?;
                match message.content {
                    crate::execution::Content::ToolCall { .. } => break,
                    crate::execution::Content::Output { output }
                        if report.history_ids.contains(&item.id) =>
                    {
                        for part in output.parts {
                            if let crate::output::OutputPart::Attachment { attachment } = part {
                                // Explicit sends already own their original recipient relation.
                                if !report
                                    .attachments
                                    .iter()
                                    .chain(&edge.attachments)
                                    .any(|file| file.reference == attachment.reference)
                                {
                                    edge.attachments.push(attachment);
                                }
                            }
                        }
                    }
                    _ => (),
                }
            }
            if !edge.attachments.is_empty() {
                attachments.push(edge);
            }
        }
        let retained: std::collections::BTreeSet<_> = attachments
            .iter()
            .flat_map(|edge| edge.attachments.iter().map(|file| file.reference.as_str()))
            .collect();
        let mut attachment_preparations = Vec::new();
        for (thread_id, epoch, read) in self.preparations {
            // Argument bodies and the original policy/model checkpoint are loaded
            // outside the Catalog lock, exactly like normal tool preparation.
            let invocation = read.load()?;
            let Some(source) = invocation
                .frozen
                .source
                .filter(|source| !source.resource_owner.is_local())
            else {
                continue;
            };
            let Some(arguments) = invocation.call.arguments.get("attachments") else {
                continue;
            };
            // Invalid selections fail as a whole before any owner capture. Such
            // a failed call must not block unrelated material maintenance.
            let Ok(selections) = serde_json::from_value::<
                Vec<super::attachments::AttachmentSelection>,
            >(arguments.clone()) else {
                continue;
            };
            if selections
                .iter()
                .any(|selection| selection.validate().is_err())
            {
                continue;
            }
            let mut selected = Vec::new();
            for (index, selection) in selections.into_iter().enumerate() {
                let super::attachments::AttachmentSelection::Path { path } = selection else {
                    continue;
                };
                let identity = serde_json::to_vec(&json!([
                    thread_id,
                    invocation.context.operation_id,
                    index
                ]))?;
                let reference = format!("attachment:{}", hex::encode(Sha256::digest(identity)));
                if !retained.contains(reference.as_str()) {
                    selected.push(AttachmentPathRetirement { reference, path });
                }
            }
            if !selected.is_empty() {
                attachment_preparations.push(AttachmentPreparationRetirement {
                    thread_id,
                    run_id: invocation.context.run_id,
                    epoch,
                    source,
                    operation_id: invocation.context.operation_id,
                    attachments: selected,
                });
            }
        }
        let ui_references = self.ui_retention.map(|read| read.load(&self.content)).transpose()?;
        Ok(MaterialRetention {
            ui_references,
            attachment_preparations,
            attachment_sources: self.attachment_sources,
            attachments,
            threads: self.threads,
            inheritances,
            sources: self.sources,
        })
    }
}
impl Catalog {
    pub fn capture_material_retention(
        &self,
        child_id: Option<&str>,
        drained_threads: &[String],
        include_ui_references: bool,
    ) -> Result<MaterialRetentionRead> {
        let publication = self.content.begin_publication();
        let mut threads = Vec::new();
        for row in self.db.prepare("SELECT id FROM threads WHERE (?1 IS NULL OR id=?1)")?
            .query_map([child_id], |row| row.get::<_, String>(0))? {
            let id = row?;
            threads.push(MaterialThreadRetention {
                root_thread_id: scheduling::thread_family(&self.db, &id)?,
                release: drained_threads.contains(&id),
                thread_id: id,
            });
        }
        let mut attachment_sources = Vec::new();
        if child_id.is_none() {
            for row in self.db.prepare("SELECT r.body,l.body,b.thread_id FROM run_launches l JOIN runs r ON r.id=l.id JOIN branches b ON b.id=r.branch_id JOIN threads t ON t.id=b.thread_id WHERE t.deleted_at_ms IS NOT NULL")?
                .query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))? {
                let (run,launch,thread)=row?;
                if !drained_threads.contains(&thread){continue;}
                let run:Run=serde_json::from_str(&run)?;
                let launch:launch_content::LaunchMetadata=serde_json::from_str(&launch)?;
                if let Some(source)=launch.selection.source.filter(|source|!source.resource_owner.is_local()) {
                    attachment_sources.push(AttachmentSourceRetirement {thread_id:thread,run_id:run.id,epoch:launch.bound_epoch.unwrap_or(run.epoch),source});
                }
            }
        }
        let mut preparations = Vec::new();
        if child_id.is_none() {
            for row in self.db.prepare("SELECT o.body FROM operations o WHERE json_extract(o.body,'$.phase')='terminal' AND json_extract(o.body,'$.outcome') IN ('failed','cancelled') AND json_extract(o.body,'$.effect')='none' AND json_extract(o.body,'$.intent.kind')='tool' AND json_extract(o.body,'$.intent.call.name') IN ('send','dispatch')")?
                .query_map([], |row| row.get::<_, String>(0))? {
                let operation: Operation = serde_json::from_str(&row?)?;
                if operation.external_receipt.as_ref().is_some_and(|receipt| !receipt.executor_stopped) { continue; }
                let intent = super::tool_content::ToolIntent::from_operation(&operation)?;
                if !matches!((intent.call().name.as_str(), intent.call().schema_version.as_str()), ("send", "5") | ("dispatch", "8" | "9")) { continue; }
                let run = self.run(&operation.run_id)?;
                let Some(launch) = self.launch_metadata(&run.id)? else { continue; };
                let context = crate::execution::ToolExecutionContext { run_id: run.id.clone(), operation_id: operation.id, origin: intent.origin().clone() };
                preparations.push((run.thread_id, launch.bound_epoch.unwrap_or(run.epoch), self.capture_tool_invocation(&context, &intent.call().call_id)?));
            }
        }
        let mut children = Vec::new();
        for row in self
            .db
            .prepare("SELECT c.body FROM child_tasks c WHERE (?1 IS NULL OR c.child_thread_id=?1)")?
            .query_map([child_id], |row| row.get::<_, String>(0))?
        {
            let child: delegated::ChildRelation = serde_json::from_str(&row?)?;
            if child.inherited_context.is_some() {
                let root = scheduling::thread_family(&self.db, &child.child_thread_id)?;
                children.push((child, root));
            }
        }
        let mut reports = Vec::new();
        for row in self.db.prepare("SELECT d.body,c.body FROM delegated_executions d JOIN child_tasks c ON c.id=d.child_operation_id WHERE json_extract(d.body,'$.report') IS NOT NULL")?
            .query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))? {
            let (execution,child)=row?;
            let execution:delegated::DelegatedExecution=serde_json::from_str(&execution)?;
            let child:delegated::ChildRelation=serde_json::from_str(&child)?;
            let (mut target_thread,mut target_branch)=(child.parent_thread_id,child.parent_branch_id);
            if let delegated::DelegatedTrigger::MessageRequest{message_id,..}=&execution.trigger {
                let input:inputs::QueuedInputMetadata=record(&self.db,"input_queue",message_id)?;
                if let inputs::InputOrigin::Message{identity,..}=input.origin {
                    target_thread=identity.sender_thread_id;target_branch=identity.sender_branch_id;
                }
            }
            if child_id.is_some_and(|id|id!=target_thread){continue;}
            let report=execution.report.expect("selected report");
            let mut history=Vec::new();let mut next=report.history_ids.last().cloned();
            while let Some(id)=next {
                let item:HistoryItem=record(&self.db,"history",&id)?;
                if item.source!=HistorySource::Assistant || report.run_id.as_deref()!=Some(item.run_id.as_str()){break;}
                next=item.parent.clone();history.push(item);
            }
            if !history.is_empty(){reports.push((super::attachments::AttachmentDelivery {
                holder_kind:"report".into(),holder_id:execution.execution_id,
                thread_id:target_thread,branch_id:target_branch,
                source_thread_id:Some(child.child_thread_id),source_branch_id:Some(child.child_branch_id),
                attachments:report.attachments.clone(),input_ref:None,
            },report,history));}
        }
        let sources = if child_id.is_none() {
            self.capture_source_retirements(drained_threads)?
        } else {
            Vec::new()
        };
        Ok(MaterialRetentionRead {
            ui_retention: if include_ui_references && child_id.is_none() { Some(crate::content::collection::capture_ui_retention(&self.db)?) } else { None },
            preparations,
            attachment_sources,
            attachments: self
                .attachment_deliveries()?
                .into_iter()
                .filter(|edge| child_id.is_none_or(|id| id == edge.thread_id))
                .collect(),
            threads,
            sources,
            children,
            reports,
            content: self.content.clone(),
            _publication: publication,
        })
    }
}
