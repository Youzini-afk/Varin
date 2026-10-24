//! Read capability documentation as tool output; execute through the existing nested lifecycle.
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use varin_runtime::{
    Catalog, Effect, Lifetime, Outcome, execution::*, nested_tools::NestedToolInput,
    tool_disclosure as disclosure,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Describe {
    namespace: Option<String>,
    name: Option<String>,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    name: String,
    version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Invoke {
    reference: Reference,
    arguments: Value,
}
enum Request {
    Describe(Describe),
    Invoke(Invoke),
}
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("tool_disclosure", value.to_string())
}

pub(crate) fn definitions() -> Vec<crate::run_tools::BuiltinSchema> {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::{Retrieval, Worker},
        ChildSourceRequirement::None,
    };
    disclosure::schemas()
        .into_iter()
        .map(|schema| crate::run_tools::BuiltinSchema::child(schema, None, &[Worker, Retrieval]))
        .collect()
}
pub(crate) fn declarations(
    catalog: Arc<Mutex<Catalog>>,
) -> Vec<varin_runtime::composition::tools::ToolDeclaration> {
    let owner = Arc::new(Capabilities { catalog });
    disclosure::schemas()
        .into_iter()
        .map(|schema| {
            varin_runtime::composition::tools::ToolDeclaration::new(schema, owner.clone())
        })
        .collect()
}
struct Capabilities {
    catalog: Arc<Mutex<Catalog>>,
}
struct Call {
    owner: Arc<Capabilities>,
    frozen: FrozenToolContext,
    name: String,
    request: Request,
}
fn parse(call: &ToolCall, frozen: &FrozenToolContext) -> Result<Request, ExecutionError> {
    if !frozen.tools.iter().any(|schema| {
        schema.name == call.name
            && schema.version == call.schema_version
            && disclosure::is_gateway(schema)
    }) {
        return Err(error("disclosure interface is not bound"));
    }
    match call.name.as_str() {
        disclosure::DESCRIBE => {
            let args: Describe = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            if args.namespace.is_some() && args.name.is_some()
                || args.name.as_ref().is_some_and(|v| v.trim().is_empty())
                || args
                    .namespace
                    .as_ref()
                    .is_some_and(|v| !disclosure::GROUPS.iter().any(|(id, _)| id == v))
            {
                return Err(error("choose one exact namespace or tool name"));
            }
            Ok(Request::Describe(args))
        }
        disclosure::INVOKE => {
            let args: Invoke = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            if !args.arguments.is_object() {
                return Err(error("tool_invoke.arguments must be an object matching the target parameters returned by tool_describe"));
            }
            let target = frozen.tools.iter().find(|tool| tool.name == args.reference.name)
                .ok_or_else(|| error(format!("Tool {:?} is not available to this request. Use tool_describe to check the selected capabilities; tool_invoke does not enable unavailable tools.", args.reference.name)))?;
            if disclosure::is_gateway(target) {
                return Err(error("Call the registered tool_describe or tool_invoke function directly; a gateway cannot invoke another gateway."));
            }
            if target.version != args.reference.version {
                return Err(error(format!("The reference for tool {:?} does not match this request's version. Call tool_describe with this name and use the returned reference unchanged.", target.name)));
            }
            Ok(Request::Invoke(args))
        }
        _ => Err(error("unknown disclosure operation")),
    }
}
fn contract(name: &str) -> ToolContract {
    // The gateway only delivers a receipt. Actual effects and independent Jobs belong to
    // the nested target Operation, which runs its own authorization and resource admission.
    ToolContract {
        name: name.into(),
        schema_version: "1".into(),
        read_only: true,
        completion: CompletionKind::Result,
        lifetime: Lifetime::Call,
        resources: vec![],
    }
}
impl ToolExecutor for Capabilities {
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        Ok(Box::new(Call {
            request: parse(call, frozen)?,
            owner: self,
            frozen: frozen.clone(),
            name: call.name.clone(),
        }))
    }
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        parse(call, frozen)?;
        Ok(contract(&call.name))
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(error("bound disclosure invocation required"))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "bound disclosure invocation required".into(),
        }
    }
}
impl Call {
    fn describe(&self, args: &Describe) -> Result<Value, ExecutionError> {
        let tools = self
            .frozen
            .tools
            .iter()
            .filter(|tool| !disclosure::is_gateway(tool))
            .collect::<Vec<_>>();
        if let Some(name) = &args.name {
            return Ok(match tools.iter().find(|tool| &tool.name == name) {
                Some(tool) => {
                    let mut value = json!({"status":"available","name":tool.name,"reference":{"name":tool.name,"version":tool.version},
                        "namespace":disclosure::namespace(&tool.name),"description":tool.description,"parameters":tool.schema,
                        "outputSchema":tool.output_schema,"metadata":tool.metadata,
                        "requirements":tool.requirements,
                        "related":self.related(&tool.name),
                        "directlyCallable":disclosure::is_declared_for(tool, self.frozen.direct_tools.as_deref()),
                        "scriptInvocation":{"function":"tools.invoke","arguments":{"name":tool.name,"arguments":{}},
                            "instruction":"Inside script_run, fill arguments.arguments with the target parameters. Do not copy the model tool_invoke reference wrapper here. Read result.completion.kind first; result completion data is at result.completion.content.data, and media at result.completion.content.parts."},
                        "invocation":if disclosure::is_declared_for(tool, self.frozen.direct_tools.as_deref()) {
                            json!({"tool":tool.name,"arguments":{},"instruction":"Fill arguments using parameters. This function is declared in the current model request."})
                        } else {
                            json!({"tool":disclosure::INVOKE,"arguments":{"reference":{"name":tool.name,"version":tool.version},"arguments":{}},
                                "instruction":"Fill arguments.arguments using parameters. This description does not register a model function. Call tool_invoke, never the target name directly."})
                        }});
                    if name == "dispatch" {
                        value["dispatch"] = self.dispatch()?;
                    }
                    value
                }
                None => json!({"status":"unavailable","name":name,"message":"This tool is not available to the current request. Check the selected tools or query an available namespace; tool_invoke does not bypass selection or permissions."}),
            });
        }
        if let Some(group) = &args.namespace {
            let selected = tools
                .iter()
                .filter(|tool| disclosure::namespace(&tool.name) == Some(group.as_str()))
                .map(|tool| json!({"name":tool.name,"description":tool.description,
                    "reference":{"name":tool.name,"version":tool.version},"requirements":tool.requirements,
                    "directlyCallable":disclosure::is_declared_for(tool, self.frozen.direct_tools.as_deref()),
                    "describe":{"tool":disclosure::DESCRIBE,"arguments":{"name":tool.name}},
                    "related":self.related(&tool.name).iter().map(|related| related["name"].clone()).collect::<Vec<_>>()}))
                .collect::<Vec<_>>();
            return Ok(
                json!({"namespace":group,"status":if selected.is_empty(){"unavailable"}else{"available"},
                "tools":selected}),
            );
        }
        Ok(
            json!({"groups":disclosure::GROUPS.iter().filter_map(|(id, description)| {
            let count = tools.iter().filter(|tool| !disclosure::is_declared_for(tool, self.frozen.direct_tools.as_deref()) && disclosure::namespace(&tool.name) == Some(*id)).count();
            (count > 0).then(|| json!({"namespace":id,"description":description,"tools":count}))
        }).collect::<Vec<_>>()}),
        )
    }
    fn related(&self, name: &str) -> Vec<Value> {
        disclosure::related(name).iter().filter(|candidate| **candidate != name)
            .filter_map(|candidate| self.frozen.tools.iter().find(|tool| tool.name == *candidate))
            .map(|tool| json!({"name":tool.name,"description":tool.description,
                "reference":{"name":tool.name,"version":tool.version},
                "directlyCallable":disclosure::is_declared_for(tool, self.frozen.direct_tools.as_deref())}))
            .collect()
    }
    fn dispatch(&self) -> Result<Value, ExecutionError> {
        let Some(reference) = &self.frozen.child_dispatch else {
            return Ok(json!({"status":"unavailable"}));
        };
        let read = self
            .owner
            .catalog
            .lock()
            .map_err(error)?
            .capture_child_dispatch(reference);
        Ok(crate::child_capabilities::discovery(
            &read.load().map_err(error)?,
        ))
    }
    fn run(&self, context: &ToolExecutionContext) -> Result<ToolCompletion, ExecutionError> {
        match &self.request {
            Request::Describe(args) => Ok(ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: self.describe(args)?.into(),
            }),
            Request::Invoke(args) => {
                let nested = self.owner.catalog.lock().map_err(error)?.nested_tools();
                let receipt = nested.invoke(
                    &context.operation_id,
                    &varin_runtime::ExecutorOwner::Kernel,
                    NestedToolInput {
                        call_id: "target".into(),
                        name: args.reference.name.clone(),
                        arguments: args.arguments.clone(),
                    },
                )?;
                let (outcome, completion, output) = match receipt.completion {
                    ToolCompletion::Result {
                        outcome,
                        effect,
                        content,
                    } => (
                        outcome,
                        json!({"kind":"result","outcome":outcome,"effect":effect}),
                        content,
                    ),
                    ToolCompletion::JobAccepted {
                        operation_id,
                        phase,
                        effect,
                        lifetime,
                        content,
                    } => (
                        Outcome::Succeeded,
                        json!({"kind":"job_accepted","operationId":operation_id,"phase":phase,"effect":effect,"lifetime":lifetime}),
                        content.unwrap_or_else(|| Value::Null.into()),
                    ),
                    ToolCompletion::NotDispatched { reason } => (
                        Outcome::Failed,
                        json!({"kind":"not_dispatched","reason":reason}),
                        Value::Null.into(),
                    ),
                };
                Ok(ToolCompletion::Result {
                    outcome,
                    effect: Effect::None,
                    content: varin_runtime::output::OutputBody {
                        data: json!({"reference":args.reference,"operationId":receipt.operation_id,"completion":completion,"result":output.data}),
                        parts: output.parts,
                    },
                })
            }
        }
    }
}
impl PreparedToolCall for Call {
    fn requires_operation(&self) -> bool {
        matches!(self.request, Request::Invoke(_))
    }
    fn plan(&self, _: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        Ok(ToolPreparation::Ready(contract(&self.name)))
    }
    fn prepare(&self, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        Ok(contract(&self.name))
    }
    fn execution_class(
        &self,
        _: &ToolContract,
    ) -> varin_runtime::execution_capacity::ExecutionClass {
        varin_runtime::execution_capacity::ExecutionClass::Unmetered
    }
    fn watch_admission(
        &self,
        _: &ToolExecutionContext,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        Ok(None)
    }
    fn supports_policy_read(&self, _: &ToolContract) -> bool {
        matches!(self.request, Request::Describe(_))
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        actual: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled()
            || context.run_id != self.frozen.run_id
            || context.origin != self.frozen.origin
            || actual != &contract(&self.name)
        {
            return Err(error("disclosure invocation changed or cancelled"));
        }
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        actual: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        let result = self
            .authorize(context, actual, cancel)
            .and_then(|_| self.run(context));
        ToolExecutionReceipt::local(
            result.unwrap_or_else(|err| ToolCompletion::Result {
                outcome: Outcome::Failed,
                effect: Effect::None,
                content: json!({"code":err.code,"message":err.message}).into(),
            }),
            actual,
        )
    }
}

#[cfg(test)]
#[path = "capability_tools_review.rs"]
mod tests;
