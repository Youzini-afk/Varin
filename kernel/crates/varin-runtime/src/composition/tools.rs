//! Executable tool contributions over the existing composition owner. The declaration owns the
//! external schema and the actual endpoint; all consumers use this same selected directory.
use super::{BindingId, BindingSpec, CallLease, CompositionPlan, CompositionRegistry, ModelStepPins};
use crate::execution::*;
use crate::execution_capacity::{AdmissionControlGuard, ExecutionClass};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct ToolDeclaration {
    pub schema: ToolSchema,
    /// Implementation/configuration identity supplied by its existing resource or extension owner.
    pub content_version: String,
    pub implementation: Arc<dyn ToolExecutor>,
}
impl ToolDeclaration {
    pub fn new(schema: ToolSchema, implementation: Arc<dyn ToolExecutor>) -> Self {
        Self { content_version: schema.version.clone(), schema, implementation }
    }
}
struct Endpoint { executor: Arc<dyn ToolExecutor> }
/// A ready scope-local tool set. Installation and slow preparation remain with capability owners.
pub struct ToolDirectory {
    registry: Arc<Mutex<CompositionRegistry<Endpoint>>>,
    plan: Arc<CompositionPlan<Endpoint>>,
    schemas: Vec<ToolSchema>,
    indexes: HashMap<String, usize>,
}
impl ToolDirectory {
    pub fn assemble(declarations: Vec<ToolDeclaration>) -> Result<Self, ExecutionError> {
        let mut registry = CompositionRegistry::new();
        let (plan, schemas) = publish(&mut registry, 0, declarations)?;
        let indexes = schemas.iter().enumerate().map(|(index, schema)| (schema.name.clone(), index)).collect();
        Ok(Self { registry: Arc::new(Mutex::new(registry)), plan, schemas, indexes })
    }
    /// Publication preserves old request pins. Failed candidates leave the active generation intact.
    pub fn replace(&self, expected_revision: u64, declarations: Vec<ToolDeclaration>) -> Result<Self, ExecutionError> {
        let (plan, schemas) = publish(&mut *self.registry.lock().map_err(failed)?, expected_revision, declarations)?;
        let indexes = schemas.iter().enumerate().map(|(index, schema)| (schema.name.clone(), index)).collect();
        Ok(Self { registry: self.registry.clone(), plan, schemas, indexes })
    }
    pub fn revision(&self) -> u64 { self.plan.revision() }
    pub fn schemas(&self) -> &[ToolSchema] { &self.schemas }
    pub fn binding_id(&self, name: &str) -> Result<BindingId, ExecutionError> { self.plan.bind(name).map(|handle| handle.id()).map_err(failed) }
    pub fn revoke(&self, id: BindingId) -> Result<bool, ExecutionError> { Ok(self.registry.lock().map_err(failed)?.revoke(id)) }
    fn pins(&self, schemas: &[ToolSchema]) -> Result<FrozenDirectory, ExecutionError> {
        for schema in schemas {
            if self.indexes.get(&schema.name).is_none_or(|index| &self.schemas[*index] != schema) {
                return Err(ExecutionError::new("stale_tool_schema", "request schema differs from its selected capability"));
            }
        }
        let pins = self.plan.pin_model_step(schemas.iter().map(|schema| schema.name.as_str())).map_err(failed)?;
        Ok(FrozenDirectory { pins, schemas: schemas.to_vec() })
    }
}
fn publish(registry: &mut CompositionRegistry<Endpoint>, revision: u64, mut declarations: Vec<ToolDeclaration>)
    -> Result<(Arc<CompositionPlan<Endpoint>>, Vec<ToolSchema>), ExecutionError> {
    declarations.sort_by(|left, right| left.schema.name.cmp(&right.schema.name));
    let mut schemas = Vec::with_capacity(declarations.len());
    let mut specs = Vec::with_capacity(declarations.len());
    for declaration in declarations {
        let schema = declaration.schema;
        if schema.name.is_empty() || schema.version.is_empty() { return Err(ExecutionError::new("invalid_tool_declaration", "tool name and schema version are required")); }
        specs.push(BindingSpec { capability: schema.name.clone(), content_version: declaration.content_version,
            schema: serde_json::to_value(&schema).map_err(failed)?, implementation: Arc::new(Endpoint { executor: declaration.implementation }) });
        schemas.push(schema);
    }
    let candidate = registry.prepare(revision, specs).map_err(failed)?;
    let plan = registry.publish(candidate).map_err(failed)?;
    Ok((plan, schemas))
}
struct FrozenDirectory { pins: ModelStepPins<Endpoint>, schemas: Vec<ToolSchema> }
struct SelectedCall { lease: CallLease<Endpoint>, invocation: Box<dyn PreparedToolCall>, _revocation: AdmissionControlGuard }
fn selected(lease: CallLease<Endpoint>, call: &ToolCall, context: &FrozenToolContext, schemas: &[ToolSchema], cancel: &CancellationToken) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
    if !schemas.iter().any(|schema| schema.name == call.name && schema.version == call.schema_version && context.tools.contains(schema)) {
        return Err(ExecutionError::new("stale_tool_schema", "tool is absent from the frozen directory"));
    }
    let revocation = lease.watch_revocation(cancel);
    let invocation = lease.implementation().map_err(failed)?.executor.clone().bind_call(call, context, cancel)?;
    Ok(Box::new(SelectedCall { lease, invocation, _revocation: revocation }))
}
impl PreparedToolCall for SelectedCall {
    fn plan(&self, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> { self.lease.validate().map_err(failed)?; self.invocation.plan(cancel) }
    fn prepare(&self, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> { self.lease.validate().map_err(failed)?; self.invocation.prepare(cancel) }
    fn execution_class(&self, contract: &ToolContract) -> ExecutionClass { self.invocation.execution_class(contract) }
    fn supports_policy_read(&self, contract: &ToolContract) -> bool { self.lease.validate().is_ok() && self.invocation.supports_policy_read(contract) }
    fn watch_admission(&self, context: &ToolExecutionContext, contract: &ToolContract, cancel: &CancellationToken) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
        self.lease.validate().map_err(failed)?;
        self.invocation.watch_admission(context, contract, cancel)
    }
    fn authorize(&self, context: &ToolExecutionContext, contract: &ToolContract, cancel: &CancellationToken) -> Result<(), ExecutionError> { self.lease.validate().map_err(failed)?; self.invocation.authorize(context, contract, cancel) }
    fn execute(&self, context: &ToolExecutionContext, contract: &ToolContract, cancel: &CancellationToken) -> ToolCompletion {
        if let Err(error) = self.lease.validate() { return ToolCompletion::NotDispatched { reason: error.to_string() }; }
        self.invocation.execute(context, contract, cancel)
    }
}
fn failed(error: impl std::fmt::Display) -> ExecutionError { ExecutionError::new("tool_binding_invalid", error.to_string()) }

// The engine uses bind_call once. These result methods also serve direct users of the same
// directory; no wrapper chain or secondary name routing is involved.
macro_rules! directory_executor {
    ($ty:ty, $bind:expr, $freeze:expr) => {
        impl ToolExecutor for $ty {
            fn freeze(&self, schemas: &[ToolSchema]) -> Result<Option<Arc<dyn ToolExecutor>>, ExecutionError> { ($freeze)(self, schemas) }
            fn bind_call(self: Arc<Self>, call: &ToolCall, context: &FrozenToolContext, cancel: &CancellationToken) -> Result<Box<dyn PreparedToolCall>, ExecutionError> { ($bind)(&self, call, context, cancel) }
            fn plan(&self, call: &ToolCall, context: &FrozenToolContext, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> { ($bind)(self, call, context, cancel)?.plan(cancel) }
            fn prepare(&self, call: &ToolCall, context: &FrozenToolContext, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> { ($bind)(self, call, context, cancel)?.prepare(cancel) }
            fn authorize(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken) -> Result<(), ExecutionError> { Err(ExecutionError::new("prepared_call_required", "bind the directory invocation before authorization")) }
            fn execute(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken) -> ToolCompletion { ToolCompletion::NotDispatched { reason: "bind the directory invocation before dispatch".into() } }
        }
    }
}
directory_executor!(ToolDirectory,
    |directory: &ToolDirectory, call: &ToolCall, context: &FrozenToolContext, cancel: &CancellationToken| selected(directory.plan.bind(&call.name).map_err(failed)?.begin_call().map_err(failed)?, call, context, &directory.schemas, cancel),
    |directory: &ToolDirectory, schemas: &[ToolSchema]| Ok(Some(Arc::new(directory.pins(schemas)?) as Arc<dyn ToolExecutor>)));
directory_executor!(FrozenDirectory,
    |directory: &FrozenDirectory, call: &ToolCall, context: &FrozenToolContext, cancel: &CancellationToken| selected(directory.pins.begin_call(&call.name).map_err(failed)?, call, context, &directory.schemas, cancel),
    |_: &FrozenDirectory, _: &[ToolSchema]| Ok(None));

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct EndpointFixture(&'static str);
    impl ToolExecutor for EndpointFixture {
        fn plan(&self, call: &ToolCall, context: &FrozenToolContext, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
            self.prepare(call, context, cancel).map(ToolPreparation::Ready)
        }
        fn prepare(&self, call: &ToolCall, _: &FrozenToolContext, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
            Ok(ToolContract {name: call.name.clone(), schema_version: call.schema_version.clone(), read_only: true,
                completion: CompletionKind::Result, lifetime: crate::Lifetime::Run, resources: vec![]})
        }
        fn authorize(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken) -> Result<(), ExecutionError> { Ok(()) }
        fn execute(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken) -> ToolCompletion {
            ToolCompletion::Result {outcome: crate::Outcome::Succeeded, effect: crate::Effect::None, content: json!(self.0)}
        }
    }
    fn declaration(version: &'static str) -> ToolDeclaration {
        ToolDeclaration::new(ToolSchema {name: "query".into(), version: version.into(), schema: json!({"type":"object"})}, Arc::new(EndpointFixture(version)))
    }
    #[test]
    fn model_exchange_retains_its_endpoint_and_revocation_reaches_preparation() {
        let first = Arc::new(ToolDirectory::assemble(vec![declaration("first")]).unwrap());
        let pinned = first.freeze(first.schemas()).unwrap().unwrap();
        let first_id = first.binding_id("query").unwrap();
        let next = Arc::new(first.replace(first.revision(), vec![declaration("next")]).unwrap());
        let call = ToolCall {call_id:"call".into(), name:"query".into(), schema_version:"first".into(), arguments:json!({})};
        let context = FrozenToolContext {run_id:"run".into(), origin:ToolOrigin::ModelStep {request_id:"request".into()},
            tool_schema_generation:1, tools:Arc::new(first.schemas().to_vec()), source:None};
        let cancelled = CancellationToken::default();
        assert!(first.clone().bind_call(&call, &context, &cancelled).is_err());
        let old_call = pinned.bind_call(&call, &context, &cancelled).unwrap();
        let contract = old_call.prepare(&cancelled).unwrap();
        let execution = ToolExecutionContext {run_id:"run".into(), operation_id:"operation".into(), origin:context.origin.clone()};
        assert!(matches!(old_call.execute(&execution, &contract, &cancelled), ToolCompletion::Result {content, ..} if content == "first"));
        let next_token = CancellationToken::default();
        let next_context = FrozenToolContext {tools:Arc::new(next.schemas().to_vec()), ..context.clone()};
        let next_call = next.clone().bind_call(&ToolCall {schema_version:"next".into(), ..call}, &next_context, &next_token).unwrap();
        let next_contract = next_call.prepare(&next_token).unwrap();
        assert!(next.revoke(first_id).unwrap());
        assert!(cancelled.is_cancelled());
        assert!(!next_token.is_cancelled());
        assert!(old_call.authorize(&execution, &contract, &cancelled).is_err());
        assert!(matches!(next_call.execute(&execution, &next_contract, &next_token), ToolCompletion::Result {content, ..} if content == "next"));
    }
}
