//! One ordinary policy boundary for all durable dependency observations.
use std::sync::{Arc, Mutex};
use varin_runtime::{execution::*, supervisor::RunStart, Catalog};
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("observation", e.to_string())
}
pub(crate) fn policy_identity(inner: PolicyIdentity) -> PolicyIdentity {
    PolicyIdentity {
        name: format!("{}+observations", inner.name),
        version: format!("{}+1", inner.version),
    }
}
pub(crate) fn default_policy_identity() -> PolicyIdentity {
    policy_identity(crate::questions::default_policy_identity())
}
pub(crate) fn configure(mut start: RunStart, catalog: Arc<Mutex<Catalog>>) -> RunStart {
    start.policy = Arc::new(ObservationPolicy {
        inner: start.policy,
        catalog,
    });
    start
}
pub(crate) struct ObservationPolicy {
    pub(crate) inner: Arc<dyn AgentPolicy>,
    pub(crate) catalog: Arc<Mutex<Catalog>>,
}
impl ObservationPolicy {
    fn pending(&self, view: &PolicyView<'_>) -> Result<Option<String>, ExecutionError> {
        if view.pending_tool_calls != 0 {
            return Ok(None);
        }
        let catalog = self.catalog.lock().map_err(error)?;
        // A genuine user question retains priority and is never implicitly answered by input.
        if catalog
            .pending_question_wait(view.run_id)
            .map_err(error)?
            .is_some()
        {
            return Ok(None);
        }
        catalog.pending_observation_wait(view.run_id).map_err(error)
    }
}
impl AgentPolicy for ObservationPolicy {
    fn identity(&self) -> PolicyIdentity {
        policy_identity(self.inner.identity())
    }
    fn select_for_decision(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &serde_json::Value,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<serde_json::Value>, ExecutionError> {
        if self.pending(view)?.is_some() {
            return Ok(None);
        }
        self.inner
            .select_for_decision(view, event, state, epoch, cancel)
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &serde_json::Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let wait = self.pending(view)?;
        if let Some(id) = &wait {
            if !event.has_execution_failure() {
                return Ok(PolicyDecision {
                    action: PolicyAction::Wait {
                        wait_id: id.clone(),
                    },
                    state: state.clone(),
                });
            }
        }
        let decision = self.inner.decide(view, event, state, cancel)?;
        if matches!(
            decision.action,
            PolicyAction::Fail { .. } | PolicyAction::Wait { .. }
        ) {
            return Ok(decision);
        }
        if let Some(wait_id) = wait {
            return Ok(PolicyDecision {
                action: PolicyAction::Wait { wait_id },
                state: state.clone(),
            });
        }
        Ok(decision)
    }
}
