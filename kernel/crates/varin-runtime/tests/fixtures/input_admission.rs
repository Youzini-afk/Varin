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
    fn settle_operation(&mut self, key: &str, epoch: u64, outcome: varin_runtime::Outcome, effect: varin_runtime::Effect, result: Value) -> Result<varin_runtime::OperationMetadata>;
    fn record_external_receipt(&mut self, key: &str, receipt: varin_runtime::ExternalReceipt) -> Result<varin_runtime::OperationMetadata>;
    fn record_external_receipt_with_stop(&mut self, key: &str, receipt: varin_runtime::ExternalReceipt, stopped: bool) -> Result<varin_runtime::OperationMetadata>;
    fn deliver_process_waits(&mut self) -> Result<Vec<String>>;
    fn reconcile_child_reports(&mut self) -> Result<()>;
    fn settle_child_receipts(&mut self) -> Result<()>;
    fn deliver_child_waits(&mut self) -> Result<Vec<String>>;
    fn cancel_child_wait(&mut self, id: &str) -> Result<varin_runtime::Wait>;

    fn fork_branch(&mut self, source: &str, target: &str, head: Option<&str>) -> Result<()>;
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
    fn settle_operation(&mut self, key: &str, epoch: u64, outcome: varin_runtime::Outcome, effect: varin_runtime::Effect, result: Value) -> Result<varin_runtime::OperationMetadata> {
        let prepared = self.prepare_result_content().write_result(&result)?;
        self.settle_operation_prepared(key, epoch, outcome, effect, prepared)
    }
    fn record_external_receipt(&mut self, key: &str, receipt: varin_runtime::ExternalReceipt) -> Result<varin_runtime::OperationMetadata> {
        let stopped = receipt.outcome != varin_runtime::Outcome::Indeterminate;
        self.record_external_receipt_with_stop(key, receipt, stopped)
    }
    fn record_external_receipt_with_stop(&mut self, key: &str, receipt: varin_runtime::ExternalReceipt, stopped: bool) -> Result<varin_runtime::OperationMetadata> {
        let prepared = self.prepare_result_content().write_external_receipt(receipt)?;
        self.record_external_receipt_prepared(key, prepared, stopped)
    }
    fn deliver_process_waits(&mut self) -> Result<Vec<String>> {
        for read in self.capture_process_waits()? { self.admit_process_wait(read.load()?)?; }
        self.pending_process_continuations()
    }
    fn reconcile_child_reports(&mut self) -> Result<()> {
        for report in self.capture_child_reports()?.load()? { self.admit_child_report(report)?; }
        self.settle_child_receipts()
    }
    fn settle_child_receipts(&mut self) -> Result<()> {
        for receipt in self.capture_child_receipts()? {
            let (identity, receipt) = receipt.load()?;
            self.record_external_receipt_prepared(&identity, receipt, true)?;
        }
        Ok(())
    }
    fn deliver_child_waits(&mut self) -> Result<Vec<String>> {
        self.reconcile_child_reports()?;
        for read in self.capture_child_waits()? { self.admit_child_wait(read.load()?)?; }
        self.pending_child_continuations()
    }
    fn cancel_child_wait(&mut self, id: &str) -> Result<varin_runtime::Wait> {
        self.request_cancel_child_wait(id)?;
        self.deliver_child_waits()?;
        self.inspect_child_wait(id)
    }

    fn fork_branch(&mut self, source: &str, target: &str, head: Option<&str>) -> Result<()> {
        let prepared = self
            .prepare_branch_fork(source, target, head, None)?
            .load()?;
        self.admit_branch_fork(prepared).map(|_| ())
    }
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
        let child=self.child_task(operation)?;
        if matches!(child.source,varin_runtime::catalog::collaboration::ChildSource::Pending{..}) {
            let root=child.source.pin().unwrap().root.clone();
            let mut pin_source=source.clone();pin_source.mode=varin_runtime::SourceMode::FixedBranch;
            let prepared=self.prepare_child_source(operation,varin_runtime::catalog::collaboration::ChildSourcePin {
                pin_id:format!("child-source-pin:{operation}"),root:root.clone(),source:pin_source},source.clone(),
                varin_runtime::catalog::collaboration::ChildSourceProvenance::FixedRoot{root})?.load()?;
            self.attach_child_source(prepared)?;
        }
        let prepared = self
            .capture_child_preparation(operation, source, proposal, basis)?
            .load()?;
        self.admit_child(prepared)
    }
}
