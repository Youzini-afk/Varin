//! Projects original conversation/tool ownership into the existing affected-file journal.
use super::*;
use crate::execution::ToolExecutionContext;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalAnchor {
    pub execution_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub entry_id: String,
    pub epoch: u64,
}
pub struct JournalAnchorRead {
    invocation: tool_content::ToolInvocationRead,
    database: std::path::PathBuf,
    thread: String,
    epoch: u64,
}
fn is_input(source: HistorySource) -> bool {
    matches!(
        source,
        HistorySource::User | HistorySource::Environment | HistorySource::Agent
    )
}
impl Catalog {
    pub fn capture_recovery_labels(&self, thread: &str, runs: Vec<String>) -> RecoveryLabelsRead {
        RecoveryLabelsRead { thread:thread.into(), runs, database:self.database_path.clone(), epoch:self.epoch,
            content:self.content.clone(), _publication:self.content.begin_publication() }
    }
    pub fn recovery_sources(&self, thread: &str, branch: &str) -> Result<Vec<Value>> {
        if self.branch_thread_id(branch)? != thread { return Err(RuntimeError::Conflict("recovery branch owner differs".into())); }
        let mut query=self.db.prepare("SELECT l.id,json_extract(l.body,'$.selection.source') FROM run_launches l JOIN runs r ON r.id=l.id WHERE json_extract(r.body,'$.thread_id')=?1 AND json_extract(l.body,'$.selection.source') IS NOT NULL ORDER BY l.rowid DESC")?;
        let rows=query.query_map([thread],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut seen=std::collections::BTreeSet::new();
        let mut result=Vec::new();
        for (run,body) in rows {
            let source:Value=serde_json::from_str(&body)?;
            let environment=if source["mode"]=="materialized" {source["environment_run_id"].as_str().unwrap_or(&run)} else {""};
            let key=json!([source["resource_owner"],source["workspace_id"],source["execution_workspace_id"],source["mode"],source["live_root"],environment]).to_string();
            if seen.insert(key) {result.push(json!({"runId":run,"source":source}));}
        }
        Ok(result)
    }
    pub fn recovery_workspaces(&self, thread: &str, branch: &str) -> Result<Vec<launches::SourceSelection>> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "recovery branch owner differs".into(),
            ));
        }
        let mut query = self.db.prepare("SELECT DISTINCT json_extract(l.body,'$.selection.source') FROM run_launches l JOIN runs r ON r.id=l.id WHERE json_extract(r.body,'$.thread_id')=?1 AND json_extract(l.body,'$.selection.source.workspace_id') IS NOT NULL ORDER BY 1")?;
        let rows = query
            .query_map([thread], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?;
        rows.into_iter().map(|body:String|serde_json::from_str(&body).map_err(Into::into)).collect()
    }
    pub fn capture_journal_anchor(
        &self,
        context: &ToolExecutionContext,
    ) -> Result<JournalAnchorRead> {
        let operation = self.operation(&context.operation_id)?;
        let intent = tool_content::ToolIntent::from_operation(&operation)?;
        let run = self.run(&context.run_id)?;
        if operation.run_id != run.id || intent.origin() != &context.origin {
            return Err(RuntimeError::Conflict("journal invocation changed".into()));
        }
        Ok(JournalAnchorRead {
            invocation: self.capture_tool_invocation(context, &intent.call().call_id)?,
            database: self.database_path.clone(),
            thread: run.thread_id,
            epoch: self.epoch,
        })
    }
    /// Metadata-only reader; I/O and traversal run after releasing Catalog.
    pub fn capture_recovery_range(
        &self,
        thread: &str,
        branch: &str,
        entry: &str,
    ) -> Result<RecoveryRangeRead> {
        if self.branch_thread_id(branch)? != thread {
            return Err(RuntimeError::Conflict(
                "recovery branch owner differs".into(),
            ));
        }
        Ok(RecoveryRangeRead {
            thread: thread.into(),
            run_id: None,
            entry: entry.into(),
            head: self.head(branch)?,
            database: self.database_path.clone(),
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    /// Original Run history stays available after branch navigation. Used to
    /// settle its existing file journal without depending on today's branch head.
    pub fn capture_run_recovery(&self, run_id: &str) -> Result<RecoveryRangeRead> {
        let run = self.run(run_id)?;
        Ok(RecoveryRangeRead {
            thread: run.thread_id,
            run_id: Some(run.id),
            entry: String::new(),
            head: None,
            database: self.database_path.clone(),
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}
/// A visible page needs only its original user input, independently of today's head.
pub struct RecoveryLabelsRead {
    thread:String,
    runs:Vec<String>,
    database:std::path::PathBuf,
    epoch:u64,
    content:crate::content::ContentStore,
    _publication:crate::content::ContentPublication,
}
impl RecoveryLabelsRead {
    pub fn load(self, cancelled:&dyn Fn()->bool)->Result<Value> {
        let db=history_views::current_history_owner(&self.database,self.epoch)?;
        let mut labels=serde_json::Map::new();
        for id in self.runs.into_iter().collect::<std::collections::BTreeSet<_>>() {
            if cancelled() {return Err(RuntimeError::DispatchCancelled);}
            let run:Run=record(&db,"runs",&id)?;
            if run.thread_id!=self.thread {return Err(RuntimeError::Conflict("Recovery title belongs to another Thread".into()));}
            let raw:Option<String>=db.query_row("SELECT body FROM history WHERE run_id=?1 AND json_extract(body,'$.source')='user' ORDER BY rowid LIMIT 1",[&id],|row|row.get(0)).optional()?;
            if let Some(raw)=raw {
                let item:HistoryItem=serde_json::from_str(&raw)?;
                let (body,_)=self.content.load_history_payload_cancellable(&item.content,cancelled)?;
                if let Some(text)=body.as_str().or_else(||body["text"].as_str()) {
                    // Titles are a short display excerpt, not another model-generated summary.
                    let title=text.split_whitespace().flat_map(|part|part.chars().chain(std::iter::once(' '))).take(160).collect::<String>().trim_end().to_owned();
                    if !title.is_empty() {labels.insert(id,json!(title));}
                }
            }
        }
        history_views::current_history_owner(&self.database,self.epoch)?;
        Ok(Value::Object(labels))
    }
}
impl JournalAnchorRead {
    pub fn load(self) -> Result<JournalAnchor> {
        let snapshot = self.invocation.load()?;
        let db = history_views::current_history_owner(&self.database, self.epoch)?;
        let mut cursor = snapshot.history_range.leaf_id;
        while let Some(key) = cursor {
            let item: HistoryItem = record(&db, "history", &key)?;
            if item.thread_id != self.thread {
                return Err(RuntimeError::Conflict(
                    "journal history owner differs".into(),
                ));
            }
            if is_input(item.source) {
                return Ok(JournalAnchor {
                    execution_id: format!("{}:{}", snapshot.context.run_id, key),
                    thread_id: self.thread,
                    branch_id: snapshot.history_range.branch_id,
                    run_id: snapshot.context.run_id,
                    entry_id: key,
                    epoch: self.epoch,
                });
            }
            cursor = item.parent;
        }
        Err(RuntimeError::Invalid(
            "tool invocation has no actual input history anchor".into(),
        ))
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRangeTurn {
    pub anchor: JournalAnchor,
    pub entry_ids: Vec<String>,
    pub source: Option<launches::SourceSelection>,
    pub uncovered: bool,
    pub settled: bool,
}
pub struct RecoveryRangeRead {
    thread: String,
    run_id: Option<String>,
    entry: String,
    head: Option<String>,
    database: std::path::PathBuf,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl RecoveryRangeRead {
    pub fn load(self) -> Result<Vec<RecoveryRangeTurn>> {
        let db = history_views::current_history_owner(&self.database, self.epoch)?;
        let mut entries = Vec::new();
        if let Some(run_id) = &self.run_id {
            let mut query = db.prepare("SELECT body FROM history WHERE run_id=?1 ORDER BY rowid")?;
            for raw in query.query_map([run_id], |row| row.get::<_, String>(0))? {
                let item: HistoryItem = serde_json::from_str(&raw?)?;
                if item.thread_id != self.thread || item.run_id != *run_id {
                    return Err(RuntimeError::Conflict("recovery history owner differs".into()));
                }
                entries.push(item);
            }
        } else {
            let mut cursor = self.head;
            let mut found = false;
            while let Some(key) = cursor {
                let item: HistoryItem = record(&db, "history", &key)?;
                if item.thread_id != self.thread {
                    return Err(RuntimeError::Conflict("recovery history owner differs".into()));
                }
                if key == self.entry { found = true; }
                cursor = item.parent.clone();
                let stop = found && is_input(item.source);
                entries.push(item);
                if stop { break; }
            }
            if !found {
                return Err(RuntimeError::Conflict("recovery entry is no longer on this branch".into()));
            }
            entries.reverse();
        }
        // Traverse immutable invocation bodies only on this reader, never while holding Catalog.
        let mut external = std::collections::BTreeSet::new();
        let runs = entries
            .iter()
            .map(|item| item.run_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        for run_id in runs {
            let operations = {
                let mut query = db.prepare("SELECT body FROM operations WHERE run_id=?1")?;
                let values = query
                    .query_map([&run_id], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                values
            };
            for raw in operations {
                let operation: Operation = serde_json::from_str(&raw)?;
                if operation.effect == Effect::None || operation.intent["kind"] != "tool" {
                    continue;
                }
                let intent = tool_content::ToolIntent::from_operation(&operation)?;
                if intent.contract().read_only {
                    continue;
                }
                let integration_journalled=if intent.call().name=="integrate_child" {
                    operation.result.clone().map(|result|result.load(&self.content)).transpose()?
                        .is_some_and(|result|result.output().is_ok_and(|output|output.data["fileJournal"]==true))
                } else {false};
                if (intent.call().name=="file_restore" || integration_journalled) && matches!(operation.effect, Effect::Confirmed | Effect::Partial) {
                    continue;
                }
                let physical_writer = intent.contract().resources.iter().any(|claim| {
                    serde_json::from_str::<Value>(&claim.key)
                        .ok()
                        .and_then(|key| key.get(0).and_then(Value::as_str).map(str::to_owned))
                        .is_some_and(|domain| {
                            matches!(
                                domain.as_str(),
                                "environment-writer-activity" | "process-input" | "process-size"
                            )
                        })
                });
                if !physical_writer
                    && !matches!(
                        operation.execution_owner,
                        Some(crate::ExecutorOwner::External { .. })
                    )
                {
                    continue;
                }
                let root = tool_content::root_tool_context(
                    &db,
                    &ToolExecutionContext {
                        run_id: run_id.clone(),
                        origin: intent.origin().clone(),
                        operation_id: operation.id,
                    },
                    false,
                )?;
                let range = match root.origin {
                    crate::execution::ToolOrigin::ModelStep { request_id } => {
                        let step: ModelStep = record(&db, "model_steps", &request_id)?;
                        let snapshot: crate::execution::RequestSnapshot =
                            self.content.load_snapshot(&step.request)?;
                        if snapshot.view.run_id != run_id || snapshot.view.request_id != request_id
                        {
                            return Err(RuntimeError::Conflict(
                                "recovery invocation source changed".into(),
                            ));
                        }
                        snapshot.view.binding.history_range
                    }
                    crate::execution::ToolOrigin::PolicyAction { action_id, .. } => {
                        let operation: Operation = record(&db, "operations", &action_id)?;
                        policy::graph_metadata(&operation)?
                            .ok_or_else(|| {
                                RuntimeError::Invalid("recovery graph source missing".into())
                            })?
                            .boundary()
                            .history_range
                            .clone()
                    }
                    crate::execution::ToolOrigin::NestedCall { .. } => {
                        unreachable!("original root invocation resolved")
                    }
                };
                let mut leaf = range.leaf_id;
                while let Some(key) = leaf {
                    let item: HistoryItem = record(&db, "history", &key)?;
                    if item.thread_id != self.thread {
                        return Err(RuntimeError::Conflict(
                            "recovery input owner changed".into(),
                        ));
                    }
                    if is_input(item.source) {
                        external.insert(format!("{run_id}:{}", item.id));
                        break;
                    }
                    leaf = item.parent;
                }
            }
        }
        let mut result: Vec<RecoveryRangeTurn> = Vec::new();
        for item in entries {
            if is_input(item.source) {
                let run: Run = record(&db, "runs", &item.run_id)?;
                let source = optional_record::<launch_content::LaunchMetadata>(
                    &db,
                    "run_launches",
                    &run.id,
                )?
                .and_then(|launch| launch.selection.source);
                let uncovered = external.contains(&format!("{}:{}", run.id, item.id));
                result.push(RecoveryRangeTurn {
                    anchor: JournalAnchor {
                        execution_id: format!("{}:{}", run.id, item.id),
                        thread_id: self.thread.clone(),
                        branch_id: run.branch_id,
                        run_id: run.id,
                        entry_id: item.id.clone(),
                        epoch: self.epoch,
                    },
                    entry_ids: Vec::new(),
                    source,
                    uncovered,
                    settled: run.state.terminal(),
                });
            }
            if let Some(turn) = result.last_mut() {
                turn.entry_ids.push(item.id);
            }
        }
        history_views::current_history_owner(&self.database, self.epoch)?;
        Ok(result)
    }
}
