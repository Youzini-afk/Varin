//! Public registration bodies and detail reads stay on request workers.
use super::*;
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    resources: crate::tools::KernelResourceClient,
    method: &str,
    params: Value,
    cancel: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancel.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    match method {
        "runtime.followup.register" => {
            let p: FollowupRegisterParams = serde_json::from_value(params)?;
            let process=if let varin_runtime::catalog::followups::FollowupRegistrationTrigger::ProcessStopped{operation_id}=&p.trigger{Some(operation_id.clone())}else{None};
            let input = varin_runtime::catalog::followups::FollowupRegistration {
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
            let prepared = capture.load().map_err(domain)?;
            if cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let result = runtime
                .catalog()
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .admit_followup_registration(prepared)
                .map_err(domain)?;
            if let Some(process) = process {
                resources.replay_process_terminals(vec![process])?;
            }
            Ok(serde_json::to_value(result.followup)?)
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
