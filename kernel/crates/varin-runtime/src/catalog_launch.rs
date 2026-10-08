//! Durable launch intent. Live grants and credential material never enter this domain.
use super::*;
use crate::execution::{PolicyIdentity, RequestBinding, ToolSchema};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceSelection {
    pub materialized: bool,
    pub workspace_id: String,
    pub execution_workspace_id: String,
    pub branch_id: Option<String>,
    pub revision: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LaunchSelection {
    pub connection_identity: String,
    pub provider_family: String,
    pub model: String,
    pub configuration_generation: u64,
    pub tool_schema_generation: u64,
    pub tools: Vec<ToolSchema>,
    pub policy: PolicyIdentity,
    pub source: Option<SourceSelection>,
}
impl LaunchSelection {
    pub fn from_binding(
        binding: &RequestBinding,
        policy: PolicyIdentity,
        source: Option<SourceSelection>,
    ) -> Self {
        Self {
            connection_identity: binding.connection_identity.clone(),
            provider_family: binding.provider_family.clone(),
            model: binding.model.clone(),
            configuration_generation: binding.configuration_generation,
            tool_schema_generation: binding.tool_schema_generation,
            tools: binding.tools.clone(),
            policy,
            source,
        }
    }
    fn validate(&self) -> Result<()> {
        if self.connection_identity.is_empty()
            || self.provider_family.is_empty()
            || self.model.is_empty()
            || self.policy.name.is_empty()
            || self.policy.version.is_empty()
        {
            return Err(RuntimeError::Invalid(
                "launch requires pinned provider and policy identities".into(),
            ));
        }
        let mut names = std::collections::BTreeSet::new();
        if self.tools.iter().any(|tool| {
            tool.name.is_empty() || tool.version.is_empty() || !names.insert(&tool.name)
        }) {
            return Err(RuntimeError::Invalid(
                "launch tool identities must be unique and versioned".into(),
            ));
        }
        if let Some(source) = &self.source {
            if source.workspace_id.is_empty()
                || source.execution_workspace_id.is_empty()
                || source.branch_id.is_some() != source.revision.is_some()
                || source.branch_id.as_deref() == Some("")
            {
                return Err(RuntimeError::Invalid("launch source requires workspace identity and a complete fixed branch revision".into()));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LaunchIntent {
    pub run_id: String,
    pub revision: u64,
    pub selection: LaunchSelection,
    /// Only an owner epoch, never a reusable permit. The Host must reconstruct all live bindings.
    pub bound_epoch: Option<u64>,
    pub requires_rebind: bool,
}

pub(super) fn initialize(db: &mut Connection) -> Result<()> {
    let tx = db.transaction()?;
    let version: Option<i64> = tx
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='run_launches'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT type FROM sqlite_master WHERE name='run_launches'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match version {
        None if existing.is_none() => tx.execute_batch("CREATE TABLE run_launches(id TEXT PRIMARY KEY REFERENCES runs(id),body TEXT NOT NULL); INSERT INTO runtime_domains(name,version) VALUES('run_launches',1);")?,
        Some(1) if existing.as_deref() == Some("table") => {
            let columns:Vec<(String,String,i64,i64)> = { let mut s=tx.prepare("PRAGMA table_info(run_launches)")?; let rows=s.query_map([],|r|Ok((r.get(1)?,r.get(2)?,r.get(3)?,r.get(5)?)))?; rows.collect::<std::result::Result<_,_>>()? };
            if columns != vec![("id".into(),"TEXT".into(),0,1),("body".into(),"TEXT".into(),1,0)] { return Err(RuntimeError::Invalid("malformed launch domain; data preserved".into())); }
        },
        _ => return Err(RuntimeError::Invalid("unrecognized launch domain; data preserved".into())),
    }
    tx.commit()?;
    Ok(())
}
impl Catalog {
    /// Store the selected plan before starting a worker. Retries can only rebind the same plan.
    /// Durable intent is not proof of authorization or worker liveness.
    pub fn bind_launch(
        &mut self,
        run_id: &str,
        selection: LaunchSelection,
    ) -> Result<LaunchIntent> {
        self.save_launch(run_id, selection, true)
    }
    /// Durable selection precedes expensive preparation. It conveys no live execution permit.
    pub fn select_launch(
        &mut self,
        run_id: &str,
        selection: LaunchSelection,
    ) -> Result<LaunchIntent> {
        self.save_launch(run_id, selection, false)
    }
    fn save_launch(
        &mut self,
        run_id: &str,
        selection: LaunchSelection,
        bound: bool,
    ) -> Result<LaunchIntent> {
        selection.validate()?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::Conflict(
                "Run cancellation is closing launch admission".into(),
            ));
        }
        let previous: Option<LaunchIntent> = optional_record(&tx, "run_launches", run_id)?;
        let intent = match previous {
            Some(mut intent) => {
                if intent.selection != selection {
                    return Err(RuntimeError::Conflict(
                        "launch selection changed; rebind must preserve its frozen identity".into(),
                    ));
                }
                if !bound || intent.bound_epoch == Some(self.epoch) {
                    return Ok(intent);
                }
                intent.revision += 1;
                intent.bound_epoch = Some(self.epoch);
                intent.requires_rebind = false;
                put(&tx, "run_launches", run_id, &intent)?;
                intent
            }
            None => {
                let intent = LaunchIntent {
                    run_id: run_id.into(),
                    revision: 1,
                    selection,
                    bound_epoch: if bound { Some(self.epoch) } else { None },
                    requires_rebind: !bound,
                };
                tx.execute(
                    "INSERT INTO run_launches(id,body) VALUES(?1,?2)",
                    params![run_id, encode(&intent)?],
                )?;
                intent
            }
        };
        event(
            &tx,
            run_id,
            intent.revision,
            if bound {
                "run.launch_bound"
            } else {
                "run.launch_selected"
            },
            serde_json::to_value(&intent)?,
        )?;
        tx.commit()?;
        Ok(intent)
    }
    pub fn launch_intent(&self, run_id: &str) -> Result<Option<LaunchIntent>> {
        let mut intent: Option<LaunchIntent> = optional_record(&self.db, "run_launches", run_id)?;
        if let Some(intent) = &mut intent {
            intent.requires_rebind = intent.bound_epoch != Some(self.epoch);
        }
        Ok(intent)
    }
    /// Includes queued launches; recovery never silently executes a saved grant or model request.
    pub fn pending_launches(&self) -> Result<Vec<LaunchIntent>> {
        let intents: Vec<LaunchIntent> = read_all(&self.db, "run_launches")?;
        let mut pending = Vec::new();
        for mut intent in intents {
            let run: Run = record(&self.db, "runs", &intent.run_id)?;
            if !run.state.terminal() {
                intent.requires_rebind = intent.bound_epoch != Some(self.epoch);
                pending.push(intent);
            }
        }
        Ok(pending)
    }
}
