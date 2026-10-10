//! Ready tool compositions publish only at a closed request boundary. Configuration remains
//! with its owner; the activation fact retains the exact credential-free executable selection.
use super::launch_content::LaunchMetadata;
use super::launches::{ExtensionToolBinding, HostToolBinding};
use super::*;
use crate::execution::ToolSchema;

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolComposition {
    pub generation: u64,
    pub tools: Vec<ToolSchema>,
    pub mcp_binding: Option<HostToolBinding>,
    pub extension_bindings: Vec<ExtensionToolBinding>,
}
pub struct ToolUpdatePreparation {
    run_id: String,
    epoch: u64,
    previous_generation: u64,
    base: Vec<ToolSchema>,
    base_ref: Value,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedToolUpdate {
    run_id: String,
    epoch: u64,
    previous_generation: u64,
    base_ref: Value,
    tools_ref: Value,
    mcp_ref: Option<Value>,
    extensions_ref: Value,
    composition: ToolComposition,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
pub struct ToolUpdateCapture {
    run_id: String,
    epoch: u64,
    previous_generation: u64,
    base_ref: Value,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
impl ToolUpdateCapture {
    pub fn load_base(self) -> Result<ToolUpdatePreparation> {
        let base = serde_json::from_value(self.content.load(&self.base_ref)?)?;
        Ok(ToolUpdatePreparation {
            run_id: self.run_id,
            epoch: self.epoch,
            previous_generation: self.previous_generation,
            base,
            base_ref: self.base_ref,
            content: self.content,
            publication: self.publication,
        })
    }
}
impl ToolUpdatePreparation {
    pub fn base(&self) -> &[ToolSchema] {
        &self.base
    }
    /// No owner lock is held while validating the directory or writing its immutable body.
    pub fn load(
        self,
        mut tools: Vec<ToolSchema>,
        mcp_binding: Option<HostToolBinding>,
        extension_bindings: Vec<ExtensionToolBinding>,
    ) -> Result<PreparedToolUpdate> {
        if let Some(binding) = &mcp_binding {
            binding.validate()?;
        }
        for binding in &extension_bindings {
            binding.validate()?;
        }
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let mut expected = self.base.clone();
        if let Some(binding) = &mcp_binding {
            expected.extend(binding.tools.iter().cloned());
        }
        expected.extend(extension_bindings.iter().map(|b| b.tool.clone()));
        expected.sort_by(|a, b| a.name.cmp(&b.name));
        let mut names = std::collections::BTreeSet::new();
        if tools != expected
            || tools.iter().any(|tool| {
                tool.name.is_empty()
                    || tool.version.is_empty()
                    || !(tool.schema.is_object() || tool.schema.is_boolean())
                    || !names.insert(&tool.name)
            })
        {
            return Err(RuntimeError::Invalid(
                "tool update must preserve its admitted base capabilities".into(),
            ));
        }
        let composition = ToolComposition {
            generation: self
                .previous_generation
                .checked_add(1)
                .ok_or_else(|| RuntimeError::Invalid("tool generation exhausted".into()))?,
            tools,
            mcp_binding,
            extension_bindings,
        };
        let reference = self.content.save(&serde_json::to_value(&composition)?)?;
        let tools_ref = self
            .content
            .save(&serde_json::to_value(&composition.tools)?)?;
        let mcp_ref = composition
            .mcp_binding
            .as_ref()
            .map(|binding| self.content.save(&serde_json::to_value(binding)?))
            .transpose()?;
        let extensions_ref = self
            .content
            .save(&serde_json::to_value(&composition.extension_bindings)?)?;
        Ok(PreparedToolUpdate {
            run_id: self.run_id,
            epoch: self.epoch,
            previous_generation: self.previous_generation,
            base_ref: self.base_ref,
            tools_ref,
            mcp_ref,
            extensions_ref,
            composition,
            reference,
            _publication: self.publication,
        })
    }
}
impl PreparedToolUpdate {
    pub fn composition(&self) -> &ToolComposition {
        &self.composition
    }
    pub fn previous_generation(&self) -> u64 {
        self.previous_generation
    }
}
impl Catalog {
    pub fn validate_tool_update_scope(&self, run_id: &str, epoch: u64) -> Result<()> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested || self.db.query_row("SELECT EXISTS(SELECT 1 FROM context_jobs WHERE run_id=?1) OR EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?2)",
            params![run_id,run.thread_id],|row|row.get::<_,bool>(0))? {
            return Err(RuntimeError::Conflict("this Run has no mutable tool composition".into()));
        }
        Ok(())
    }
    pub fn capture_tool_update(&self, run_id: &str, epoch: u64) -> Result<ToolUpdateCapture> {
        self.validate_tool_update_scope(run_id, epoch)?;
        let launch: LaunchMetadata = record(&self.db, "run_launches", run_id)?;
        Ok(ToolUpdateCapture {
            run_id: run_id.into(),
            epoch,
            previous_generation: launch.selection.tool_schema_generation,
            base_ref: launch.selection.base_tools_ref,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn activate_tool_update(&mut self, prepared: &PreparedToolUpdate) -> Result<bool> {
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", &prepared.run_id)?;
        fence(&run, prepared.epoch)?;
        if run.cancel_requested || run.state.terminal() {
            return Ok(false);
        }
        let mut launch: LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        if launch.bound_epoch != Some(prepared.epoch)
            || launch.selection.tool_schema_generation != prepared.previous_generation
            || launch.selection.base_tools_ref != prepared.base_ref
        {
            return Err(RuntimeError::Conflict(
                "tool update belongs to another active composition".into(),
            ));
        }
        let active: Option<String> = tx.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| row.get(0),
        )?;
        let unsettled:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched'))
            OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)
            ", [&run.id],|row|row.get(0))?;
        let unsettled = unsettled || super::policy_body::has_pending_action(&tx, &run.id)?;
        if active.as_deref() != Some(run.id.as_str()) || unsettled {
            return Err(RuntimeError::Conflict(
                "tool composition requires a closed execution boundary".into(),
            ));
        }
        launch.selection.tool_schema_generation = prepared.composition.generation;
        launch.selection.tools_ref = prepared.tools_ref.clone();
        launch.selection.mcp_binding_ref = prepared.mcp_ref.clone();
        launch.selection.extension_bindings_ref = prepared.extensions_ref.clone();
        launch.revision += 1;
        run.revision += 1;
        put(&tx, "run_launches", &run.id, &launch)?;
        put(&tx, "runs", &run.id, &run)?;
        event(
            &tx,
            &run.id,
            run.revision,
            "run.tools_activated",
            json!({"generation":prepared.composition.generation,"composition":prepared.reference}),
        )?;
        tx.commit()?;
        Ok(true)
    }
}
