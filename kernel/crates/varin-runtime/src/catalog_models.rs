//! Desired model choices and their activation at a closed ModelStep boundary.
use super::*;
use crate::{execution::RequestBinding, providers::auth::CredentialScope};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunModelSelectionStatus {
    Preparing,
    Ready,
    Active,
    Failed,
    Superseded,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunModelSelection {
    pub id: String,
    pub run_id: String,
    pub revision: u64,
    pub binding_id: String,
    pub configuration: ModelSessionConfiguration,
    pub credential_scope: Option<CredentialScope>,
    pub status: RunModelSelectionStatus,
    pub failure: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunModelSelections {
    pub desired: Option<RunModelSelection>,
    pub active: Option<RunModelSelection>,
}
impl Catalog {
    pub fn model_selections(&self, run_id: &str) -> Result<RunModelSelections> {
        self.run(run_id)?;
        let desired = self
            .db
            .query_row(
                "SELECT body FROM model_selections WHERE run_id=?1 ORDER BY revision DESC LIMIT 1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| serde_json::from_str(&body))
            .transpose()?;
        let active = self
            .db
            .query_row(
                "SELECT body FROM model_selections WHERE run_id=?1 AND active=1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|body| serde_json::from_str(&body))
            .transpose()?;
        Ok(RunModelSelections { desired, active })
    }
    pub fn select_model(
        &mut self,
        run_id: &str,
        key: &str,
        configuration: ModelSessionConfiguration,
        credential_scope: Option<CredentialScope>,
    ) -> Result<RunModelSelection> {
        if key.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "model selection key is required".into(),
            ));
        }
        if let Some(scope) = &credential_scope {
            scope
                .validate()
                .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        }
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested || run.configuration.get("context_job").is_some() {
            return Err(RuntimeError::Conflict(
                "Run is closing or has a fixed context-job model".into(),
            ));
        }
        if let Some(previous) = optional_record::<RunModelSelection>(&tx, "model_selections", key)?
        {
            if previous.run_id == run_id
                && previous.configuration == configuration
                && previous.credential_scope == credential_scope
            {
                return Ok(previous);
            }
            return Err(RuntimeError::Conflict(
                "model selection key was used for another choice".into(),
            ));
        }
        let revision: u64 = tx.query_row(
            "SELECT coalesce(max(revision),0)+1 FROM model_selections WHERE run_id=?1",
            [run_id],
            |row| read_number(row, 0),
        )?;
        // A newer desire supersedes only unpublished candidates. The actual active provider
        // remains valid for its admitted work until activation of the replacement.
        let previous: Option<String> = tx.query_row("SELECT id FROM model_selections WHERE run_id=?1 AND active=0 AND status IN ('preparing','ready','failed') ORDER BY revision DESC LIMIT 1",[run_id],|row|row.get(0)).optional()?;
        if let Some(previous) = previous {
            let mut previous: RunModelSelection = record(&tx, "model_selections", &previous)?;
            previous.status = RunModelSelectionStatus::Superseded;
            tx.execute(
                "UPDATE model_selections SET status='superseded',body=?2 WHERE id=?1",
                params![previous.id, encode(&previous)?],
            )?;
        }
        let selection = RunModelSelection {
            id: key.into(),
            run_id: run_id.into(),
            revision,
            binding_id: format!("model:{key}"),
            configuration,
            credential_scope,
            status: RunModelSelectionStatus::Preparing,
            failure: None,
        };
        tx.execute("INSERT INTO model_selections(id,run_id,revision,status,body) VALUES(?1,?2,?3,'preparing',?4)",params![key,run_id,sql_number(revision)?,encode(&selection)?])?;
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        event(
            &tx,
            run_id,
            run.revision,
            "run.model_selected",
            json!({"id":key,"revision":revision}),
        )?;
        tx.commit()?;
        Ok(selection)
    }
    /// A prepared adapter is process-local; this fact never grants permission to replay a request.
    pub fn prepare_model_selection(
        &mut self,
        selection: &RunModelSelection,
        epoch: u64,
        failure: Option<String>,
    ) -> Result<bool> {
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", &selection.run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Ok(false);
        }
        let current: String = tx.query_row(
            "SELECT id FROM model_selections WHERE run_id=?1 ORDER BY revision DESC LIMIT 1",
            [&selection.run_id],
            |row| row.get(0),
        )?;
        if current != selection.id {
            return Ok(false);
        }
        let mut stored: RunModelSelection = record(&tx, "model_selections", &selection.id)?;
        if stored.configuration != selection.configuration
            || stored.credential_scope != selection.credential_scope
        {
            return Err(RuntimeError::Conflict(
                "model preparation identity changed".into(),
            ));
        }
        if stored.status == RunModelSelectionStatus::Active && failure.is_none() {
            return Ok(true);
        }
        stored.status = if failure.is_some() {
            RunModelSelectionStatus::Failed
        } else {
            RunModelSelectionStatus::Ready
        };
        stored.failure = failure;
        tx.execute(
            "UPDATE model_selections SET status=?2,body=?3 WHERE id=?1",
            params![
                stored.id,
                if stored.status == RunModelSelectionStatus::Failed {
                    "failed"
                } else {
                    "ready"
                },
                encode(&stored)?
            ],
        )?;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        event(
            &tx,
            &selection.run_id,
            run.revision,
            "run.model_prepared",
            json!({"id":stored.id,"status":stored.status,"failure":stored.failure}),
        )?;
        tx.commit()?;
        Ok(true)
    }
    pub fn activate_model_selection(
        &mut self,
        selection: &RunModelSelection,
        epoch: u64,
        binding: &RequestBinding,
    ) -> Result<bool> {
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", &selection.run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Ok(false);
        }
        let current: String = tx.query_row(
            "SELECT id FROM model_selections WHERE run_id=?1 ORDER BY revision DESC LIMIT 1",
            [&selection.run_id],
            |row| row.get(0),
        )?;
        if current != selection.id {
            return Ok(false);
        }
        let mut stored: RunModelSelection = record(&tx, "model_selections", &selection.id)?;
        if stored.status == RunModelSelectionStatus::Active {
            return Ok(true);
        }
        if stored.status != RunModelSelectionStatus::Ready {
            return Err(RuntimeError::Conflict("selected model is not ready".into()));
        }
        let unresolved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched')) OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)",[&run.id],|row|row.get(0))?;
        if unresolved {
            return Err(RuntimeError::Conflict(
                "model exchange has not closed".into(),
            ));
        }
        let expected = if let Some(scope) = &stored.credential_scope {
            crate::model_session::connection_identity_with_scope(&stored.configuration, scope)
        } else {
            crate::model_session::connection_identity(&stored.configuration)
        }
        .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        if binding.connection_identity != expected
            || binding.model != stored.configuration.model
            || binding.provider_family != stored.configuration.provider_family
            || binding.configuration_generation != stored.configuration.configuration_generation
        {
            return Err(RuntimeError::Conflict(
                "prepared model differs from the selected configuration".into(),
            ));
        }
        let old: Option<String> = tx
            .query_row(
                "SELECT id FROM model_selections WHERE run_id=?1 AND active=1",
                [&run.id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let mut old: RunModelSelection = record(&tx, "model_selections", &old)?;
            old.status = RunModelSelectionStatus::Superseded;
            tx.execute(
                "UPDATE model_selections SET status='superseded',active=0,body=?2 WHERE id=?1",
                params![old.id, encode(&old)?],
            )?;
        }
        stored.status = RunModelSelectionStatus::Active;
        tx.execute(
            "UPDATE model_selections SET status='active',active=1,body=?2 WHERE id=?1",
            params![stored.id, encode(&stored)?],
        )?;
        run.configuration = serde_json::to_value(&stored.configuration)?;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        let mut launch: launches::LaunchIntent = record(&tx, "run_launches", &run.id)?;
        launch.selection.connection_identity = binding.connection_identity.clone();
        launch.selection.provider_family = binding.provider_family.clone();
        launch.selection.model = binding.model.clone();
        launch.selection.configuration_generation = binding.configuration_generation;
        launch.selection.credential_scope = stored.credential_scope;
        launch.revision += 1;
        put(&tx, "run_launches", &run.id, &launch)?;
        event(
            &tx,
            &run.id,
            run.revision,
            "run.model_activated",
            json!({"id":stored.id,"revision":stored.revision}),
        )?;
        tx.commit()?;
        Ok(true)
    }
}
