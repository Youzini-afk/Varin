//! Child availability projects actual owning declarations, never a second tool registry.
use crate::tools::ToolKind;
use varin_runtime::catalog::dispatch::ChildCapabilityDescriptor;
#[cfg(test)]
use varin_runtime::catalog::dispatch::ChildSourceRequirement;
use varin_runtime::execution::ToolSchema;

fn definitions() -> Vec<crate::run_tools::BuiltinSchema> {
    crate::run_tools::builtin_definitions(&ToolKind::all().collect(), true, false)
        .into_iter()
        .filter(|definition| definition.child.is_some())
        .collect()
}
pub(crate) fn schemas() -> Vec<ToolSchema> {
    definitions()
        .into_iter()
        .map(|definition| definition.schema)
        .collect()
}
pub(crate) fn descriptors() -> Vec<ChildCapabilityDescriptor> {
    definitions()
        .into_iter()
        .map(|definition| {
            let (source_requirement, default_presets) =
                definition.child.expect("child declaration");
            ChildCapabilityDescriptor {
                name: definition.schema.name,
                version: definition.schema.version,
                source_requirement,
                default_presets,
            }
        })
        .collect()
}
pub(crate) fn select(names: &[String]) -> Result<Vec<ToolSchema>, varin_runtime::RuntimeError> {
    let available = schemas();
    names
        .iter()
        .map(|name| {
            available
                .iter()
                .find(|tool| &tool.name == name)
                .cloned()
                .ok_or_else(|| {
                    varin_runtime::RuntimeError::Invalid(format!(
                        "unsupported child capability: {name}"
                    ))
                })
        })
        .collect()
}
pub(crate) fn select_frozen(
    selected: &varin_runtime::catalog::dispatch::ChildDispatchSelection,
    names: &[String],
) -> Result<Vec<ToolSchema>, varin_runtime::RuntimeError> {
    let native = names
        .iter()
        .filter(|name| selected.host_tool(name).is_none())
        .cloned()
        .collect::<Vec<_>>();
    let available = select(&native)?;
    names
        .iter()
        .map(|name| {
            if let Some(tool) = selected.host_tool(name) {
                return Ok(tool.clone());
            }
            available
                .iter()
                .find(|tool| &tool.name == name)
                .cloned()
                .ok_or_else(|| {
                    varin_runtime::RuntimeError::Invalid(format!(
                        "unsupported child capability: {name}"
                    ))
                })
        })
        .collect()
}
/// Main-only Goal authority is not a delegation selection. Every returned tool is
/// present in the actual parent directory with the identical owning declaration.
pub(crate) fn delegated(parent: &[ToolSchema]) -> Vec<ToolSchema> {
    parent
        .iter()
        .filter(|tool| tool.name != "goal_report")
        .cloned()
        .collect()
}

/// Reuses the original launch/model authority at a closed execution boundary. Only small
/// metadata is read or published under Catalog; schemas and profile bodies stay on the worker.
pub(crate) struct BindingPreparation {
    pub inner: std::sync::Arc<dyn varin_runtime::execution::ContextPreparation>,
    pub catalog: std::sync::Arc<std::sync::Mutex<varin_runtime::Catalog>>,
}
impl varin_runtime::execution::ContextPreparation for BindingPreparation {
    fn prepare_binding(
        &self,
        run_id: &str,
        epoch: u64,
        binding: &mut varin_runtime::execution::RequestBinding,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<
        Vec<varin_runtime::execution::ConversationItem>,
        varin_runtime::execution::ExecutionError,
    > {
        use varin_runtime::execution::*;
        let error = |e: String| ExecutionError::new("child_delegation", e);
        let mut context = self.inner.prepare_binding(run_id, epoch, binding, cancel)?;
        if cancel.is_cancelled() {
            return Err(error("Run cancelled".into()));
        }
        let (run, launch) = {
            let owner = self.catalog.lock().map_err(|e| error(e.to_string()))?;
            let run = owner.run(run_id).map_err(|e| error(e.to_string()))?;
            let launch = owner
                .launch_metadata(run_id)
                .map_err(|e| error(e.to_string()))?;
            (run, launch)
        };
        let Some(launch) = launch else {
            binding.child_dispatch = None;
            return Ok(context);
        };
        if run.epoch != epoch {
            return Err(error("Run owner changed".into()));
        }
        let model = varin_runtime::catalog::dispatch::ChildModelBinding {
            configuration: serde_json::from_value(run.configuration)
                .map_err(|e| error(e.to_string()))?,
            credential_scope: launch.selection.credential_scope,
        };
        if !model.matches(binding).map_err(|e| error(e.to_string()))? {
            return Err(error("Actual model differs from launch authority".into()));
        }
        let prepared = self
            .catalog
            .lock()
            .map_err(|e| error(e.to_string()))?
            .prepare_child_dispatch_binding(
                run_id,
                model,
                binding.tool_schema_generation,
                delegated(&binding.tools),
            )
            .map_err(|e| error(e.to_string()))?;
        let prepared = prepared.load().map_err(|e| error(e.to_string()))?;
        if cancel.is_cancelled() {
            return Err(error("Run cancelled".into()));
        }
        binding.child_dispatch = self
            .catalog
            .lock()
            .map_err(|e| error(e.to_string()))?
            .bind_child_dispatch(run_id, prepared)
            .map_err(|e| error(e.to_string()))?;
        if binding.tools.iter().any(|tool| tool.name == "dispatch") {
            if let Some(reference) = &binding.child_dispatch {
                let read = self
                    .catalog
                    .lock()
                    .map_err(|e| error(e.to_string()))?
                    .capture_child_dispatch(reference);
                let selected = read.load().map_err(|e| error(e.to_string()))?;
                context.push(ConversationItem {
                    id: format!("child-dispatch:{run_id}"),
                    resource_activation: None,
                    provenance: Provenance::SystemInstruction {
                        source: "child_dispatch_configuration".into(),
                    },
                    content: Content::Text {
                        text: discovery(&selected).to_string(),
                    },
                    opaque: None,
                });
            } else {
                context.push(ConversationItem { id: format!("child-dispatch:{run_id}"), resource_activation: None,
                    provenance: Provenance::SystemInstruction { source: "child_dispatch_configuration".into() },
                    content: Content::Text { text: "Child dispatch unavailable: no configuration snapshot was selected for this Run.".into() }, opaque: None });
            }
        }
        Ok(context)
    }
    fn prepare(
        &self,
        run_id: &str,
        epoch: u64,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<(), varin_runtime::execution::ExecutionError> {
        self.inner.prepare(run_id, epoch, cancel)
    }
    fn prepare_request(
        &self,
        epoch: u64,
        view: &varin_runtime::execution::RequestView,
        serialized: &serde_json::Value,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<
        varin_runtime::execution::ContextRequestPreparation,
        varin_runtime::execution::ExecutionError,
    > {
        self.inner.prepare_request(epoch, view, serialized, cancel)
    }
}

fn discovery(
    selected: &varin_runtime::catalog::dispatch::ChildDispatchSelection,
) -> serde_json::Value {
    use serde_json::json;
    let unsupported = |tools: &[String]| {
        tools
            .iter()
            .filter(|name| select_frozen(selected, std::slice::from_ref(*name)).is_err())
            .cloned()
            .collect::<Vec<_>>()
    };
    let normal = selected
        .frozen
        .allowed_delegation
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    let normal_failure = selected.catalog.normal_unavailable.clone().or_else(|| {
        let mut unknown = unsupported(&normal);
        let source = selected.unavailable_source_tools(&normal);
        let code = if unknown.is_empty() && !source.is_empty() { unknown = source; "source_required" } else { "unsupported" };
        (!unknown.is_empty()).then(
            || varin_runtime::catalog::dispatch::ChildCapabilityFailure {
                code: code.into(),
                capabilities: unknown,
            },
        )
    });
    let presets = selected.catalog.presets.iter().map(|preset| {
        let tools = selected.preset_tools(preset);
        let failure = preset.unavailable.clone().or_else(|| {
            let unknown = unsupported(&tools);
            if !unknown.is_empty() { Some(varin_runtime::catalog::dispatch::ChildCapabilityFailure { code: "unsupported".into(), capabilities: unknown }) }
            else if !selected.unavailable_source_tools(&tools).is_empty() { Some(varin_runtime::catalog::dispatch::ChildCapabilityFailure { code: "source_required".into(), capabilities: selected.unavailable_source_tools(&tools) }) }
            else if preset.inherit_base.as_ref().is_some_and(|base| base != &selected.frozen.parent_model) { Some(varin_runtime::catalog::dispatch::ChildCapabilityFailure { code: "inheritance_basis_changed".into(), capabilities: Vec::new() }) } else { None }
        });
        json!({"id":preset.id,"name":preset.name,"work_mode":preset.work_mode,"tools":tools,"tools_source":preset.tools_source,"model_source":preset.model_source,"model":preset.model.as_ref().map(|model|json!({"provider_family":model.configuration.provider_family,"model":model.configuration.model})),"unavailable":failure})
    }).collect::<Vec<_>>();
    json!({"kind":"child_dispatch_configuration","catalog_identity":selected.catalog.identity,"normal":{"allowed_delegation":normal,"unavailable":selected.catalog.normal_unavailable,"default_unavailable":normal_failure,"selection":"Without tools, the full delegation is selected. Explicit tools may narrow it; unsupported selected tools are rejected."},"presets":presets,
        "work_modes":{"read_only":"fixes an existing file source; ordinary external effects retain their own permissions","isolated_write":"isolates an existing file source; without files, creates no working copy or file result"},
        "source_notice":"Source-dependent tools require an actual selected file source. Select a source or narrow tools to source-independent capabilities. A process cwd is not an OS sandbox. Model final reports and process lifetime are independent."})
}

#[cfg(test)]
#[path = "child_capabilities_review.rs"]
mod tests;
