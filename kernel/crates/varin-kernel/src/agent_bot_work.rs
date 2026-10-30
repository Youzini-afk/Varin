//! First Bot activation prepares the same native ingress and launch as later turns.
use super::*;
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancel: &AtomicBool,
) -> Result<Value, KernelError> {
    let catalog = runtime.catalog();
    let lock = || {
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))
    };
    if cancel.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    if method == "runtime.bot.work.pending" {
        return Ok(serde_json::to_value(
            lock()?.pending_cold_bot_work().map_err(domain)?,
        )?);
    }
    let p: BotWorkAdmitParams = serde_json::from_value(params)?;
    if let Some(receipt) = lock()?
        .cold_bot_work_receipt(&p.work.input_id)
        .map_err(domain)?
    {
        return Ok(serde_json::to_value(receipt)?);
    }
    validate_configuration(&p.configuration)?;
    if p.launch.inherit_source == Some(true) {
        return Err(KernelError::Protocol(
            "first Bot activation needs its actual source selection".into(),
        ));
    }
    let launch = input_commands::selected_launch(&p.configuration, p.launch, true, false)?;
    let basis = p
        .initial_context
        .personalization
        .map(personalization_basis)
        .transpose()?
        .ok_or_else(|| KernelError::Protocol("Bot context needs its actual scope".into()))?;
    let initial = varin_runtime::catalog::context::ContextProposal {
        key: format!("initial-context:{}", p.work.branch_id),
        branch_id: p.work.branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: p.initial_context.effective_system_prompt,
        instruction_sources: p.initial_context.instruction_sources,
        memory_checkpoint: p.initial_context.memory_checkpoint.0,
    };
    let preparation = lock()?
        .prepare_cold_bot_work(
            p.work,
            p.configuration,
            initial,
            basis,
            p.initial_context.resources,
        )
        .map_err(domain)?;
    let prepared = preparation.load(launch).map_err(domain)?;
    if cancel.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let receipt = lock()?.admit_cold_bot_work(prepared).map_err(domain)?;
    Ok(serde_json::to_value(receipt)?)
}
