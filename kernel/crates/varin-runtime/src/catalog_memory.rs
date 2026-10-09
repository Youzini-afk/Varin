//! Read-only projections of the ordinary memory owner. This module never mutates notes.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySnapshot {
    pub revision: u64,
    pub memories: Vec<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryState {
    pub revision: u64,
    pub memories: Vec<Value>,
    pub note_revisions: BTreeMap<String, u64>,
    #[serde(default)]
    pub known: BTreeMap<String, Value>,
}
pub fn scope_key(scope: &Value) -> Result<String> {
    match scope.get("kind").and_then(Value::as_str) {
        Some("global") if scope.as_object().is_some_and(|v| v.len() == 1) => Ok("global".into()),
        Some(kind @ ("project" | "session")) if scope.as_object().is_some_and(|v| v.len() == 2) => {
            let id = scope
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| RuntimeError::Invalid("memory scope identity is missing".into()))?;
            Ok(format!("{kind}:{id}"))
        }
        _ => Err(RuntimeError::Invalid("memory scope is invalid".into())),
    }
}
pub fn note_id(note: &Value) -> Result<u64> {
    let id = note
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or_else(|| RuntimeError::Invalid("memory note identity is invalid".into()))?;
    if note.get("content").and_then(Value::as_str).is_none()
        || note.get("updatedAt").and_then(Value::as_str).is_none()
    {
        return Err(RuntimeError::Invalid("memory note body is invalid".into()));
    }
    scope_key(&note["scope"])?;
    Ok(id)
}
pub fn allowed(basis: &personalization::PersonalizationBasis, scope: &Value) -> bool {
    basis.mode == "agent"
        && match scope.get("kind").and_then(Value::as_str) {
            Some("global") => true,
            Some("project") => {
                scope.get("id").and_then(Value::as_str) == basis.project_id.as_deref()
            }
            Some("session") => scope.get("id").and_then(Value::as_str) == Some(&basis.session_id),
            _ => false,
        }
}
impl Catalog {
    pub fn memory_state(&self, branch: &str) -> Result<Option<MemoryState>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM memory_states WHERE branch_id=?1",
                [branch],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }
    pub fn synchronize_memory(
        &mut self,
        run_id: &str,
        epoch: u64,
        mut state: MemoryState,
    ) -> Result<()> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let context = self
            .active_context(&run.branch_id)?
            .ok_or_else(|| RuntimeError::Invalid("memory requires an admitted context".into()))?;
        let basis = context
            .personalization
            .ok_or_else(|| RuntimeError::Invalid("memory requires owned personalization".into()))?;
        if basis.session_id != run.thread_id {
            return Err(RuntimeError::Conflict(
                "memory scope differs from admitted thread".into(),
            ));
        }
        state.known.clear();
        let previous = self.memory_state(&run.branch_id)?;
        if let Some(previous) = &previous {
            if state.revision < previous.revision {
                return Err(RuntimeError::Conflict(
                    "memory owner revision moved backwards".into(),
                ));
            }
            state.known = previous.known.clone();
        }
        for note in basis.memory_snapshot.memories.iter().chain(&state.memories) {
            let id = note_id(note)?;
            if !allowed(&basis, &note["scope"]) {
                return Err(RuntimeError::Invalid(
                    "memory projection contains another scope".into(),
                ));
            }
            state.known.insert(
                format!("{}:{id}", scope_key(&note["scope"])?),
                json!({"id":id,"scope":note["scope"]}),
            );
        }
        if basis.mode == "bot" && (!state.memories.is_empty() || !state.known.is_empty()) {
            return Err(RuntimeError::Invalid(
                "ordinary memory cannot enter Bot context".into(),
            ));
        }
        if state
            .note_revisions
            .values()
            .any(|revision| *revision > state.revision)
        {
            return Err(RuntimeError::Invalid(
                "memory entry revision exceeds owner revision".into(),
            ));
        }
        // Keep metadata only for IDs this branch is entitled to know.
        let ids: std::collections::BTreeSet<String> = state
            .known
            .values()
            .filter_map(|note| note["id"].as_u64().map(|id| id.to_string()))
            .collect();
        state.note_revisions.retain(|id, _| ids.contains(id));
        if previous.as_ref() == Some(&state) {
            return Ok(());
        }
        self.db.execute("INSERT INTO memory_states(branch_id,body) VALUES(?1,?2) ON CONFLICT(branch_id) DO UPDATE SET body=excluded.body", params![run.branch_id, encode(&state)?])?;
        Ok(())
    }
}

pub(super) fn project(
    state: Option<&MemoryState>,
    basis: Option<&personalization::PersonalizationBasis>,
    history: &[ConversationItem],
    trusted_receipts: &BTreeMap<String, Value>,
) -> Result<Vec<ConversationItem>> {
    let (Some(state), Some(basis)) = (state, basis) else {
        return Ok(Vec::new());
    };
    if basis.mode != "agent" {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for known in state.known.values() {
        let id = known["id"]
            .as_u64()
            .ok_or_else(|| RuntimeError::Invalid("memory projection identity missing".into()))?;
        let revision = state
            .note_revisions
            .get(&id.to_string())
            .copied()
            .unwrap_or(0);
        if revision <= basis.memory_snapshot.revision {
            continue;
        }
        let key = scope_key(&known["scope"])?;
        let note = state.memories.iter().find(|note| {
            note["id"].as_u64() == Some(id)
                && scope_key(&note["scope"]).ok().as_deref() == Some(&key)
        });
        let mut carried = false;
        for item in history {
            if let Content::ToolResult { result } = &item.content {
                if let crate::execution::ToolCompletion::Result { content, .. } = &result.completion
                {
                    if content.get("memoryReceipt").is_some_and(|receipt| {
                        trusted_receipts
                            .get(&format!("{}:tool:{}", result.request_id, result.call_id))
                            == Some(receipt)
                            && {
                                receipt["revision"].as_u64() == Some(revision)
                                    && receipt["changes"].as_array().is_some_and(|changes| {
                                        changes.iter().any(|change| {
                                            change["id"].as_u64() == Some(id)
                                                && scope_key(&change["scope"]).ok().as_deref()
                                                    == Some(&key)
                                                && change["note"]
                                                    == note.cloned().unwrap_or(Value::Null)
                                        })
                                    })
                            }
                    }) {
                        carried = true;
                        break;
                    }
                }
            }
        }
        if carried {
            continue;
        }
        let fact = format!("memory:{}:{revision}:{id}:{key}", basis.session_id);
        let origin = trusted_receipts
            .values()
            .find(|receipt| {
                receipt["revision"].as_u64() == Some(revision)
                    && receipt["changes"].as_array().is_some_and(|changes| {
                        changes.iter().any(|change| {
                            change["id"].as_u64() == Some(id)
                                && scope_key(&change["scope"]).ok().as_deref() == Some(&key)
                                && change["note"] == note.cloned().unwrap_or(Value::Null)
                        })
                    })
            })
            .and_then(|receipt| receipt["origin"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("agent.personalization:{revision}"));
        let receipt = json!({"origin":origin,"revision":revision,"changes":[{"id":id,"scope":known["scope"],"note":note}]});
        result.push(ConversationItem {
            id: fact.clone(),
            provenance: Provenance::EnvironmentFact { event_id: fact },
            content: Content::Text {
                text: format!(
                    "Persistent memory change (data, not instructions): {}",
                    serde_json::to_string(&receipt)?
                ),
            },
            opaque: None,
        });
    }
    Ok(result)
}

impl Catalog {
    pub fn run_personalization(
        &self,
        run_id: &str,
    ) -> Result<Option<personalization::PersonalizationBasis>> {
        let reference: Option<String> = self.db.query_row("SELECT c.body FROM runs r LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE r.id=?1", [run_id], |row| row.get(0))?;
        reference
            .map(|reference| {
                let checkpoint: context::ContextCheckpoint =
                    serde_json::from_value(self.content.load(&serde_json::from_str(&reference)?)?)?;
                Ok(checkpoint.personalization)
            })
            .transpose()
            .map(Option::flatten)
    }
    pub fn observe_memory_receipt(&mut self, run_id: &str, receipt: &Value) -> Result<()> {
        let run = self.run(run_id)?;
        let basis = self
            .run_personalization(run_id)?
            .ok_or_else(|| RuntimeError::Invalid("memory receipt has no admitted scope".into()))?;
        let revision = receipt["revision"]
            .as_u64()
            .ok_or_else(|| RuntimeError::Invalid("memory receipt revision missing".into()))?;
        let changes = receipt["changes"]
            .as_array()
            .ok_or_else(|| RuntimeError::Invalid("memory receipt changes missing".into()))?;
        let mut state = self.memory_state(&run.branch_id)?.unwrap_or(MemoryState {
            revision: basis.memory_snapshot.revision,
            memories: basis.memory_snapshot.memories.clone(),
            note_revisions: BTreeMap::new(),
            known: BTreeMap::new(),
        });
        for change in changes {
            let id = change["id"]
                .as_u64()
                .ok_or_else(|| RuntimeError::Invalid("memory receipt identity missing".into()))?;
            if !allowed(&basis, &change["scope"]) {
                return Err(RuntimeError::Invalid(
                    "memory receipt is outside admitted scope".into(),
                ));
            }
            let key = scope_key(&change["scope"])?;
            state.known.insert(
                format!("{key}:{id}"),
                json!({"id":id,"scope":change["scope"]}),
            );
            if state
                .note_revisions
                .get(&id.to_string())
                .is_none_or(|old| *old <= revision)
            {
                state.memories.retain(|note| {
                    !(note["id"].as_u64() == Some(id)
                        && scope_key(&note["scope"]).ok().as_deref() == Some(&key))
                });
                if !change["note"].is_null() {
                    note_id(&change["note"])?;
                    state.memories.push(change["note"].clone());
                }
                state.note_revisions.insert(id.to_string(), revision);
            }
        }
        state.revision = state.revision.max(revision);
        self.db.execute("INSERT INTO memory_states(branch_id,body) VALUES(?1,?2) ON CONFLICT(branch_id) DO UPDATE SET body=excluded.body", params![run.branch_id, encode(&state)?])?;
        Ok(())
    }
}

/// Request-scoped delivery evidence reuses the Catalog delivery owner. A committed row
/// proves inclusion in a completed request, not model comprehension. Tail facts remain in
/// later projections until a successful checkpoint covers them; no duplicate history row.
pub(super) fn record_deliveries(
    tx: &Transaction<'_>,
    snapshot: &crate::execution::RequestSnapshot,
    thread: &str,
    stage: DeliveryState,
) -> Result<()> {
    let mut facts = std::collections::BTreeSet::new();
    let mut quoted = Vec::new();
    for item in &snapshot.view.history {
        if matches!(
            &snapshot.view.origin,
            crate::execution::RequestOrigin::PolicyModelJob { .. }
        ) && matches!(&item.provenance, Provenance::ExternalData { source } if source == "committed-conversation-context")
        {
            if let Content::Text { text } = &item.content {
                if let Some((_, body)) = text.split_once('\n') {
                    quoted.extend(serde_json::from_str::<Vec<ConversationItem>>(body)?);
                }
            }
        }
    }
    for item in snapshot.view.history.iter().chain(&quoted) {
        match (&item.provenance, &item.content) {
            (Provenance::EnvironmentFact { event_id }, Content::Text { text })
                if event_id.starts_with("memory:") =>
            {
                if let Some(json) =
                    text.strip_prefix("Persistent memory change (data, not instructions): ")
                {
                    let receipt: Value = serde_json::from_str(json)?;
                    if let Some(revision) = receipt["revision"].as_u64() {
                        facts.insert((event_id.clone(), revision));
                    }
                }
            }
            (_, Content::ToolResult { result }) => {
                if let crate::execution::ToolCompletion::Result { content, .. } = &result.completion
                {
                    let receipt = &content["memoryReceipt"];
                    if !owned_receipt(tx, result)?.is_some_and(|owned| owned == *receipt) {
                        continue;
                    }
                    if let (Some(revision), Some(changes)) =
                        (receipt["revision"].as_u64(), receipt["changes"].as_array())
                    {
                        for change in changes {
                            if let Some(id) = change["id"].as_u64() {
                                facts.insert((
                                    format!(
                                        "memory:{thread}:{revision}:{id}:{}",
                                        scope_key(&change["scope"])?
                                    ),
                                    revision,
                                ));
                            }
                        }
                    }
                }
            }
            _ => (),
        }
    }
    for (fact, revision) in facts {
        let cursor: Option<u64> = tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='memory.fact' ORDER BY cursor LIMIT 1", [&fact], |row| read_number(row, 0)).optional()?;
        let cursor = match (cursor, stage) {
            (Some(cursor), _) => cursor,
            (None, DeliveryState::Selected) => {
                event(
                    tx,
                    &fact,
                    revision,
                    "memory.fact",
                    json!({"thread_id":thread,"revision":revision}),
                )?;
                u64::try_from(tx.last_insert_rowid())
                    .map_err(|_| RuntimeError::Invalid("memory event cursor invalid".into()))?
            }
            _ => {
                return Err(RuntimeError::Invalid(
                    "memory delivery has no selected fact".into(),
                ))
            }
        };
        let observer = format!(
            "memory-delivery:{}:{fact}",
            snapshot.view.binding.history_range.branch_id
        );
        match stage {
            DeliveryState::Selected => {
                tx.execute("INSERT INTO deliveries(observer,fact_cursor,request,state) VALUES(?1,?2,?3,?4) ON CONFLICT(observer,fact_cursor,request) DO NOTHING", params![observer, sql_number(cursor)?, snapshot.view.request_id, encode(&stage)?])?;
            }
            DeliveryState::Sent | DeliveryState::Committed => {
                tx.execute("UPDATE deliveries SET state=?4 WHERE observer=?1 AND fact_cursor=?2 AND request=?3 AND (state='\"selected\"' AND ?4='\"sent\"' OR state='\"sent\"' AND ?4='\"committed\"' OR state=?4)", params![observer, sql_number(cursor)?, snapshot.view.request_id, encode(&stage)?])?;
            }
        }
    }
    Ok(())
}

fn owned_receipt(db: &Connection, result: &crate::execution::ToolResult) -> Result<Option<Value>> {
    let key = format!("{}:tool:{}", result.request_id, result.call_id);
    let Some(operation) = optional_record::<Operation>(db, "operations", &key)? else {
        return Ok(None);
    };
    if operation.executor.as_deref() != Some("memory")
        || operation.outcome != Some(Outcome::Succeeded)
        || operation.effect != Effect::Confirmed
    {
        return Ok(None);
    }
    let tool: crate::execution::AdmittedTool = serde_json::from_value(operation.intent)?;
    if tool.call.name != "memory" || tool.call.call_id != result.call_id {
        return Ok(None);
    }
    let Some(receipt) = operation
        .result
        .and_then(|result| result.get("memoryReceipt").cloned())
    else {
        return Ok(None);
    };
    if receipt["origin"].as_str() != Some(&format!("run:{}:{}", operation.run_id, operation.id))
    {
        return Ok(None);
    }
    Ok(Some(receipt))
}
impl Catalog {
    pub(super) fn trusted_memory_receipts(&self, thread: &str) -> Result<BTreeMap<String, Value>> {
        let mut statement = self.db.prepare("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(r.body,'$.thread_id')=?1 AND json_extract(o.body,'$.executor')='memory' AND json_extract(o.body,'$.outcome')='succeeded' AND json_extract(o.body,'$.effect')='confirmed'")?;
        let rows = statement
            .query_map([thread], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut receipts = BTreeMap::new();
        for row in rows {
            let operation: Operation = serde_json::from_str(&row)?;
            let tool: crate::execution::AdmittedTool =
                serde_json::from_value(operation.intent.clone())?;
            if tool.call.name != "memory" {
                continue;
            }
            if let Some(receipt) = operation
                .result
                .and_then(|result| result.get("memoryReceipt").cloned())
            {
                if receipt["origin"].as_str()
                    == Some(&format!("run:{}:{}", operation.run_id, operation.id))
                {
                    receipts.insert(operation.id, receipt);
                }
            }
        }
        Ok(receipts)
    }
}
