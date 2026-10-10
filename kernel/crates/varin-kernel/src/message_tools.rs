//! The send endpoint is an ordinary durable-effect tool for either original execution origin.
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::messages::{self, MessageInput, MessagePreparation};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Lifetime};
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("message_send", e.to_string())
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name:messages::SEND_TOOL.into(),version:"3".into(),description:"Send a durable inform or request message to another member of this task family. Requires targetThreadId and targetBranchId, or replyTo from a message received on your branch. An explicit reply target must match the original sender. An inform is retained for the target's next normal processing and does not start or wake a model. Returns an accepted message ID, not proof that the target handled it. A request enters an active Run at a closed input boundary or starts a new idle Run, while preserving explicit pauses, unanswered questions and Goal limits. An explicit wait:{} observes only an actual replyTo this message without a deadline; wait:{timeoutMs:N} fixes a deadline at acceptance (0 ends immediately). It returns the original operation handle and parks this Run until all its observations end. Cancelling observation never withdraws the accepted message.".into(),output_schema:None,metadata:None,
        schema:json!({"type":"object","properties":{"targetThreadId":{"type":"string","minLength":1},"targetBranchId":{"type":"string","minLength":1},"replyTo":{"type":"string","minLength":1},"kind":{"type":"string","enum":["inform","request"]},"text":{"type":"string","minLength":1},"wait":{"type":"object","properties":{"timeoutMs":{"type":"integer","minimum":0,"maximum":9007199254740991u64}},"additionalProperties":false}},"required":["kind","text"],"additionalProperties":false}) }
}
fn input(call: &ToolCall) -> Result<MessageInput, ExecutionError> {
    let input: MessageInput = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    input.validate().map_err(error)?;
    Ok(input)
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(MessageTools { catalog }),
    )
}
struct MessageTools {
    catalog: Arc<Mutex<Catalog>>,
}
impl MessageTools {
    fn capture(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
    ) -> Result<MessagePreparation, ExecutionError> {
        let input = input(call)?;
        let schema = schema();
        let call = call.clone();
        self.catalog
            .lock()
            .map_err(error)?
            .prepare_tool_message(context, call, schema, input)
            .map_err(error)
    }
}
impl ToolExecutor for MessageTools {
    fn plan(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, request, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("send cancelled"));
        }
        let selected = schema();
        if call.name != selected.name
            || call.schema_version != selected.version
            || !request.tools.contains(&selected)
        {
            return Err(error("send was not selected in this frozen invocation"));
        }
        let waiting = input(call)?.wait.is_some();
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: false,
            completion: if waiting { CompletionKind::Job } else { CompletionKind::Result },
            lifetime: if waiting { Lifetime::Thread } else { Lifetime::Run },
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("send cancelled"));
        }
        let prepared = self.capture(context, call)?.load().map_err(error)?;
        if cancel.is_cancelled() {
            return Err(error("send cancelled"));
        }
        self.catalog
            .lock()
            .map_err(error)?
            .authorize_message(&prepared)
            .map_err(error)
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| -> Result<ToolCompletion, ExecutionError> {
            let prepared = self.capture(context, call)?.load().map_err(error)?;
            let mut catalog = self.catalog.lock().map_err(error)?;
            if cancel.is_cancelled() {
                return Err(error("send cancelled before acceptance"));
            }
            let accepted = catalog.admit_message(prepared).map_err(error)?;
            accepted
                .completion
                .ok_or_else(|| error("send completion missing"))
        })();
        result.unwrap_or_else(|failure| ToolCompletion::NotDispatched {
            reason: failure.message,
        })
    }
}
