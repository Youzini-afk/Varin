//! A delegated source boundary is taken beside the native mount. Only metadata
//! and the original durable handoff return to Storage's control thread.
use crate::{
    error::KernelError, model::Grant, storage::workspace_session::StoragePort, tools::ToolBinding,
};
use serde_json::Value;
use std::sync::{Arc, atomic::AtomicBool};
use varin_runtime::{
    catalog::{dispatch::ChildSourceDelegation, launches::SourceSelection},
    execution::ToolExecutionContext,
};

#[derive(Clone)]
pub(crate) struct Task {
    pub binding: ToolBinding,
    pub context: ToolExecutionContext,
    pub delegation: ChildSourceDelegation,
    pub grant: Grant,
    pub source: SourceSelection,
    pub cancellation: Arc<AtomicBool>,
}
impl Task {
    pub(crate) fn run(
        &self,
        workspaces: &crate::workspace_resources::Workspaces,
        port: StoragePort,
    ) -> Result<Value, KernelError> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            workspaces.handoff(self, port.clone())
        }))
        .unwrap_or_else(|_| Err(KernelError::Storage("Native source worker panicked".into())));
        if result.is_err() {
            let operation = format!("child-source-handoff:{}", self.context.operation_id);
            port.call(move |storage| storage.discard_native_handoff(&operation))?;
        }
        result
    }
}
