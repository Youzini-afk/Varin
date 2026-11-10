//! Rebind frozen child declarations to compatible built-in implementations only.
//! Host contributions enter assembly afterward and retain their exact identity checks.
use std::sync::Arc;
use varin_runtime::composition::tools::ToolDeclaration;
use varin_runtime::execution::*;

pub(super) fn retain(
    declarations: Vec<ToolDeclaration>,
    admitted: &[ToolSchema],
) -> Vec<ToolDeclaration> {
    declarations
        .into_iter()
        .filter_map(|mut declaration| {
            let original = admitted
                .iter()
                .find(|schema| schema.name == declaration.schema.name)?;
            // This input consists exclusively of the built-ins selected by RunAssembly,
            // not arbitrary name-matched MCP or extension declarations. Equal versions
            // retain the built-in contract even when its descriptions/schema presentation
            // changed. Native resource owners additionally support frozen v1 arguments.
            let compatible = crate::child_capabilities::supports_frozen_builtin(original, &declaration.schema);
            if !compatible {
                return None;
            }
            if original != &declaration.schema {
                declaration.implementation = Arc::new(FrozenBuiltin {
                    admitted: original.clone(),
                    implementation_schema: declaration.schema.clone(),
                    inner: declaration.implementation,
                });
                // The original declaration remains authoritative in the directory,
                // model requests and persisted launch. Keep content_version tied to
                // the actual implementation; do not pretend it is the old executable.
                declaration.schema = original.clone();
            }
            Some(declaration)
        })
        .collect()
}

struct FrozenBuiltin {
    admitted: ToolSchema,
    implementation_schema: ToolSchema,
    inner: Arc<dyn ToolExecutor>,
}
impl FrozenBuiltin {
    fn bind(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        if call.name != self.admitted.name
            || call.schema_version != self.admitted.version
            || !frozen.tools.contains(&self.admitted)
        {
            return Err(ExecutionError::new(
                "stale_tool_schema",
                "call differs from the child's original built-in declaration",
            ));
        }
        let mut implementation_context = frozen.clone();
        let mut schemas = frozen.tools.as_ref().clone();
        let selected = schemas
            .iter_mut()
            .find(|schema| **schema == self.admitted)
            .expect("original declaration checked");
        *selected = self.implementation_schema.clone();
        implementation_context.tools = Arc::new(schemas);
        // Only the implementation's schema check is adapted. The original call,
        // version, Run/source, grant, origin and all other capabilities stay fixed.
        // Return its actual bound invocation, including admission/revocation,
        // execution owner, receipts and cleanup, rather than wrapping that lifecycle.
        self.inner
            .clone()
            .bind_call(call, &implementation_context, cancel)
    }
}
impl ToolExecutor for FrozenBuiltin {
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        self.bind(call, frozen, cancel)
    }
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.bind(call, frozen, cancel)?.plan(cancel)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        self.bind(call, frozen, cancel)?.prepare(cancel)
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(ExecutionError::new(
            "prepared_call_required",
            "bind the original child invocation before authorization",
        ))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "bind the original child invocation before dispatch".into(),
            error: None,
        }
    }
}
