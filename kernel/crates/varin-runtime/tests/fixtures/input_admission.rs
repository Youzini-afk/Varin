//! Test driver for the public capture → body worker → commit contracts. Production has no
//! synchronous body-bearing Catalog API; fixtures run these steps sequentially for convenience.
use serde_json::Value;
use varin_runtime::catalog::{
    collaboration::ChildTask,
    context::ContextProposal,
    inputs::{EnqueueInput, InputReceipt, QueuedInput},
    launches::{LaunchSelection, SourceSelection},
    personalization::PersonalizationBasis,
};
use varin_runtime::{Catalog, Receipt, RuntimeError, SubmitInput};
type Result<T> = std::result::Result<T, RuntimeError>;

#[allow(dead_code)]
pub trait InputAdmission {
    fn submit(&mut self, command: &SubmitInput) -> Result<Receipt>;
    fn submit_with_launch(
        &mut self,
        command: &SubmitInput,
        launch: Option<LaunchSelection>,
    ) -> Result<Receipt>;
    fn submit_with_inherited_source(
        &mut self,
        command: &SubmitInput,
        launch: LaunchSelection,
    ) -> Result<Receipt>;
    fn submit_with_initial_context(
        &mut self,
        command: &SubmitInput,
        launch: Option<LaunchSelection>,
        inherit: bool,
        initial: Option<ContextProposal>,
    ) -> Result<Receipt>;
    fn submit_with_context_snapshot(
        &mut self,
        command: &SubmitInput,
        launch: Option<LaunchSelection>,
        inherit: bool,
        initial: Option<ContextProposal>,
        basis: Option<PersonalizationBasis>,
    ) -> Result<Receipt>;
    fn enqueue_input(&mut self, command: &EnqueueInput) -> Result<InputReceipt>;
    fn queued_input(&self, id: &str) -> Result<QueuedInput>;
    fn queued_inputs(&self, branch: &str) -> Result<Vec<QueuedInput>>;
    fn edit_queued_input(&mut self, id: &str, revision: u64, content: Value)
        -> Result<QueuedInput>;
    fn cancel_queued_input(&mut self, id: &str, revision: u64) -> Result<QueuedInput>;
    fn consume_inputs(
        &mut self,
        run: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<Vec<varin_runtime::execution::ConversationItem>>;
    fn prepare_child(
        &mut self,
        operation: &str,
        source: SourceSelection,
        proposal: ContextProposal,
        basis: PersonalizationBasis,
    ) -> Result<ChildTask>;
}
impl InputAdmission for Catalog {
    fn submit(&mut self, command: &SubmitInput) -> Result<Receipt> {
        self.submit_with_launch(command, None)
    }
    fn submit_with_launch(
        &mut self,
        command: &SubmitInput,
        launch: Option<LaunchSelection>,
    ) -> Result<Receipt> {
        self.submit_with_context_snapshot(command, launch, false, None, None)
    }
    fn submit_with_inherited_source(
        &mut self,
        command: &SubmitInput,
        launch: LaunchSelection,
    ) -> Result<Receipt> {
        self.submit_with_context_snapshot(command, Some(launch), true, None, None)
    }
    fn submit_with_initial_context(
        &mut self,
        command: &SubmitInput,
        launch: Option<LaunchSelection>,
        inherit: bool,
        initial: Option<ContextProposal>,
    ) -> Result<Receipt> {
        self.submit_with_context_snapshot(command, launch, inherit, initial, None)
    }
    fn submit_with_context_snapshot(
        &mut self,
        command: &SubmitInput,
        launch: Option<LaunchSelection>,
        inherit: bool,
        initial: Option<ContextProposal>,
        basis: Option<PersonalizationBasis>,
    ) -> Result<Receipt> {
        let preparation = self.prepare_submission(command.clone(), initial, basis)?;
        let prepared = preparation.load(launch, inherit)?;
        self.admit_submission(prepared)
    }
    fn enqueue_input(&mut self, command: &EnqueueInput) -> Result<InputReceipt> {
        let prepared = self.prepare_enqueue(command.clone()).load()?;
        self.admit_queued_input(prepared)
    }
    fn queued_input(&self, id: &str) -> Result<QueuedInput> {
        self.capture_queued_input(id)?.load()
    }
    fn queued_inputs(&self, branch: &str) -> Result<Vec<QueuedInput>> {
        self.capture_queued_inputs(branch)?
            .into_iter()
            .map(|read| read.load())
            .collect()
    }
    fn edit_queued_input(
        &mut self,
        id: &str,
        revision: u64,
        content: Value,
    ) -> Result<QueuedInput> {
        let prepared = self.prepare_input_edit(id, revision, content)?.load()?;
        self.admit_input_edit(prepared)?.load()
    }
    fn cancel_queued_input(&mut self, id: &str, revision: u64) -> Result<QueuedInput> {
        self.cancel_input(id, revision)?.load()
    }
    fn consume_inputs(
        &mut self,
        run: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<Vec<varin_runtime::execution::ConversationItem>> {
        loop {
            let prepared = self.prepare_input_delivery(run, epoch, head)?.load()?;
            if let Some(items) = self.admit_input_delivery(prepared)? {
                return Ok(items);
            }
        }
    }
    fn prepare_child(
        &mut self,
        operation: &str,
        source: SourceSelection,
        proposal: ContextProposal,
        basis: PersonalizationBasis,
    ) -> Result<ChildTask> {
        let prepared = self
            .capture_child_preparation(operation, source, proposal, basis)?
            .load()?;
        self.admit_child(prepared)
    }
}
