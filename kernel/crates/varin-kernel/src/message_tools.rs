//! The send endpoint is an ordinary durable-effect tool for either original execution origin.
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::messages::{self, MessageInput, MessagePreparation};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Lifetime};
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("message_send", e.to_string())
}
pub(crate) fn builtin_schema() -> crate::run_tools::BuiltinSchema {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::{Retrieval, Worker},
        ChildSourceRequirement::None,
    };
    crate::run_tools::BuiltinSchema::child(schema(), None, &[Worker, Retrieval])
}
pub(crate) fn schema() -> ToolSchema {
    let mut schema = ToolSchema { requirements: None, name:messages::SEND_TOOL.into(),version:"5".into(),description:"Send a durable inform or request message to another member of this task family. Accepts a stable Agent short code in targetThreadId; branch may be omitted for the delegated branch. Optional sourceAgent selects a related Agent’s file stage for the next execution of an isolated child, preserving its own changes. Optional name updates the purpose name with this request. Set afterCurrent:true to queue separate work after the current execution rather than changing its active task. Use replyTo from a message received on your branch. An explicit reply target must match the original sender. Attachments select a fixed file reference or a path in your current Source. Text may be empty when attachments are supplied. An inform is retained for the target's next normal processing and does not start or wake a model. Returns an accepted message ID, not proof that the target handled it. A request enters an active Run at a closed input boundary or starts a new idle Run, while preserving explicit pauses, unanswered questions and Goal limits. An explicit wait:{} observes only an actual replyTo this message without a deadline; wait:{timeoutMs:N} fixes a deadline at acceptance (0 ends immediately). It returns the original operation handle and parks this Run until all its observations end. Cancelling observation never withdraws the accepted message.".into(),output_schema:None,metadata:None,
        schema:json!({"type":"object","properties":{"afterCurrent":{"type":"boolean","description":"Deliver after the recipient current Run ends, rather than at its next model request. Inform remains passive and does not wake a model."},"sourceAgent":{"type":"string","minLength":1},"name":{"type":"string","minLength":1},"targetThreadId":{"type":"string","minLength":1},"targetBranchId":{"type":"string","minLength":1},"replyTo":{"type":"string","minLength":1},"kind":{"type":"string","enum":["inform","request"]},"text":{"type":"string"},"wait":{"type":"object","properties":{"timeoutMs":{"type":"integer","minimum":0,"maximum":9007199254740991u64}},"additionalProperties":false}},"required":["kind"],"anyOf":[{"required":["text"],"properties":{"text":{"minLength":1}}},{"required":["attachments"],"properties":{"attachments":{"minItems":1}}}],"additionalProperties":false}) };
    schema.schema["properties"]["attachments"] = crate::attachment_tools::selector_schema();
    schema
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
        Arc::new(MessageTools { catalog, attachments: None }),
    )
}
pub(crate) fn declaration_with_attachments(
    catalog: Arc<Mutex<Catalog>>, bridge: crate::host_query::OwnerChannel,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(), Arc::new(MessageTools { catalog, attachments: Some(bridge) }),
    )
}
struct MessageTools {
    catalog: Arc<Mutex<Catalog>>,
    attachments: Option<crate::host_query::OwnerChannel>,
}
impl MessageTools {
    fn external(&self, context: &ToolExecutionContext, call: &ToolCall)
        -> Result<Option<varin_runtime::catalog::external_messages::Preparation>, ExecutionError> {
        let input = input(call)?;
        let db = self.catalog.lock().map_err(error)?;
        let Some(target) = input.target_thread_id.as_deref() else { return Ok(None); };
        if db.external_message_target(&context.run_id, target).map_err(error)?.is_none() { return Ok(None); }
        db.prepare_external_message(context, call.clone(), input).map(Some).map_err(error)
    }
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
            completion: if waiting {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if waiting {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
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
        // Routing and the frozen original call are checked before attachment I/O.
        if self.external(context, call)?.is_none() { self.capture(context, call)?; }
        crate::attachment_tools::authorize_invocation(&self.catalog, context, call)?;
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| -> Result<ToolCompletion, ExecutionError> {
            let selections = input(call)?.attachments;
            if let Some(preparation) = self.external(context, call)? {
                if let Some(attachments) = preparation.existing_attachments().map_err(error)? {
                    let prepared = preparation.with_attachments(attachments).load().map_err(error)?;
                    return self.catalog.lock().map_err(error)?.admit_external_message(prepared).map_err(error);
                }
                let (target, branch) = preparation.target();
                let attachments = crate::attachment_tools::prepare(self.attachments.as_ref(),
                    &self.catalog, context, call, target, branch, &selections, cancel)?;
                let admission = (|| {
                    let prepared = preparation.with_attachments(attachments.attachments.clone()).load().map_err(error)?;
                    if cancel.is_cancelled() { return Err(error("send cancelled before acceptance")); }
                    self.catalog.lock().map_err(error)?.admit_external_message(prepared).map_err(error)
                })();
                return admission.map_err(|mut failure| { attachments.release_failed(&self.catalog, &mut failure); failure });
            }
            let preparation = self.capture(context, call)?;
            let identity = preparation.identity();
            let delivered = self.catalog.lock().map_err(error)?
                .attachment_delivery("input", &identity.message_id).map_err(error)?;
            if let Some(delivery) = delivered {
                // An accepted retry restores the original receipt without reading a changed
                // path or releasing a file merely because this observation was cancelled.
                let prepared = preparation.with_attachments(delivery.attachments).load().map_err(error)?;
                return self.catalog.lock().map_err(error)?.admit_message(prepared).map_err(error)?
                    .completion.ok_or_else(|| error("send completion missing"));
            }
            let mut attachments = crate::attachment_tools::prepare(self.attachments.as_ref(),
                &self.catalog, context, call, &identity.target_thread_id, &identity.target_branch_id,
                &selections, cancel)?;
            let admission = (|| {
                attachments.hydrate_images(context, cancel)?;
                let prepared = preparation.with_attachments(attachments.attachments.clone())
                    .with_attachment_media(std::mem::take(&mut attachments.media)).load().map_err(error)?;
                let mut catalog = self.catalog.lock().map_err(error)?;
                if cancel.is_cancelled() { return Err(error("send cancelled before acceptance")); }
                let accepted = catalog.admit_message(prepared).map_err(error)?;
                accepted.completion.ok_or_else(|| error("send completion missing"))
            })();
            admission.map_err(|mut failure| { attachments.release_failed(&self.catalog, &mut failure); failure })
        })();
        result.unwrap_or_else(|failure| ToolCompletion::not_dispatched(failure))
    }
}

#[cfg(test)]
mod attachment_input_review {
    use super::*;
    #[test]
    fn attachment_only_send_is_valid_but_empty_or_ambiguous_file_selection_is_not() {
        let call = |arguments| ToolCall { call_id:"send-file".into(),name:"send".into(),schema_version:schema().version,arguments };
        let accepted = input(&call(json!({"kind":"inform","targetThreadId":"peer","attachments":[{"ref":"attachment:original"}]}))).unwrap();
        assert!(accepted.text.is_empty());
        assert_eq!(accepted.attachments.len(),1);
        for arguments in [
            json!({"kind":"inform","targetThreadId":"peer"}),
            json!({"kind":"inform","targetThreadId":"peer","text":"  ","attachments":[]}),
            json!({"kind":"inform","targetThreadId":"peer","attachments":[{"ref":"attachment:original","path":"a.csv"}]}),
            json!({"kind":"inform","targetThreadId":"peer","attachments":[{"ref":"attachment:original","owner":"forged"}]}),
        ] { assert!(input(&call(arguments)).is_err()); }
        let text = input(&call(json!({"kind":"inform","targetThreadId":"peer","text":"Discuss attachment:original and ./a.csv"}))).unwrap();
        assert!(text.attachments.is_empty(),"prose does not grant file access");
    }
}

#[cfg(test)]
#[path = "message_attachment_review.rs"]
mod attachment_delivery_review;
