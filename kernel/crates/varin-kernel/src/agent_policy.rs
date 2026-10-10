//! Policy control changes contain no extension callbacks or model/provider I/O.
use super::*;
use varin_runtime::execution::PolicyIdentity;

pub(super) fn execute(
    runtime: &Arc<RunSupervisor>,
    bridge: &crate::policy::PolicyBridge,
    credentials: &crate::credential_bridge::CredentialBridge,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let owner = runtime.catalog();
    match method {
        "runtime.policy.select" => {
            let p: PolicySelectParams = serde_json::from_value(params)?;
            let expected = u64::try_from(p.expected_generation).map_err(|_| {
                KernelError::Protocol("policy generation must be nonnegative".into())
            })?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let before = db.policy_selections(&p.run_id).map_err(domain)?.desired;
            let selection = db
                .select_policy(
                    &p.run_id,
                    &p.selection_id,
                    expected,
                    p.expected_selection_id.0,
                    p.target,
                    p.state_mode,
                )
                .map_err(domain)?;
            let current = db
                .policy_selections(&p.run_id)
                .map_err(domain)?
                .desired
                .map(|s| s.selection_id);
            drop(db);
            if let Some(before) = before {
                if current.as_deref() == Some(&selection.selection_id)
                    && before.selection_id != selection.selection_id
                {
                    bridge.cancel_candidate(&p.run_id, &before.selection_id);
                }
            }
            Ok(serde_json::to_value(selection)?)
        }
        "runtime.policy.inspect" => {
            let p: RunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .policy_selections(&p.run_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.policy.cancel" => {
            let p: PolicyCancelParams = serde_json::from_value(params)?;
            let receipt = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .cancel_policy_selection(&p.run_id, &p.selection_id)
                .map_err(domain)?;
            bridge.cancel_candidate(&p.run_id, &p.selection_id);
            Ok(serde_json::to_value(receipt)?)
        }
        "runtime.policy.fail" => {
            let p: PolicyFailParams = serde_json::from_value(params)?;
            let receipt = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .fail_policy_selection(&p.run_id, &p.selection_id, p.code.code())
                .map_err(domain)?;
            bridge.cancel_candidate(&p.run_id, &p.selection_id);
            Ok(serde_json::to_value(receipt)?)
        }
        "runtime.policy.ready" => {
            let p: PolicyReadyParams = serde_json::from_value(params)?;
            let selection = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .policy_selection(&p.run_id, &p.selection_id)
                .map_err(domain)?;
            if p.generation < 0 || p.generation as u64 != selection.generation {
                return Err(KernelError::Authorization(
                    "policy candidate generation changed".into(),
                ));
            }
            Ok(serde_json::to_value(bridge.ready(
                selection,
                p.binding.0,
                p.policy_models,
                credentials,
                cancelled,
            )?)?)
        }
        "runtime.launch.policy.prepare" => {
            let p: PolicyPrepareParams = serde_json::from_value(params)?;
            if p.target.identity()
                != (PolicyIdentity {
                    name: p.identity.name.clone(),
                    version: p.identity.version.clone(),
                })
            {
                return Err(KernelError::Authorization(
                    "policy identity differs from exact target".into(),
                ));
            }
            let identity = crate::policy::effective_identity(p.target.identity());
            let mut models = p.policy_models;
            let roles = match &p.target {
                varin_runtime::catalog::policy_switch::PolicyTarget::Default => Vec::new(),
                varin_runtime::catalog::policy_switch::PolicyTarget::Extension { artifact } => {
                    artifact.model_roles.clone()
                }
            };
            if models
                .iter()
                .map(|m| m.capability_id.clone())
                .collect::<Vec<_>>()
                != roles
            {
                return Err(KernelError::Protocol(
                    "planning capabilities differ from policy roles".into(),
                ));
            }
            for capability in &mut models {
                if capability.binding.is_some() {
                    return Err(KernelError::Protocol(
                        "policy model binding is constructed by owner".into(),
                    ));
                }
                if capability.status == varin_runtime::execution::PolicyModelStatus::Available {
                    capability.binding =
                        Some(bind_policy_model(&p.run_id, capability, credentials)?.binding);
                }
            }
            let preparation = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_policy_change(
                    &p.run_id,
                    crate::observations::default_policy_identity(),
                    identity,
                    models,
                    p.target,
                )
                .map_err(domain)?;
            let prepared = preparation.load().map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let read = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .admit_launch_change(prepared)
                .map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        _ => Err(KernelError::Protocol("unknown policy command".into())),
    }
}
