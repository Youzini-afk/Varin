//! Public registration bodies and detail reads stay on request workers.
use super::*;
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    resources: crate::tools::KernelResourceClient,
    method: &str,
    params: Value,
    cancel: &AtomicBool,
    wake_cancel: Option<varin_runtime::execution::CancellationToken>,
) -> Result<Value, KernelError> {
    if cancel.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    match method {
        "runtime.followup.register" => {
            let p: FollowupRegisterAdmissionParams = serde_json::from_value(params)?;
            let processes = p.trigger.process_operation_ids();
            let input = varin_runtime::catalog::followups::FollowupRegistration {
                repeat: p.repeat.unwrap_or_default(),
                trigger: p.trigger,
                instruction: p.instruction,
                wait: None,
            };
            let capture = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_followup_registration(&p.key, &p.run_id, input)
                .map_err(domain)?;
            let mut prepared = capture.load().map_err(domain)?;
            let _file_guard = if !prepared.already_accepted()
                && !prepared.file_requests().map_err(domain)?.is_empty()
            {
                let authority = p.file_authority.ok_or_else(|| {
                    KernelError::Authorization(
                        "User file registration requires current bounded source authority".into(),
                    )
                })?;
                let files = resources.file_observations.as_ref().ok_or_else(|| {
                    KernelError::Storage("file observation owner unavailable".into())
                })?;
                Some(files.prepare_registration(
                    &runtime.catalog(),
                    &mut prepared,
                    &authority.grant_id,
                    None,
                    wake_cancel.as_ref().ok_or(KernelError::Cancelled)?,
                )?)
            } else {
                None
            };
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let admission = {
                let catalog = runtime.catalog();
                let mut owner = catalog
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                owner.admit_followup_registration(prepared)
            };
            let result = admission.map_err(domain)?;
            if !processes.is_empty() {
                resources.replay_process_terminals(processes)?;
            }
            Ok(serde_json::to_value(result.followup)?)
        }
        "runtime.followup.registrations.pending" => {
            let p: FollowupPendingParams = serde_json::from_value(params)?;
            resources
                .file_observations
                .as_ref()
                .ok_or_else(|| KernelError::Storage("file observation owner unavailable".into()))?
                .pending_registrations(&runtime.catalog(), &p.thread_id, &p.branch_id, p.after)
        }
        "runtime.followup.registration.cancel" => {
            let p: FollowupRegistrationCancelParams = serde_json::from_value(params)?;
            resources
                .file_observations
                .as_ref()
                .ok_or_else(|| KernelError::Storage("file observation owner unavailable".into()))?
                .cancel_registration(&runtime.catalog(), &p.key, &p.run_id)
        }
        "runtime.followup.files" => {
            let p: FollowupFilesParams = serde_json::from_value(params)?;
            resources
                .file_observations
                .as_ref()
                .ok_or_else(|| KernelError::Storage("file observation owner unavailable".into()))?
                .bindings(&runtime.catalog(), p.after.as_deref())
        }
        "runtime.followup.file.observe" | "runtime.followup.file.release" => {
            let reopen = params
                .get("reopen")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut identity = params;
            identity
                .as_object_mut()
                .ok_or_else(|| KernelError::Protocol("file binding required".into()))?
                .remove("reopen");
            let key: varin_runtime::catalog::followups::FileObservationKey =
                serde_json::from_value(identity)?;
            let files = resources
                .file_observations
                .as_ref()
                .ok_or_else(|| KernelError::Storage("file observation owner unavailable".into()))?;
            if method == "runtime.followup.file.observe" {
                files.reconcile(
                    &runtime.catalog(),
                    key,
                    reopen,
                    wake_cancel.as_ref().ok_or(KernelError::Cancelled)?,
                )
            } else {
                let work = runtime
                    .catalog()
                    .lock()
                    .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
                    .followup_file_release_work(&key)
                    .map_err(domain)?;
                let released = files.release(&work)?;
                if released {
                    runtime
                        .catalog()
                        .lock()
                        .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
                        .confirm_file_observation_released(&key)
                        .map_err(domain)?;
                }
                Ok(json!({"released":released}))
            }
        }
        "runtime.followup.research" => {
            let p: FollowupResearchWorksParams = serde_json::from_value(params)?;
            let (works, next) = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
                .followup_research_works(p.after.as_deref())
                .map_err(domain)?;
            Ok(json!({"works":works,"nextCursor":next}))
        }
        "runtime.followup.research.observe" => {
            let p = serde_json::from_value(params)?;
            let prepare = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
                .prepare_research_observation(p)
                .map_err(domain)?;
            let Some(prepare) = prepare else {
                return Ok(json!({"accepted":false}));
            };
            let prepared = prepare.load().map_err(domain)?;
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let accepted = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
                .apply_research_observation(prepared)
                .map_err(domain)?;
            Ok(json!({"accepted":accepted}))
        }
        "runtime.followup.occurrence" => {
            let p: FollowupOccurrenceGetParams = serde_json::from_value(params)?;
            let read = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
                .capture_followup_occurrence(&p.followup_id, &p.occurrence_id)
                .map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.followup.occurrences" => {
            let p: FollowupOccurrencesParams = serde_json::from_value(params)?;
            let after = p.after.map(u64::try_from).transpose().map_err(|_| {
                KernelError::Protocol("follow-up occurrence cursor must be nonnegative".into())
            })?;
            let value = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .followup_occurrences(&p.followup_id, after)
                .map_err(domain)?;
            Ok(serde_json::to_value(value)?)
        }
        "runtime.followup.get" => {
            let p: FollowupGetParams = serde_json::from_value(params)?;
            let capture = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .capture_followup(&p.followup_id)
                .map_err(domain)?;
            let value = capture.load().map_err(domain)?;
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(value)?)
        }
        _ => Err(KernelError::Protocol("unknown follow-up method".into())),
    }
}
