//! Trusted asset-owner commands. Only body-bearing preparation uses independent request workers;
//! durable occurrence controls remain short and never wait for model/source/calendar arithmetic.
use super::*;
fn number(value: i64) -> Result<u64, KernelError> {
    u64::try_from(value)
        .map_err(|_| KernelError::Protocol("calendar revision must be nonnegative".into()))
}
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancel: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancel.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let catalog = runtime.catalog();
    let lock = || {
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))
    };
    match method {
        "runtime.calendar.sync" => {
            let p: CalendarSyncParams = serde_json::from_value(params)?;
            let preparation = lock()?
                .prepare_calendar_sync(
                    p.project_id,
                    p.expected_revision.0.map(number).transpose()?,
                    p.definitions,
                )
                .map_err(domain)?;
            let prepared = preparation.load().map_err(domain)?;
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                lock()?.admit_calendar_sync(prepared).map_err(domain)?,
            )?)
        }
        "runtime.calendar.projects" => Ok(serde_json::to_value(
            lock()?.calendar_projects().map_err(domain)?,
        )?),
        "runtime.calendar.list" => {
            let p: CalendarProjectParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?.calendar_project(&p.project_id).map_err(domain)?,
            )?)
        }
        "runtime.calendar.occurrences" => {
            let p: CalendarDefinitionParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .calendar_occurrences(&p.definition_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.run" => {
            let p: CalendarRunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .run_calendar_now(&p.definition_id, number(p.expected_revision)?, &p.key)
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.occurrence.control" => {
            let p: CalendarOccurrenceControlParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .control_calendar_occurrence(
                        &p.occurrence_id,
                        number(p.expected_revision)?,
                        p.action,
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.calculated" => {
            let p: CalendarCalculatedParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .admit_calendar_calculation(p.calculation, p.result.0, p.failure_code.0)
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.calculation.retry" => {
            let p: CalendarCalculationRetryParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .retry_calendar_calculation(&p.definition_id, number(p.expected_revision)?)
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.pending" => Ok(serde_json::to_value(
            lock()?.calendar_pending().map_err(domain)?,
        )?),
        "runtime.calendar.preparation.failed" => {
            let p: CalendarPreparationFailedParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .fail_calendar_preparation(
                        &p.occurrence_id,
                        number(p.expected_revision)?,
                        number(p.owner_epoch)?,
                        &p.failure_code,
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.calendar.prepare" => {
            let p: CalendarOccurrenceParams = serde_json::from_value(params)?;
            let read = lock()?
                .capture_calendar_preparation(&p.occurrence_id)
                .map_err(domain)?;
            let result = read.load().map_err(domain)?;
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(result)?)
        }
        "runtime.calendar.admit" => {
            // The original receipt is authoritative before decoding a later replacement candidate.
            let id = params
                .get("occurrenceId")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Protocol("calendar occurrence required".into()))?;
            let original = lock()?.calendar_occurrence(id).map_err(domain)?;
            if original.run_id.is_some() {
                return Ok(serde_json::to_value(original)?);
            }
            let p: CalendarAdmitParams = serde_json::from_value(params)?;
            validate_configuration(&p.configuration)?;
            if p.launch.inherit_source == Some(true) {
                return Err(KernelError::Protocol(
                    "new calendar work requires its actual source selection".into(),
                ));
            }
            let launch = input_commands::selected_launch(&p.configuration, p.launch, true)?;
            let basis = p
                .initial_context
                .personalization
                .map(personalization_basis)
                .transpose()?
                .ok_or_else(|| {
                    KernelError::Protocol("calendar context requires its actual scope".into())
                })?;
            let initial = varin_runtime::catalog::context::ContextProposal {
                key: format!("initial-context:{}", original.branch_id),
                branch_id: original.branch_id,
                through_id: None,
                expected_revision: 0,
                summary: String::new(),
                effective_system_prompt: p.initial_context.effective_system_prompt,
                instruction_sources: p.initial_context.instruction_sources,
                memory_checkpoint: p.initial_context.memory_checkpoint.0,
            };
            let preparation = lock()?
                .prepare_calendar_submission(
                    &p.occurrence_id,
                    number(p.expected_revision)?,
                    number(p.owner_epoch)?,
                    p.configuration,
                    initial,
                    basis,
                    p.initial_context.resources,
                    p.input_preparation,
                )
                .map_err(domain)?;
            let prepared = preparation.load(launch).map_err(domain)?;
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                lock()?
                    .admit_calendar_submission(prepared)
                    .map_err(domain)?,
            )?)
        }
        _ => Err(KernelError::Protocol("unknown calendar command".into())),
    }
}
