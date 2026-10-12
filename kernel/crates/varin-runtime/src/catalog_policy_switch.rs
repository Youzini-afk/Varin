//! One Catalog owns policy choice, candidate receipts, and the atomic decision-boundary cut.
//! Candidate code, state transformation, and immutable content preparation run outside its lock.
use super::launch_content::{LaunchMetadata, PolicyModelReference};
use super::*;
use crate::execution::{PolicyEvent, PolicyIdentity};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyStateTransition {
    Unsupported,
    Explicit,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPolicyArtifactBinding {
    pub provider_key: String,
    pub extension_id: String,
    pub extension_version: String,
    pub service_id: String,
    pub service_version: u64,
    pub artifact_integrity: String,
    pub composition: super::service_composition::HostServiceComposition,
    pub configuration_identity: String,
    pub declared_identity: PolicyIdentity,
    pub identity: PolicyIdentity,
    pub model_roles: Vec<String>,
    pub state_transition: PolicyStateTransition,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PolicyTarget {
    Default,
    Extension {
        artifact: AgentPolicyArtifactBinding,
    },
}
impl PolicyTarget {
    pub fn validate(&self) -> Result<()> {
        if let Self::Extension { artifact: a } = self {
            a.composition.validate_root(
                &a.extension_id,
                &a.extension_version,
                &a.artifact_integrity,
                &a.provider_key,
                &a.service_id,
                a.service_version,
            )?;
            if [
                &a.provider_key,
                &a.extension_id,
                &a.extension_version,
                &a.artifact_integrity,
                &a.declared_identity.name,
                &a.declared_identity.version,
                &a.identity.name,
                &a.identity.version,
            ]
            .iter()
            .any(|v| v.is_empty())
                || a.service_id != "varin.agent.policy"
                || a.service_version != 4
                || a.configuration_identity.is_empty()
                || a.model_roles.iter().any(|s| s != "agentPlanning")
                || a.model_roles.len() > 1
            {
                return Err(RuntimeError::Invalid(
                    "policy target requires an exact supported artifact".into(),
                ));
            }
        }
        Ok(())
    }
    pub fn identity(&self) -> PolicyIdentity {
        match self {
            Self::Default => PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            },
            Self::Extension { artifact } => artifact.identity.clone(),
        }
    }
    pub fn declared_identity(&self) -> Option<PolicyIdentity> {
        match self {
            Self::Default => None,
            Self::Extension { artifact } => Some(artifact.declared_identity.clone()),
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyPreparationFailure {
    PolicyPreparationFailed,
    PolicyPreparationCancelled,
    PolicyBindingRevoked,
}
impl PolicyPreparationFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::PolicyPreparationFailed => "policy_preparation_failed",
            Self::PolicyPreparationCancelled => "policy_preparation_cancelled",
            Self::PolicyBindingRevoked => "policy_binding_revoked",
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyStateMode {
    Preserve,
    RestartState,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicySelectionStatus {
    Preparing,
    Ready,
    Active,
    Failed,
    Superseded,
    Cancelled,
}
impl PolicySelectionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Active => "active",
            Self::Failed => "failed",
            Self::Superseded => "superseded",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicySelection {
    pub selection_id: String,
    pub run_id: String,
    pub generation: u64,
    pub expected_generation: u64,
    pub expected_selection_id: Option<String>,
    pub target: PolicyTarget,
    pub state_mode: PolicyStateMode,
    pub status: PolicySelectionStatus,
    pub failure: Option<String>,
    pub activation_cursor: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivePolicySelection {
    pub generation: u64,
    pub target: PolicyTarget,
    pub identity: PolicyIdentity,
    pub activation_cursor: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicySelections {
    pub active: ActivePolicySelection,
    pub desired: Option<PolicySelection>,
}
/// Small Catalog identity; graph and extension declaration bodies live in the existing ContentStore.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PolicyTargetMetadata {
    Default,
    Extension {
        provider_key: String,
        extension_id: String,
        extension_version: String,
        artifact_integrity: String,
        composition_root: String,
        configuration_identity: String,
        identity: PolicyIdentity,
        declared_identity: PolicyIdentity,
        model_roles: Vec<String>,
        state_transition: PolicyStateTransition,
        body: Value,
    },
}
impl PolicyTargetMetadata {
    fn from_target(target: &PolicyTarget, body: Value) -> Self {
        match target {
            PolicyTarget::Default => Self::Default,
            PolicyTarget::Extension { artifact: a } => Self::Extension {
                provider_key: a.provider_key.clone(),
                extension_id: a.extension_id.clone(),
                extension_version: a.extension_version.clone(),
                artifact_integrity: a.artifact_integrity.clone(),
                composition_root: a.composition.root.clone(),
                configuration_identity: a.configuration_identity.clone(),
                identity: a.identity.clone(),
                declared_identity: a.declared_identity.clone(),
                model_roles: a.model_roles.clone(),
                state_transition: a.state_transition,
                body,
            },
        }
    }
    pub(super) fn stage(
        content: &crate::content::ContentStore,
        target: PolicyTarget,
    ) -> Result<Self> {
        target.validate()?;
        if target == PolicyTarget::Default {
            return Ok(Self::Default);
        }
        let body = content.save(&serde_json::to_value(&target)?)?;
        Ok(Self::from_target(&target, body))
    }
    pub(super) fn load(&self, content: &crate::content::ContentStore) -> Result<PolicyTarget> {
        let Self::Extension { body, .. } = self else {
            return Ok(PolicyTarget::Default);
        };
        let target: PolicyTarget = serde_json::from_value(content.load(body)?)?;
        target.validate()?;
        if Self::from_target(&target, body.clone()) != *self {
            return Err(RuntimeError::Invalid(
                "policy body differs from its retained identity".into(),
            ));
        }
        Ok(target)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PolicySelectionMetadata {
    pub selection_id: String,
    pub run_id: String,
    pub generation: u64,
    pub expected_generation: u64,
    pub expected_selection_id: Option<String>,
    pub target: PolicyTargetMetadata,
    pub state_mode: PolicyStateMode,
    pub status: PolicySelectionStatus,
    pub failure: Option<String>,
    pub activation_cursor: Option<u64>,
}
impl PolicySelectionMetadata {
    fn load(self, content: &crate::content::ContentStore) -> Result<PolicySelection> {
        Ok(PolicySelection {
            target: self.target.load(content)?,
            selection_id: self.selection_id,
            run_id: self.run_id,
            generation: self.generation,
            expected_generation: self.expected_generation,
            expected_selection_id: self.expected_selection_id,
            state_mode: self.state_mode,
            status: self.status,
            failure: self.failure,
            activation_cursor: self.activation_cursor,
        })
    }
}
pub struct PolicySelectionRead {
    pub metadata: PolicySelectionMetadata,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PolicySelectionRead {
    fn new(metadata: PolicySelectionMetadata, content: &crate::content::ContentStore) -> Self {
        Self {
            metadata,
            content: content.clone(),
            _publication: content.begin_publication(),
        }
    }
    pub fn load(self) -> Result<PolicySelection> {
        self.metadata.load(&self.content)
    }
}
pub struct PolicySelectionsRead {
    active: (u64, PolicyTargetMetadata, PolicyIdentity, Option<u64>),
    desired: Option<PolicySelectionMetadata>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PolicySelectionsRead {
    pub fn desired_selection_id(&self) -> Option<&str> {
        self.desired
            .as_ref()
            .map(|value| value.selection_id.as_str())
    }
    pub fn load(self) -> Result<PolicySelections> {
        Ok(PolicySelections {
            active: ActivePolicySelection {
                generation: self.active.0,
                target: self.active.1.load(&self.content)?,
                identity: self.active.2,
                activation_cursor: self.active.3,
            },
            desired: self
                .desired
                .map(|value| value.load(&self.content))
                .transpose()?,
        })
    }
}
pub struct PolicySelectionPreparation {
    run_id: String,
    selection_id: String,
    expected_generation: u64,
    expected_selection_id: Option<String>,
    target: PolicyTarget,
    state_mode: PolicyStateMode,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedPolicySelection {
    run_id: String,
    selection_id: String,
    expected_generation: u64,
    expected_selection_id: Option<String>,
    target: PolicyTargetMetadata,
    state_mode: PolicyStateMode,
    epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl PolicySelectionPreparation {
    pub fn store(self) -> Result<PreparedPolicySelection> {
        Ok(PreparedPolicySelection {
            run_id: self.run_id,
            selection_id: self.selection_id,
            expected_generation: self.expected_generation,
            expected_selection_id: self.expected_selection_id,
            target: PolicyTargetMetadata::stage(&self.content, self.target)?,
            state_mode: self.state_mode,
            epoch: self.epoch,
            _publication: self.publication,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct PolicyCandidateMetadata {
    selection: PolicySelectionMetadata,
    identity: Option<PolicyIdentity>,
    models: Vec<PolicyModelReference>,
}
fn selection(db: &Connection, id: &str) -> Result<PolicyCandidateMetadata> {
    record(db, "policy_selections", id)
}
fn save(db: &Connection, candidate: &PolicyCandidateMetadata) -> Result<()> {
    db.execute(
        "UPDATE policy_selections SET status=?2,body=?3 WHERE id=?1",
        params![
            candidate.selection.selection_id,
            candidate.selection.status.as_str(),
            encode(candidate)?
        ],
    )?;
    Ok(())
}
fn latest(db: &Connection, run: &str) -> Result<Option<PolicyCandidateMetadata>> {
    db.query_row(
        "SELECT body FROM policy_selections WHERE run_id=?1 ORDER BY generation DESC LIMIT 1",
        [run],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|s| serde_json::from_str(&s).map_err(Into::into))
    .transpose()
}
fn active_cursor(db: &Connection, run: &str, generation: u64) -> Result<Option<u64>> {
    let cursor: Option<i64> = db
        .query_row(
            "SELECT json_extract(body,'$.selection.activation_cursor')
         FROM policy_selections WHERE run_id=?1 AND generation=?2",
            params![run, sql_number(generation)?],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    cursor
        .map(|value| {
            u64::try_from(value).map_err(|_| RuntimeError::Invalid("negative policy cursor".into()))
        })
        .transpose()
}

pub struct PolicyReadyPreparation {
    expected: PolicySelectionMetadata,
    identity: PolicyIdentity,
    models: Vec<crate::execution::PolicyModelCapability>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedPolicyReady {
    expected: PolicySelectionMetadata,
    identity: PolicyIdentity,
    models: Vec<PolicyModelReference>,
    _publication: crate::content::ContentPublication,
}
impl PolicyReadyPreparation {
    pub fn load(self) -> Result<PreparedPolicyReady> {
        Ok(PreparedPolicyReady {
            expected: self.expected,
            identity: self.identity,
            models: super::launch_content::stage_policy_models(&self.content, &self.models)?,
            _publication: self.publication,
        })
    }
}

/// An exact cut of the active policy's private checkpoint and core-owned continuation.
pub struct PolicyActivationPreparation {
    run: Run,
    launch: LaunchMetadata,
    candidate: PolicyCandidateMetadata,
    head: Option<String>,
    cursor: u64,
    checkpoint: Option<super::policy_checkpoint::PolicyCheckpointMetadata>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedPolicyActivation {
    captured: PolicyActivationPreparation,
    state_ref: Value,
    continuation_ref: Value,
}
impl PolicyActivationPreparation {
    pub fn previous_target(&self) -> Result<PolicyTarget> {
        self.launch.policy_target.load(&self.content)
    }
    pub fn state_mode(&self) -> PolicyStateMode {
        self.candidate.selection.state_mode
    }
    pub fn load(self, state: &Value, event: &PolicyEvent) -> Result<PreparedPolicyActivation> {
        let state_ref = self.content.save(state)?;
        let continuation_ref = self.content.save_policy_event(event)?;
        Ok(PreparedPolicyActivation {
            captured: self,
            state_ref,
            continuation_ref,
        })
    }
}
impl Catalog {
    pub fn policy_selection(&self, run_id: &str, id: &str) -> Result<PolicySelectionRead> {
        let c = selection(&self.db, id)?;
        if c.selection.run_id != run_id {
            return Err(RuntimeError::Conflict(
                "policy selection Run differs".into(),
            ));
        }
        Ok(PolicySelectionRead::new(c.selection, &self.content))
    }
    pub fn policy_selections(&self, run_id: &str) -> Result<PolicySelectionsRead> {
        self.run(run_id)?;
        let launch = self
            .launch_metadata(run_id)?
            .ok_or_else(|| RuntimeError::NotFound("policy launch".into()))?;
        Ok(PolicySelectionsRead {
            active: (
                launch.policy_generation,
                launch.policy_target,
                launch.selection.policy,
                active_cursor(&self.db, run_id, launch.policy_generation)?,
            ),
            desired: latest(&self.db, run_id)?.map(|value| value.selection),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn prepare_policy_selection(
        &self,
        run_id: &str,
        selection_id: &str,
        expected_generation: u64,
        expected_selection_id: Option<String>,
        target: PolicyTarget,
        state_mode: PolicyStateMode,
    ) -> Result<PolicySelectionPreparation> {
        self.run(run_id)?;
        Ok(PolicySelectionPreparation {
            run_id: run_id.into(),
            selection_id: selection_id.into(),
            expected_generation,
            expected_selection_id,
            target,
            state_mode,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn publish_policy_selection(
        &mut self,
        prepared: PreparedPolicySelection,
    ) -> Result<PolicySelectionRead> {
        let PreparedPolicySelection {
            run_id,
            selection_id,
            expected_generation,
            expected_selection_id,
            target,
            state_mode,
            epoch,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "policy selection epoch changed".into(),
            ));
        }
        let run_id = run_id.as_str();
        let selection_id = selection_id.as_str();
        if selection_id.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "policy selection identity is required".into(),
            ));
        }
        let tx = self.db.transaction()?;
        if let Some(previous) =
            optional_record::<PolicyCandidateMetadata>(&tx, "policy_selections", selection_id)?
        {
            let p = previous.selection;
            if p.run_id == run_id
                && p.expected_generation == expected_generation
                && p.expected_selection_id == expected_selection_id
                && p.target == target
                && p.state_mode == state_mode
            {
                return Ok(PolicySelectionRead::new(p, &self.content));
            }
            return Err(RuntimeError::Conflict(
                "policy selection identity was used for another intent".into(),
            ));
        }
        let mut run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        let launch: LaunchMetadata = record(&tx, "run_launches", run_id)?;
        // Ordinary child Runs participate in the same closed decision boundary. Only internal
        // compaction retains a fixed policy; child capability delegation is a separate authority.
        let fixed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM context_jobs WHERE run_id=?1)",
            [run_id],
            |row| row.get(0),
        )?;
        if run.cancel_requested
            || fixed
            || launch.policy_generation != expected_generation
            || latest(&tx, run_id)?
                .as_ref()
                .map(|c| &c.selection.selection_id)
                != expected_selection_id.as_ref()
        {
            return Err(RuntimeError::Conflict(
                "policy selection active generation changed or Run has a fixed policy".into(),
            ));
        }
        let generation: u64 = tx.query_row(
            "SELECT coalesce(max(generation),0)+1 FROM policy_selections WHERE run_id=?1",
            [run_id],
            |r| read_number(r, 0),
        )?;
        if let Some(mut previous) = latest(&tx, run_id)? {
            if matches!(
                previous.selection.status,
                PolicySelectionStatus::Preparing | PolicySelectionStatus::Ready
            ) {
                previous.selection.status = PolicySelectionStatus::Superseded;
                save(&tx, &previous)?;
            }
        }
        let candidate = PolicyCandidateMetadata {
            selection: PolicySelectionMetadata {
                selection_id: selection_id.into(),
                run_id: run_id.into(),
                generation,
                expected_generation,
                expected_selection_id,
                target,
                state_mode,
                status: PolicySelectionStatus::Preparing,
                failure: None,
                activation_cursor: None,
            },
            identity: None,
            models: Vec::new(),
        };
        tx.execute("INSERT INTO policy_selections(id,run_id,generation,status,body) VALUES(?1,?2,?3,?4,?5)",
            params![selection_id, run_id, sql_number(generation)?, candidate.selection.status.as_str(), encode(&candidate)?])?;
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        event(
            &tx,
            run_id,
            run.revision,
            "policy.selected",
            json!({"selection_id":selection_id,"generation":generation}),
        )?;
        tx.commit()?;
        Ok(PolicySelectionRead::new(candidate.selection, &self.content))
    }
    pub fn prepare_policy_ready(
        &self,
        run_id: &str,
        selection_id: &str,
        generation: u64,
        identity: PolicyIdentity,
        models: Vec<crate::execution::PolicyModelCapability>,
    ) -> Result<PolicyReadyPreparation> {
        let candidate = selection(&self.db, selection_id)?;
        let roles = match &candidate.selection.target {
            PolicyTargetMetadata::Default => Vec::new(),
            PolicyTargetMetadata::Extension { model_roles, .. } => model_roles.clone(),
        };
        if models
            .iter()
            .map(|m| m.capability_id.clone())
            .collect::<Vec<_>>()
            != roles
        {
            return Err(RuntimeError::Conflict(
                "planning capabilities differ from selected policy roles".into(),
            ));
        }
        if candidate.selection.run_id != run_id
            || candidate.selection.generation != generation
            || identity.name.is_empty()
            || identity.version.is_empty()
        {
            return Err(RuntimeError::Conflict(
                "policy ready binding differs from selection".into(),
            ));
        }
        Ok(PolicyReadyPreparation {
            expected: candidate.selection,
            identity,
            models,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn publish_policy_ready(
        &mut self,
        prepared: PreparedPolicyReady,
    ) -> Result<PolicySelectionRead> {
        let tx = self.db.transaction()?;
        let mut candidate = selection(&tx, &prepared.expected.selection_id)?;
        let mut run: Run = record(&tx, "runs", &candidate.selection.run_id)?;
        if candidate.selection.target != prepared.expected.target
            || candidate.selection.generation != prepared.expected.generation
        {
            return Err(RuntimeError::Conflict("policy ready intent changed".into()));
        }
        if matches!(
            candidate.selection.status,
            PolicySelectionStatus::Ready | PolicySelectionStatus::Active
        ) {
            if candidate.identity.as_ref() != Some(&prepared.identity)
                || candidate.models != prepared.models
            {
                return Err(RuntimeError::Conflict(
                    "policy ready content changed".into(),
                ));
            }
            return Ok(PolicySelectionRead::new(candidate.selection, &self.content));
        }
        if candidate.selection.status != PolicySelectionStatus::Preparing {
            return Ok(PolicySelectionRead::new(candidate.selection, &self.content));
        }
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Ok(PolicySelectionRead::new(candidate.selection, &self.content));
        }
        candidate.identity = Some(prepared.identity);
        candidate.models = prepared.models;
        candidate.selection.status = PolicySelectionStatus::Ready;
        save(&tx, &candidate)?;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        event(
            &tx,
            &run.id,
            run.revision,
            "policy.ready",
            json!({"selection_id":candidate.selection.selection_id,"generation":candidate.selection.generation}),
        )?;
        tx.commit()?;
        Ok(PolicySelectionRead::new(candidate.selection, &self.content))
    }
    pub fn fail_policy_selection(
        &mut self,
        run_id: &str,
        selection_id: &str,
        code: &str,
    ) -> Result<PolicySelectionRead> {
        if code.trim().is_empty() {
            return Err(RuntimeError::Invalid("policy failure code required".into()));
        }
        self.end_policy_selection(run_id, selection_id, Some(code.into()))
    }
    pub fn cancel_policy_selection(
        &mut self,
        run_id: &str,
        selection_id: &str,
    ) -> Result<PolicySelectionRead> {
        self.end_policy_selection(run_id, selection_id, None)
    }
    fn end_policy_selection(
        &mut self,
        run_id: &str,
        selection_id: &str,
        failure: Option<String>,
    ) -> Result<PolicySelectionRead> {
        let tx = self.db.transaction()?;
        let mut candidate = selection(&tx, selection_id)?;
        if candidate.selection.run_id != run_id {
            return Err(RuntimeError::Conflict(
                "policy candidate Run changed".into(),
            ));
        }
        if !matches!(
            candidate.selection.status,
            PolicySelectionStatus::Preparing | PolicySelectionStatus::Ready
        ) {
            return Ok(PolicySelectionRead::new(candidate.selection, &self.content));
        }
        let mut run: Run = record(&tx, "runs", run_id)?;
        candidate.selection.status = if failure.is_some() {
            PolicySelectionStatus::Failed
        } else {
            PolicySelectionStatus::Cancelled
        };
        candidate.selection.failure = failure;
        save(&tx, &candidate)?;
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        event(
            &tx,
            run_id,
            run.revision,
            "policy.preparation_ended",
            json!({"selection_id":selection_id,"status":candidate.selection.status,"failure":candidate.selection.failure}),
        )?;
        tx.commit()?;
        Ok(PolicySelectionRead::new(candidate.selection, &self.content))
    }
    pub fn capture_policy_activation(
        &self,
        run_id: &str,
        epoch: u64,
        selection_id: &str,
        generation: u64,
    ) -> Result<Option<PolicyActivationPreparation>> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let launch = self
            .launch_metadata(run_id)?
            .ok_or_else(|| RuntimeError::NotFound("policy launch".into()))?;
        let candidate = selection(&self.db, selection_id)?;
        if candidate.selection.run_id != run_id || candidate.selection.generation != generation {
            return Err(RuntimeError::Conflict(
                "policy candidate generation changed".into(),
            ));
        }
        if candidate.selection.status != PolicySelectionStatus::Ready
            || candidate.selection.expected_generation != launch.policy_generation
            || run.cancel_requested
        {
            return Ok(None);
        }
        if !policy_cut_closed(&self.db, &run)? {
            return Ok(None);
        }
        Ok(Some(PolicyActivationPreparation {
            head: self.head(&run.branch_id)?,
            cursor: policy_cut_cursor(&self.db, run_id)?,
            checkpoint: super::policy_checkpoint::metadata(&self.db, run_id)?,
            run,
            launch,
            candidate,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }))
    }
    pub fn activate_policy(
        &mut self,
        prepared: PreparedPolicyActivation,
    ) -> Result<Option<PolicySelectionRead>> {
        let PreparedPolicyActivation {
            captured: c,
            state_ref,
            continuation_ref,
        } = prepared;
        let tx = self.db.transaction()?;
        let mut candidate = selection(&tx, &c.candidate.selection.selection_id)?;
        if candidate.selection.status == PolicySelectionStatus::Active {
            return Ok(Some(PolicySelectionRead::new(
                candidate.selection,
                &self.content,
            )));
        }
        let mut run: Run = record(&tx, "runs", &c.run.id)?;
        fence(&run, c.run.epoch)?;
        let mut launch: LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        let head: Option<String> = tx.query_row(
            "SELECT head FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| r.get(0),
        )?;
        if candidate != c.candidate
            || launch != c.launch
            || run.cancel_requested
            || head != c.head
            || policy_cut_cursor(&tx, &run.id)? != c.cursor
            || super::policy_checkpoint::metadata(&tx, &run.id)? != c.checkpoint
            || !policy_cut_closed(&tx, &run)?
        {
            return Ok(None);
        }
        let previous_id: Option<String> = tx
            .query_row(
                "SELECT id FROM policy_selections WHERE run_id=?1 AND generation=?2",
                params![run.id, sql_number(launch.policy_generation)?],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous_id) = previous_id {
            let mut previous = selection(&tx, &previous_id)?;
            previous.selection.status = PolicySelectionStatus::Superseded;
            save(&tx, &previous)?;
        }
        launch.policy_generation = candidate.selection.generation;
        launch.policy_target = candidate.selection.target.clone();
        launch.selection.policy = candidate
            .identity
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("ready policy identity missing".into()))?;
        launch.selection.policy_models = candidate.models.clone();
        launch.revision += 1;
        put(&tx, "run_launches", &run.id, &launch)?;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        let cursor = event(
            &tx,
            &run.id,
            run.revision,
            "policy.activated",
            json!({"selection_id":candidate.selection.selection_id,"generation":candidate.selection.generation,"identity":launch.selection.policy}),
        )?;
        super::policy_checkpoint::publish_activation(
            &tx,
            &run.id,
            &launch.selection.policy,
            &state_ref,
            &continuation_ref,
            cursor,
        )?;
        candidate.selection.status = PolicySelectionStatus::Active;
        candidate.selection.activation_cursor = Some(cursor);
        save(&tx, &candidate)?;
        tx.commit()?;
        Ok(Some(PolicySelectionRead::new(
            candidate.selection,
            &self.content,
        )))
    }
}
fn policy_cut_cursor(db: &Connection, run: &str) -> Result<u64> {
    Ok(db.query_row(
        "SELECT coalesce(max(cursor),0) FROM events
         WHERE subject=?1 AND kind IN ('execution.committed','input.delivered','policy.activated','policy.resumed')
         OR subject IN (SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind')
             IN ('policy_tool_graph_v1','policy_model_job_v1','policy_deliver_v1','policy_pause_v1'))",
        [run], |row| read_number(row, 0),
    )?)
}
fn policy_cut_closed(db: &Connection, run: &Run) -> Result<bool> {
    if run.cancel_requested || run.state == RunState::Waiting {
        return Ok(false);
    }
    let (thread, active): (String, Option<String>) = db.query_row(
        "SELECT thread_id,active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if thread != run.thread_id || active.as_deref() != Some(&run.id) {
        return Ok(false);
    }
    if super::inputs::has_boundary_inputs(db, &run.id)?
        || super::policy_body::has_pending_action(db, &run.id)?
    {
        return Ok(false);
    }
    let unresolved: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state NOT IN ('completed','not_dispatched')
             AND json_extract(body,'$.superseded_by_input') IS NULL)
         OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id
             WHERE m.run_id=?1 AND c.committed=0)",
        [&run.id],
        |row| row.get(0),
    )?;
    if unresolved {
        return Ok(false);
    }
    let waiting: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM waits WHERE run_id=?1
             AND json_extract(body,'$.cancelled')=0 AND json_extract(body,'$.trigger_cursor') IS NULL)",
        [&run.id], |row| row.get(0),
    )?;
    if waiting {
        return Ok(false);
    }
    if let Some(saved) = super::policy_checkpoint::metadata(db, &run.id)? {
        if saved.pending(db, &run.id)? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn action_precedes_activation(db: &Connection, run: &str, action: &str) -> Result<bool> {
    let Some(cursor) =
        super::policy_checkpoint::metadata(db, run)?.and_then(|m| m.activation_cursor)
    else {
        return Ok(false);
    };
    let admitted: u64 = db.query_row(
        "SELECT coalesce(min(cursor),0) FROM events WHERE subject=?1",
        [action],
        |r| read_number(r, 0),
    )?;
    Ok(admitted < cursor)
}

pub(crate) fn interrupt_candidates(tx: &Transaction<'_>) -> Result<()> {
    let candidates: Vec<PolicyCandidateMetadata> = {
        let mut statement=tx.prepare("SELECT body FROM policy_selections WHERE json_extract(body,'$.selection.status') IN ('preparing','ready')")?;
        let values = statement
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        values
            .into_iter()
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .collect::<Result<_>>()?
    };
    for mut c in candidates {
        c.selection.status = PolicySelectionStatus::Failed;
        c.selection.failure = Some("policy_preparation_interrupted".into());
        save(tx, &c)?;
        let run: Run = record(tx, "runs", &c.selection.run_id)?;
        event(
            tx,
            &run.id,
            run.revision,
            "policy.preparation_ended",
            json!({"selection_id":c.selection.selection_id,"status":c.selection.status,"failure":c.selection.failure}),
        )?;
    }
    Ok(())
}

/// Called by the existing terminal writers in their transaction, before live pins are released.
pub(crate) fn close_run_candidate(tx: &Transaction<'_>, run: &str, revision: u64) -> Result<()> {
    if let Some(mut candidate) = latest(tx, run)? {
        if matches!(
            candidate.selection.status,
            PolicySelectionStatus::Preparing | PolicySelectionStatus::Ready
        ) {
            candidate.selection.status = PolicySelectionStatus::Cancelled;
            save(tx, &candidate)?;
            event(
                tx,
                run,
                revision,
                "policy.preparation_ended",
                json!({"selection_id":candidate.selection.selection_id,"status":candidate.selection.status,"failure":null}),
            )?;
        }
    }
    Ok(())
}
