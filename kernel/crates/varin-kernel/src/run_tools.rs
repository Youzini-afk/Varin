//! Scope-local ready directories. Configuration owners prepare independently; only the Run's
//! closed request boundary activates a candidate. Neither calls nor observers scan providers.
use crate::mcp::{McpBinding, McpBridge, McpGeneration};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use varin_runtime::{
    catalog::tools::PreparedToolUpdate,
    composition::tools::{PreparedToolDirectory, ToolDeclaration, ToolDirectory},
    execution::*,
    Catalog,
};

struct RetainedMcp {
    generation: Arc<McpGeneration>,
    declarations: Vec<ToolDeclaration>,
}
pub(crate) struct PreparedRunTools {
    base: Vec<ToolDeclaration>,
    directory: Arc<ToolDirectory>,
    mcp: Option<RetainedMcp>,
}
impl PreparedRunTools {
    pub fn schemas(&self) -> &[ToolSchema] {
        self.directory.schemas()
    }
    pub fn into_static(self) -> Arc<dyn ToolExecutor> {
        self.directory
    }
}
struct Active {
    base: Vec<ToolDeclaration>,
    directory: Arc<ToolDirectory>,
    generation: u64,
    selection_id: Option<String>,
    _mcp: Option<RetainedMcp>,
}
struct Candidate {
    id: String,
    composition: PreparedToolUpdate,
    mcp: Option<RetainedMcp>,
    directory: Option<PreparedToolDirectory>,
}
#[derive(Default)]
struct State {
    desired: Option<String>,
    active: Option<Active>,
    candidate: Option<Candidate>,
}
impl State {
    fn ready_status(
        &self,
        id: &str,
        binding: Option<&McpBinding>,
    ) -> Result<Option<bool>, ExecutionError> {
        if self.desired.as_deref() != Some(id) {
            return Ok(Some(false));
        }
        let previous = if let Some(candidate) = self
            .candidate
            .as_ref()
            .filter(|candidate| candidate.id == id)
        {
            Some(candidate.composition.composition().mcp_binding.as_ref())
        } else {
            self.active
                .as_ref()
                .filter(|active| active.selection_id.as_deref() == Some(id))
                .map(|active| active._mcp.as_ref().map(|mcp| mcp.generation.binding()))
        };
        if let Some(previous) = previous {
            if previous != binding {
                return Err(failed("tool selection identity was reused"));
            }
            return Ok(Some(true));
        }
        Ok(None)
    }
}
#[derive(Default)]
struct Slot {
    state: Mutex<State>,
}
pub(crate) struct RunTools {
    catalog: Arc<Mutex<Catalog>>,
    mcp: McpBridge,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}
fn failed(error: impl ToString) -> ExecutionError {
    ExecutionError::new("tool_composition", error.to_string())
}
fn declarations(base: &[ToolDeclaration], mcp: Option<&RetainedMcp>) -> Vec<ToolDeclaration> {
    let mut selected = base.to_vec();
    if let Some(mcp) = mcp {
        selected.extend(mcp.declarations.iter().cloned());
    }
    selected
}
impl RunTools {
    pub fn new(catalog: Arc<Mutex<Catalog>>, mcp: McpBridge) -> Arc<Self> {
        Arc::new(Self {
            catalog,
            mcp,
            slots: Mutex::new(HashMap::new()),
        })
    }
    fn slot(&self, run: &str) -> Result<Arc<Slot>, ExecutionError> {
        Ok(self
            .slots
            .lock()
            .map_err(failed)?
            .entry(run.into())
            .or_default()
            .clone())
    }
    fn retain(
        &self,
        run: &str,
        binding: Option<McpBinding>,
    ) -> Result<Option<RetainedMcp>, ExecutionError> {
        binding
            .map(|binding| {
                let generation = self.mcp.prepare_generation(run.into(), binding)?;
                Ok(RetainedMcp {
                    declarations: generation.declarations(),
                    generation,
                })
            })
            .transpose()
    }
    pub fn prepare_scope(
        &self,
        run: &str,
        base: Vec<ToolDeclaration>,
        binding: Option<McpBinding>,
    ) -> Result<PreparedRunTools, ExecutionError> {
        let mcp = self.retain(run, binding)?;
        let directory = Arc::new(ToolDirectory::assemble(declarations(&base, mcp.as_ref()))?);
        Ok(PreparedRunTools {
            base,
            directory,
            mcp,
        })
    }
    pub fn install(
        self: &Arc<Self>,
        run: &str,
        generation: u64,
        prepared: PreparedRunTools,
    ) -> Result<Arc<dyn ToolExecutor>, ExecutionError> {
        let slot = self.slot(run)?;
        {
            let mut state = slot.state.lock().map_err(failed)?;
            let selection_id = state
                .active
                .as_ref()
                .and_then(|active| active.selection_id.clone());
            if let Some(candidate) = state.candidate.as_mut() {
                if candidate.composition.previous_generation() != generation {
                    return Err(failed("ready composition differs from the rebound launch"));
                }
                candidate.directory = Some(prepared.directory.prepare_replacement(
                    prepared.directory.revision(),
                    declarations(&prepared.base, candidate.mcp.as_ref()),
                )?);
            }
            state.active = Some(Active {
                base: prepared.base,
                directory: prepared.directory,
                generation,
                selection_id,
                _mcp: prepared.mcp,
            });
        }
        Ok(Arc::new(ScopedTools {
            owner: self.clone(),
            slot,
            run_id: run.into(),
        }))
    }
    pub fn desire(&self, run: &str, id: &str) -> Result<(), ExecutionError> {
        if id.is_empty() {
            return Err(failed("tool selection identity is required"));
        }
        {
            let catalog = self.catalog.lock().map_err(failed)?;
            catalog
                .validate_tool_update_scope(run, catalog.epoch())
                .map_err(failed)?;
        }
        let slot = self.slot(run)?;
        let mut state = slot.state.lock().map_err(failed)?;
        if state.desired.as_deref() != Some(id) {
            state.desired = Some(id.into());
            state.candidate = None;
        }
        Ok(())
    }
    pub fn ready(
        &self,
        run: &str,
        id: &str,
        binding: Option<McpBinding>,
        cancelled: impl Fn() -> bool,
    ) -> Result<bool, ExecutionError> {
        let slot = self.slot(run)?;
        {
            let state = slot.state.lock().map_err(failed)?;
            if let Some(ready) = state.ready_status(id, binding.as_ref())? {
                return Ok(ready);
            }
        }
        let mcp = self.retain(run, binding.clone())?;
        loop {
            if cancelled() {
                return Ok(false);
            }
            if slot.state.lock().map_err(failed)?.desired.as_deref() != Some(id) {
                return Ok(false);
            }
            let preparation = {
                let catalog = self.catalog.lock().map_err(failed)?;
                catalog
                    .capture_tool_update(run, catalog.epoch())
                    .map_err(failed)?
            };
            let mut schemas = preparation.base().to_vec();
            if let Some(binding) = &binding {
                schemas.extend(binding.tools.iter().cloned());
            }
            let composition = preparation.load(schemas, binding.clone()).map_err(failed)?;
            let mut state = slot.state.lock().map_err(failed)?;
            if cancelled() || state.desired.as_deref() != Some(id) {
                return Ok(false);
            }
            if let Some(ready) = state.ready_status(id, binding.as_ref())? {
                return Ok(ready);
            }
            let directory = if let Some(active) = &state.active {
                if active.generation != composition.previous_generation() {
                    continue;
                }
                Some(active.directory.prepare_replacement(
                    active.directory.revision(),
                    declarations(&active.base, mcp.as_ref()),
                )?)
            } else {
                None
            };
            state.candidate = Some(Candidate {
                id: id.into(),
                composition,
                mcp,
                directory,
            });
            return Ok(true);
        }
    }
    pub fn release(&self, run: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.remove(run);
        }
    }
}
struct ScopedTools {
    owner: Arc<RunTools>,
    slot: Arc<Slot>,
    run_id: String,
}
impl ScopedTools {
    fn directory(&self) -> Result<Arc<ToolDirectory>, ExecutionError> {
        self.slot
            .state
            .lock()
            .map_err(failed)?
            .active
            .as_ref()
            .map(|active| active.directory.clone())
            .ok_or_else(|| failed("tool scope is not prepared"))
    }
}
impl ToolExecutor for ScopedTools {
    fn select_for_request(
        &self,
        run: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<SelectedTools>, ExecutionError> {
        if run != self.run_id || cancel.is_cancelled() {
            return Err(failed("tool selection owner changed"));
        }
        let mut state = self.slot.state.lock().map_err(failed)?;
        if let Some(mut candidate) = state.candidate.take() {
            if state.desired.as_deref() != Some(candidate.id.as_str()) {
                return Err(failed("obsolete tool candidate"));
            }
            let directory = candidate
                .directory
                .take()
                .ok_or_else(|| failed("tool candidate is not prepared"))?;
            directory.validate()?;
            {
                let mut catalog = self.owner.catalog.lock().map_err(failed)?;
                if catalog.epoch() != epoch || cancel.is_cancelled() {
                    return Err(failed("tool selection owner changed"));
                }
                if !catalog
                    .activate_tool_update(&candidate.composition)
                    .map_err(failed)?
                {
                    return Err(failed("tool selection cancelled"));
                }
            }
            let directory = Arc::new(directory.publish()?);
            if let Some(mcp) = &candidate.mcp {
                mcp.generation.activate()?;
            } else {
                self.owner.mcp.deactivate(run)?;
            }
            let active = state
                .active
                .as_mut()
                .ok_or_else(|| failed("tool scope is not prepared"))?;
            active.generation = candidate.composition.composition().generation;
            active.selection_id = Some(candidate.id);
            active.directory = directory;
            active._mcp = candidate.mcp;
        }
        let active = state
            .active
            .as_ref()
            .ok_or_else(|| failed("tool scope is not prepared"))?;
        let schemas = active.directory.schemas().to_vec();
        let executor = active
            .directory
            .freeze(&schemas)?
            .ok_or_else(|| failed("tool directory did not retain its endpoints"))?;
        Ok(Some(SelectedTools {
            generation: active.generation,
            schemas,
            executor,
        }))
    }
    fn freeze(
        &self,
        schemas: &[ToolSchema],
    ) -> Result<Option<Arc<dyn ToolExecutor>>, ExecutionError> {
        self.directory()?.freeze(schemas)
    }
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        self.directory()?.bind_call(call, context, cancel)
    }
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.directory()?.plan(call, context, cancel)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        self.directory()?.prepare(call, context, cancel)
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(failed("prepared directory invocation required"))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "prepared directory invocation required".into(),
        }
    }
}
