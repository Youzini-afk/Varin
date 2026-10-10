//! Durable launch intent. Live grants and credential material never enter this domain.
use super::launch_content::{
    LaunchMetadata, LaunchRead, PreparedLaunchChange, PreparedLaunchSelection,
};
use super::*;
use crate::execution::policy_model::{PolicyModelCapability, PolicyModelStatus};
use crate::execution::{PolicyIdentity, RequestBinding, ToolSchema};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceSelection {
    #[serde(default)]
    pub environment_run_id: Option<String>,
    pub mode: crate::SourceMode,
    #[serde(deserialize_with = "required_live_root")]
    pub live_root: Option<LiveRoot>,
    pub workspace_id: String,
    pub execution_workspace_id: String,
    pub branch_id: Option<String>,
    pub revision: Option<u64>,
}
/// Identity, not authority: the Host must reacquire a fresh Documents/Rust binding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveRoot {
    pub host_id: String,
    pub canonical_root: String,
    pub root_id: String,
}
fn required_live_root<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<LiveRoot>, D::Error> {
    Option::<LiveRoot>::deserialize(deserializer)
}
impl SourceSelection {
    pub fn validate(&self) -> Result<()> {
        let fixed =
            self.branch_id.as_deref().is_some_and(|id| !id.is_empty()) && self.revision.is_some();
        let live = self.live_root.as_ref().is_some_and(|root| {
            !root.host_id.is_empty() && !root.root_id.is_empty() && !root.canonical_root.is_empty()
        });
        if self.workspace_id.is_empty()
            || self.execution_workspace_id.is_empty()
            || match self.mode {
                crate::SourceMode::LiveRoot => {
                    !live
                        || self.branch_id.is_some()
                        || self.revision.is_some()
                        || self.environment_run_id.is_some()
                }
                crate::SourceMode::FixedBranch => {
                    !fixed || self.live_root.is_some() || self.environment_run_id.is_some()
                }
                crate::SourceMode::Materialized => !fixed || self.live_root.is_some(),
            }
        {
            return Err(RuntimeError::Invalid(
                "launch source requires an exact fixed revision or explicit live root identity"
                    .into(),
            ));
        }
        Ok(())
    }
}
/// Credential-free retained Host MCP generation, frozen before any model request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct McpConfiguration {
    pub agent_dir: String,
    pub config_cwd: String,
    pub project_trusted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct McpServerSelection {
    pub definition_version: String,
    pub resource_key: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpExecutionScope {
    Global,
    Workspace,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct McpProvenance {
    pub configuration: McpConfiguration,
    pub execution_scope: McpExecutionScope,
    pub servers: std::collections::BTreeMap<String, McpServerSelection>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HostToolBinding {
    pub reference: String,
    pub generation: u64,
    pub tools: Vec<ToolSchema>,
    pub resources: std::collections::BTreeMap<String, String>,
    pub provenance: McpProvenance,
}
impl HostToolBinding {
    pub fn validate(&self) -> Result<()> {
        let mut names = std::collections::BTreeSet::new();
        if self.reference.is_empty()
            || self.provenance.configuration.agent_dir.is_empty()
            || self.provenance.configuration.config_cwd.is_empty()
            || self.provenance.servers.iter().any(|(name, server)| {
                name.is_empty()
                    || server.definition_version.is_empty()
                    || server.resource_key.is_empty()
                    || self.resources.get(&format!("server:{name}")) != Some(&server.resource_key)
            })
            || self.resources.iter().any(|(name, key)| {
                name.is_empty()
                    || key.is_empty()
                    || !self
                        .provenance
                        .servers
                        .values()
                        .any(|server| &server.resource_key == key)
                    || (!name.starts_with("server:")
                        && !self.tools.iter().any(|tool| &tool.name == name))
                    || name.strip_prefix("server:").is_some_and(|server| {
                        self.provenance
                            .servers
                            .get(server)
                            .is_none_or(|selected| &selected.resource_key != key)
                    })
            })
            || self.tools.iter().any(|tool| {
                tool.name.is_empty()
                    || tool.version.is_empty()
                    || !(tool.schema.is_object() || tool.schema.is_boolean())
                    || !names.insert(&tool.name)
                    || (!matches!(tool.name.as_str(), "mcp_call" | "mcp_discover")
                        && !self.resources.contains_key(&tool.name))
            })
        {
            return Err(RuntimeError::Invalid(
                "MCP binding requires unique frozen tool identities".into(),
            ));
        }
        Ok(())
    }
    /// Select descriptions from the original owner. The result is preparation intent only;
    /// a child must derive its own execution binding through the existing MCP authority.
    pub fn delegate(&self, names: &[String]) -> Option<Self> {
        let tools: Vec<_> = self
            .tools
            .iter()
            .filter(|tool| names.contains(&tool.name))
            .cloned()
            .collect();
        if tools.is_empty() {
            return None;
        }
        let gateway = tools
            .iter()
            .any(|tool| matches!(tool.name.as_str(), "mcp_call" | "mcp_discover"));
        let mut selected = self.clone();
        selected.provenance.servers.retain(|_, server| {
            gateway
                || tools
                    .iter()
                    .any(|tool| self.resources.get(&tool.name) == Some(&server.resource_key))
        });
        selected.resources.retain(|name, _| {
            tools.iter().any(|tool| &tool.name == name)
                || name
                    .strip_prefix("server:")
                    .is_some_and(|server| selected.provenance.servers.contains_key(server))
        });
        selected.tools = tools;
        Some(selected)
    }
    pub fn derives_from(&self, original: &Self) -> bool {
        self.tools == original.tools
            && self.provenance.configuration == original.provenance.configuration
            && self.provenance.execution_scope == original.provenance.execution_scope
            && self.provenance.servers.len() == original.provenance.servers.len()
            && self.provenance.servers.iter().all(|(name, server)| {
                original
                    .provenance
                    .servers
                    .get(name)
                    .is_some_and(|old| old.definition_version == server.definition_version)
            })
            && self.resources.len() == original.resources.len()
            && self.resources.iter().all(|(name, key)| {
                original.resources.get(name).is_some_and(|old_key| {
                    self.provenance.servers.iter().any(|(server, selected)| {
                        &selected.resource_key == key
                            && original
                                .provenance
                                .servers
                                .get(server)
                                .is_some_and(|old| &old.resource_key == old_key)
                    })
                })
            })
    }
}
/// Exact ordinary service artifact and declaration; this identity grants no live authority.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExtensionToolBinding {
    pub provider_key: String,
    pub extension_id: String,
    pub extension_version: String,
    pub service_id: String,
    pub service_version: u64,
    pub artifact_integrity: String,
    pub declaration_hash: String,
    #[serde(deserialize_with = "required_configuration_identity")]
    pub configuration_identity: Option<String>,
    pub tool: ToolSchema,
}
fn required_configuration_identity<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
impl ExtensionToolBinding {
    pub fn validate(&self) -> Result<()> {
        if [
            &self.provider_key,
            &self.extension_id,
            &self.extension_version,
            &self.service_id,
            &self.artifact_integrity,
            &self.declaration_hash,
            &self.tool.name,
            &self.tool.version,
        ]
        .iter()
        .any(|s| s.is_empty())
            || self
                .configuration_identity
                .as_ref()
                .is_some_and(|s| s.is_empty())
            || self.tool.version != self.declaration_hash
            || self.tool.description.is_empty()
            || self.tool.metadata.as_ref().is_none_or(|m| {
                m.service_id != self.service_id || m.service_version != self.service_version
            })
            || !(self.tool.schema.is_object() || self.tool.schema.is_boolean())
        {
            return Err(RuntimeError::Invalid(
                "extension tool requires an exact service declaration and artifact".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LaunchSelection {
    pub child_dispatch: Option<super::dispatch::ChildDispatchCatalog>,
    pub extension_bindings: Vec<ExtensionToolBinding>,
    #[serde(default)]
    pub policy_models: Vec<PolicyModelCapability>,
    #[serde(default)]
    pub mcp_binding: Option<HostToolBinding>,
    #[serde(default)]
    pub credential_scope: Option<crate::providers::auth::CredentialScope>,
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
            child_dispatch: None,
            extension_bindings: Vec::new(),
            policy_models: Vec::new(),
            mcp_binding: None,
            credential_scope: None,
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
    pub(super) fn validate(&self) -> Result<()> {
        if let Some(catalog) = &self.child_dispatch { catalog.validate()?; }
        validate_policy_models(&self.policy_models)?;
        let mut tools = std::collections::BTreeMap::new();
        if self.tools.iter().any(|tool| {
            tool.name.is_empty()
                || tool.version.is_empty()
                || tools.insert(tool.name.as_str(), tool).is_some()
        }) {
            return Err(RuntimeError::Invalid(
                "launch tool identities must be unique and versioned".into(),
            ));
        }
        if let Some(binding) = &self.mcp_binding {
            binding.validate()?;
            if binding
                .tools
                .iter()
                .any(|tool| tools.get(tool.name.as_str()).copied() != Some(tool))
            {
                return Err(RuntimeError::Invalid(
                    "MCP launch schemas do not match retained owner".into(),
                ));
            }
        }
        let mut providers = std::collections::BTreeSet::new();
        for binding in &self.extension_bindings {
            binding.validate()?;
            if !providers.insert(&binding.provider_key)
                || tools.get(binding.tool.name.as_str()).copied() != Some(&binding.tool)
                || self
                    .mcp_binding
                    .as_ref()
                    .is_some_and(|m| m.tools.iter().any(|t| t.name == binding.tool.name))
            {
                return Err(RuntimeError::Invalid(
                    "extension launch schemas differ from retained services".into(),
                ));
            }
        }
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
        if let Some(source) = &self.source {
            source.validate()?;
        }
        Ok(())
    }
}

pub(super) fn validate_policy_models(models: &[PolicyModelCapability]) -> Result<()> {
    let mut ids = std::collections::BTreeSet::new();
    let mut credential_bindings = std::collections::BTreeSet::new();
    for model in models {
        if model.capability_id.trim().is_empty()
            || !ids.insert(&model.capability_id)
            || model.purpose != "planning"
            || model.supported_operation != "tool_free_text"
        {
            return Err(RuntimeError::Invalid(
                "planning capabilities require distinct explicit identities".into(),
            ));
        }
        if model.status != PolicyModelStatus::Available {
            if model.binding_id.is_some()
                || model.configuration_identity.is_some()
                || model.binding.is_some()
                || model.configuration.is_some()
                || model.credential_scope.is_some()
            {
                return Err(RuntimeError::Invalid(
                    "unavailable planning capability cannot retain executable authority".into(),
                ));
            }
            continue;
        }
        let (
            Some(binding_id),
            Some(configuration_identity),
            Some(binding),
            Some(configuration),
            Some(scope),
        ) = (
            &model.binding_id,
            &model.configuration_identity,
            &model.binding,
            &model.configuration,
            &model.credential_scope,
        )
        else {
            return Err(RuntimeError::Invalid(
                "available planning capability is incomplete".into(),
            ));
        };
        if binding_id.trim().is_empty()
            || !credential_bindings.insert(binding_id)
            || configuration_identity.trim().is_empty()
        {
            return Err(RuntimeError::Invalid(
                "planning capabilities require distinct credential bindings".into(),
            ));
        }
        let connection = crate::model_session::connection_identity_with_scope(configuration, scope)
            .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        if binding.connection_identity != connection
            || binding.provider_family != configuration.provider_family
            || binding.model != configuration.model
            || binding.configuration_generation != configuration.configuration_generation
            || binding.credential_ref.as_deref() != Some(scope.reference.as_str())
            || !binding.tools.is_empty()
            || binding.tool_schema_generation != 0
            || !binding.instruction_sources.is_empty()
            || binding.memory_checkpoint.is_some()
            || !binding.attachment_refs.is_empty()
            || binding.environment_cursor != 0
            || !binding.history_range.branch_id.is_empty()
            || binding.history_range.ancestor_id.is_some()
            || binding.history_range.leaf_id.is_some()
        {
            return Err(RuntimeError::Invalid(
                "planning model binding differs from its frozen tool-free selection".into(),
            ));
        }
    }
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LaunchIntent {
    pub policy_generation: u64,
    pub policy_target: super::policy_switch::PolicyTarget,
    pub startable: bool,
    pub policy_preparable: bool,
    pub pause: Option<super::policy_control::PolicyPauseInfo>,
    #[serde(default)]
    pub preparation_failure: Option<String>,
    pub run_id: String,
    pub revision: u64,
    pub selection: LaunchSelection,
    /// Only an owner epoch, never a reusable permit. The Host must reconstruct all live bindings.
    pub bound_epoch: Option<u64>,
    pub requires_rebind: bool,
}

/// Read-only preflight before catalog setup, epoch advancement or recovery mutates an existing catalog.
pub(super) fn check_format(db: &Connection) -> Result<()> {
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='run_launches'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let columns: Vec<(String, String, i64, i64)> = {
        let mut statement = db.prepare("PRAGMA table_info(run_launches)")?;
        let rows = statement.query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let table_type: Option<String> = db
        .query_row(
            "SELECT type FROM sqlite_master WHERE name='run_launches'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let foreign_keys: Vec<(String, String, String, String, String)> = {
        let mut statement = db.prepare("PRAGMA foreign_key_list(run_launches)")?;
        let rows = statement.query_map([], |r| {
            Ok((r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    if table_type.as_deref() != Some("table")
        || foreign_keys
            != vec![(
                "runs".into(),
                "id".into(),
                "id".into(),
                "NO ACTION".into(),
                "NO ACTION".into(),
            )]
        || version != Some(3)
        || columns
            != vec![
                ("id".into(), "TEXT".into(), 0, 1),
                ("body".into(), "TEXT".into(), 1, 0),
            ]
    {
        return Err(RuntimeError::Invalid(
            "unsupported or malformed launch domain; user data was preserved".into(),
        ));
    }
    Ok(())
}
pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
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
        None if existing.is_none() => tx.execute_batch("CREATE TABLE run_launches(id TEXT PRIMARY KEY REFERENCES runs(id),body TEXT NOT NULL); INSERT INTO runtime_domains(name,version) VALUES('run_launches',3);")?,
        Some(3) if existing.as_deref() == Some("table") => check_format(tx)?,
        _ => return Err(RuntimeError::Invalid("unrecognized launch domain; data preserved".into())),
    }
    Ok(())
}
impl Catalog {
    /// The preparation binds the exact admitted policy baseline; private state is not migrated.
    pub fn admit_launch_change(&mut self, prepared: PreparedLaunchChange) -> Result<LaunchRead> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "launch preparation belongs to a previous owner".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let run_id = &prepared.expected.run_id;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        let mut launch: LaunchMetadata = record(&tx, "run_launches", run_id)?;
        launch.requires_rebind = launch.bound_epoch != Some(self.epoch);
        if launch.selection == prepared.selection && launch.policy_target == prepared.policy_target
        {
            drop(tx);
            return self.launch_read(launch);
        }
        if launch != prepared.expected {
            return Err(RuntimeError::Conflict(
                "launch changed during preparation".into(),
            ));
        }
        let steps: i64 = tx.query_row(
            "SELECT count(*) FROM model_steps WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )?;
        let checkpoints: i64 = tx.query_row(
            "SELECT count(*) FROM policy_checkpoints WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )?;
        if run.cancel_requested
            || run.state.terminal()
            || launch.bound_epoch.is_some()
            || steps != 0
            || (prepared.kind == "run.policy_prepared"
                && (!policy_preparable(&tx, &run, &launch)?
                    || checkpoints != 0
                    || !launch.selection.policy_models.is_empty()
                    || launch.selection.policy == prepared.selection.policy))
        {
            return Err(RuntimeError::Conflict(
                "preparation cannot replace a selected or used launch".into(),
            ));
        }
        launch.selection = prepared.selection;
        launch.policy_target = prepared.policy_target;
        launch.revision += 1;
        put(&tx, "run_launches", run_id, &launch)?;
        event(
            &tx,
            run_id,
            launch.revision,
            prepared.kind,
            serde_json::to_value(&launch)?,
        )?;
        tx.commit()?;
        self.launch_read(launch)
    }

    /// Preparation can append one concrete MCP generation only before the launch is bound or used.
    /// It cannot revise a source, model, base capability, or an already frozen tool description.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn prepare_mcp_launch(
        &mut self,
        run_id: &str,
        binding: HostToolBinding,
    ) -> Result<LaunchIntent> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_mcp_change(run_id, binding)?.load()?;
        self.admit_launch_change(prepared)?.load()
    }

    /// Standalone Catalog convenience; concurrent owners use prepare_launch_selection/admit_launch.
    /// Store the selected plan before starting a worker. Retries can only rebind the same plan.
    /// Durable intent is not proof of authorization or worker liveness.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn bind_launch(
        &mut self,
        run_id: &str,
        selection: LaunchSelection,
    ) -> Result<LaunchIntent> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_launch_selection(selection).load()?;
        self.admit_launch(run_id, prepared, true)?.load()
    }
    /// Durable selection precedes expensive preparation. It conveys no live execution permit.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn select_launch(
        &mut self,
        run_id: &str,
        selection: LaunchSelection,
    ) -> Result<LaunchIntent> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_launch_selection(selection).load()?;
        self.admit_launch(run_id, prepared, false)?.load()
    }
    pub fn admit_launch(
        &mut self,
        run_id: &str,
        prepared: PreparedLaunchSelection,
        bound: bool,
    ) -> Result<LaunchRead> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "launch belongs to a previous owner".into(),
            ));
        }
        let selection = prepared.selection;
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::Conflict(
                "Run cancellation is closing launch admission".into(),
            ));
        }
        if let Some(source) = selection.source.as_ref() {
            if let Some(origin_id) = source.environment_run_id.as_ref() {
                let origin_run: Run = record(&tx, "runs", origin_id)?;
                let origin: LaunchMetadata = record(&tx, "run_launches", origin_id)?;
                let mut same_source = source.clone();
                same_source.environment_run_id = None;
                if origin_run.thread_id != run.thread_id
                    || source.mode != crate::SourceMode::Materialized
                    || origin.selection.source.as_ref() != Some(&same_source)
                {
                    return Err(RuntimeError::Conflict(
                        "environment continuation must preserve the original thread source".into(),
                    ));
                }
            }
        }
        let previous: Option<LaunchMetadata> = optional_record(&tx, "run_launches", run_id)?;
        let intent = match previous {
            Some(mut intent) => {
                if intent.selection != selection {
                    return Err(RuntimeError::Conflict(
                        "launch selection changed; rebind must preserve its frozen identity".into(),
                    ));
                }
                if !bound
                    || (intent.bound_epoch == Some(self.epoch)
                        && intent.preparation_failure.is_none())
                {
                    intent.requires_rebind = intent.bound_epoch != Some(self.epoch);
                    drop(tx);
                    return self.launch_read(intent);
                }
                intent.revision += 1;
                intent.preparation_failure = None;
                intent.bound_epoch = Some(self.epoch);
                intent.requires_rebind = false;
                put(&tx, "run_launches", run_id, &intent)?;
                intent
            }
            None => {
                let intent = LaunchMetadata {
                    dispatch_context_ref: None,
                    policy_generation: 0,
                    policy_target: super::policy_switch::PolicyTarget::Default,
                    preparation_failure: None,
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
        if bound && run.state == RunState::Waiting {
            if let Some(wait_id) = run.waiting_on.clone() {
                let mut wait: Wait = record(&tx, "waits", &wait_id)?;
                if wait.kind == "launch.prepared" {
                    wait.cancelled = true;
                    put(&tx, "waits", &wait_id, &wait)?;
                    run.state = RunState::Runnable;
                    run.waiting_on = None;
                    run.revision += 1;
                    put(&tx, "runs", run_id, &run)?;
                    event(&tx, run_id, run.revision, "run.prepared", Value::Null)?;
                }
            }
        }
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
        self.launch_read(intent)
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn fail_launch(&mut self, run_id: &str, code: &str) -> Result<LaunchIntent> {
        let _synchronous = self.content.begin_synchronous()?;
        let metadata = self.fail_launch_metadata(run_id, code)?;
        self.launch_read(metadata)?.load()
    }
    pub fn fail_launch_metadata(&mut self, run_id: &str, code: &str) -> Result<LaunchMetadata> {
        if !matches!(
            code,
            "preparation_failed"
                | "source_unavailable"
                | "credentials_unavailable"
                | "binding_changed"
        ) {
            return Err(RuntimeError::Invalid(
                "unknown preparation failure code".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested
            || !matches!(
                run.state,
                RunState::Accepted | RunState::Preparing | RunState::Runnable | RunState::Waiting
            )
        {
            return Err(RuntimeError::Conflict(
                "Run has already entered execution".into(),
            ));
        }
        let mut intent: LaunchMetadata = record(&tx, "run_launches", run_id)?;
        let wait_id = format!("preparation:{}", run_id);
        if run.state == RunState::Waiting && run.waiting_on.as_deref() != Some(&wait_id) {
            return Err(RuntimeError::Conflict(
                "execution recovery wait cannot be replaced by preparation failure".into(),
            ));
        }
        let after_cursor: u64 =
            tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
                read_number(r, 0)
            })?;
        let wait = Wait {
            id: wait_id.clone(),
            run_id: run_id.into(),
            subject: run_id.into(),
            kind: "launch.prepared".into(),
            after_cursor,
            trigger_cursor: None,
            cancelled: false,
        };
        tx.execute("INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![wait_id,run_id,encode(&wait)?])?;
        intent.preparation_failure = Some(code.into());
        intent.bound_epoch = None;
        intent.requires_rebind = true;
        intent.revision += 1;
        put(&tx, "run_launches", run_id, &intent)?;
        run.state = RunState::Waiting;
        run.waiting_on = Some(wait_id);
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        event(
            &tx,
            run_id,
            run.revision,
            "run.preparation_failed",
            json!({"code":code}),
        )?;
        tx.commit()?;
        Ok(intent)
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn launch_intent(&self, run_id: &str) -> Result<Option<LaunchIntent>> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_launch(run_id)?
            .map(LaunchRead::load)
            .transpose()
    }
    /// Includes queued launches; recovery never silently executes a saved grant or model request.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn pending_launches(&self) -> Result<Vec<LaunchIntent>> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_pending_launches()?
            .into_iter()
            .map(LaunchRead::load)
            .collect()
    }
}

pub(super) fn policy_preparable(
    db: &Connection,
    run: &Run,
    launch: &LaunchMetadata,
) -> Result<bool> {
    if run.cancel_requested
        || run.state.terminal()
        || launch.bound_epoch.is_some()
        || launch.policy_generation != 0
        || launch.policy_target != super::policy_switch::PolicyTarget::Default
        || !launch.selection.policy_models.is_empty()
    {
        return Ok(false);
    }
    let used:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1) OR EXISTS(SELECT 1 FROM policy_checkpoints WHERE run_id=?1) OR EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='run.launch_bound')",[&run.id],|r|r.get(0))?;
    Ok(!used)
}
