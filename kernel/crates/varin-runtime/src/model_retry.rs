//! Retry decisions are shared by native generation, Host inference and the settings tester.
//! This module decides only; original execution owners still admit and record every attempt.
use crate::execution::{CancellationToken, ExecutionError, ModelFailure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RetrySettings {
    pub enabled: bool,
    pub max_retries: u64,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub rules: Vec<RetryRule>,
}
impl Default for RetrySettings {
    fn default() -> Self {
        Self { enabled: true, max_retries: 2, initial_delay_ms: 1000, max_delay_ms: 30000, rules: vec![] }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryRule {
    pub field: RetryField,
    pub r#match: RetryMatch,
    pub pattern: String,
    pub action: RetryAction,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryField { Status, Code, Message }
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryMatch { Exact, Contains, Regex }
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryAction { Retry, Stop }
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RetryFailure {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub retry_after_ms: Option<u64>,
    pub should_retry: Option<bool>,
}
impl From<&ModelFailure> for RetryFailure {
    fn from(f: &ModelFailure) -> Self {
        Self { status: f.code.strip_prefix("http_").and_then(|s| s.parse().ok()),
            code: f.code.clone(), message: f.message.clone(), retry_after_ms: f.retry_after_ms, should_retry: None }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryDecision {
    pub retry: bool,
    pub reason: String,
    pub rule_index: Option<usize>,
    pub delay_ms: u64,
}
#[derive(Clone)]
pub struct RetryPolicy { settings: RetrySettings, regexes: Vec<Option<regex::Regex>> }
impl RetryPolicy {
    pub fn new(value: Option<&serde_json::Value>) -> Result<Self, ExecutionError> {
        let settings: RetrySettings = value.map(|v| serde_json::from_value(v.clone())).transpose()
            .map_err(|e| ExecutionError::new("invalid_retry_settings", e.to_string()))?.unwrap_or_default();
        if settings.max_delay_ms < settings.initial_delay_ms {
            return Err(ExecutionError::new("invalid_retry_settings", "Maximum retry delay must be at least the initial delay"));
        }
        let regexes = settings.rules.iter().enumerate().map(|(index, rule)| {
            if rule.pattern.is_empty() { return Err(ExecutionError::new("invalid_retry_settings", format!("Rule {} needs a pattern", index + 1))); }
            match rule.r#match {
                RetryMatch::Regex => regex::Regex::new(&rule.pattern).map(Some)
                    .map_err(|e| ExecutionError::new("invalid_retry_settings", format!("Rule {}: {e}", index + 1))),
                _ => Ok(None),
            }
        }).collect::<Result<Vec<_>, _>>()?;
        Ok(Self { settings, regexes })
    }
    pub fn decide(&self, failure: &RetryFailure, retries_used: u64) -> RetryDecision {
        let stop = |reason: &str| RetryDecision { retry: false, reason: reason.into(), rule_index: None, delay_ms: 0 };
        // These are execution/authority failures, not upstream response matching. User rules
        // cannot resurrect a cancelled worker or revoked provider binding.
        if matches!(failure.code.as_str(), "cancelled" | "model_adapter_revoked" | "credential_scope_changed"
            | "credential_unavailable" | "credential_resolution_failed" | "provider_panicked"
            | "host_credential_failed" | "credential_channel_closed" | "credential_channel_failed"
            | "credential_epoch_changed" | "invalid_credential_scope" | "unknown_credential_ref"
            | "provider_emit_failed" | "event_sink_failed") { return stop("execution_stopped"); }
        if !self.settings.enabled { return stop("disabled"); }
        let mut matched = None;
        let status = failure.status.map(|s| s.to_string()).unwrap_or_default();
        for (index, rule) in self.settings.rules.iter().enumerate() {
            let text = match rule.field { RetryField::Status => &status, RetryField::Code => &failure.code, RetryField::Message => &failure.message };
            let yes = match rule.r#match {
                RetryMatch::Exact => text == &rule.pattern,
                RetryMatch::Contains => text.contains(&rule.pattern),
                RetryMatch::Regex => self.regexes[index].as_ref().expect("compiled regex").is_match(text),
            };
            if yes { matched = Some((index, matches!(rule.action, RetryAction::Retry))); break; }
        }
        let retry = matched.map(|(_, yes)| yes).unwrap_or_else(|| failure.should_retry.unwrap_or_else(||
            matches!(failure.status, Some(408 | 409 | 425 | 429 | 500..=599)) ||
            matches!(failure.code.as_str(), "transport_error" | "stream_interrupted" | "transport_failed" | "timeout"
                | "ECONNRESET" | "ECONNREFUSED" | "ETIMEDOUT" | "EAI_AGAIN" | "UND_ERR_SOCKET" | "UND_ERR_CONNECT_TIMEOUT")));
        let reason = if matched.is_some() { "rule" } else if retry { "transient" } else { "unmatched" };
        if retry && retries_used >= self.settings.max_retries {
            return RetryDecision { rule_index: matched.map(|(i, _)| i), ..stop("exhausted") };
        }
        // Bounded exponential component, with jitter below its cap. Server Retry-After is
        // an independent minimum, including when it exceeds the configured local cap.
        let base = self.settings.initial_delay_ms.saturating_mul(2_u64.checked_pow(retries_used.try_into().unwrap_or(u32::MAX)).unwrap_or(u64::MAX)).min(self.settings.max_delay_ms);
        let random = uuid::Uuid::new_v4().as_u128() as u64;
        let jittered = base.saturating_sub(base / 5) + random % (base / 5 + 1);
        RetryDecision { retry, reason: reason.into(), rule_index: matched.map(|(i, _)| i),
            delay_ms: if retry { jittered.max(failure.retry_after_ms.unwrap_or(0)) } else { 0 } }
    }
}
/// No polling sleep: cancellation wakes the original request immediately.
pub fn wait(cancel: &CancellationToken, delay_ms: u64) -> bool {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let _registration = cancel.wake_on_cancel(tx);
    let _ = rx.recv_timeout(std::time::Duration::from_millis(delay_ms));
    !cancel.is_cancelled()
}

pub fn total_usage<'a>(receipts: impl IntoIterator<Item = &'a crate::execution::UsageReceipt>) -> crate::execution::UsageReceipt {
    use crate::execution::{UsageMeasurement, UsageReceipt};
    let all: Vec<_> = receipts.into_iter().collect();
    if all.len() == 1 { return all[0].clone(); }
    let sum = |field: fn(&UsageReceipt) -> Option<u64>| all.iter().try_fold(0_u64, |n, r| n.checked_add(field(r)?));
    UsageReceipt {
        measurement: if all.iter().any(|r| r.measurement == UsageMeasurement::Missing) { UsageMeasurement::Missing }
            else if all.iter().any(|r| r.measurement == UsageMeasurement::Estimated) { UsageMeasurement::Estimated } else { UsageMeasurement::Actual },
        input_tokens: sum(|r| r.input_tokens), output_tokens: sum(|r| r.output_tokens),
        cached_input_tokens: sum(|r| r.cached_input_tokens), cache_write_tokens: sum(|r| r.cache_write_tokens), reasoning_tokens: sum(|r| r.reasoning_tokens),
        raw: Some(serde_json::json!({"attempts": all})), pricing_version: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rules_defaults_budget_and_server_delay_share_one_decision() {
        let policy = RetryPolicy::new(Some(&json!({"rules":[
            {"field":"message","match":"contains","pattern":"quota","action":"stop"},
            {"field":"code","match":"regex","pattern":"^custom_[0-9]+$","action":"retry"}
        ]}))).unwrap();
        assert!(!policy.decide(&RetryFailure { status:Some(503), message:"quota exceeded".into(), ..Default::default() }, 0).retry);
        assert!(policy.decide(&RetryFailure { code:"custom_42".into(), ..Default::default() }, 0).retry);
        let failure = RetryFailure { status:Some(429), retry_after_ms:Some(90000), ..Default::default() };
        assert_eq!(policy.decide(&failure, 0).delay_ms, 90000);
        assert_eq!(policy.decide(&failure, 2).reason, "exhausted");
        assert!(!policy.decide(&RetryFailure { status:Some(400), ..Default::default() }, 0).retry);
        assert!(RetryPolicy::new(Some(&json!({"rules":[{"field":"message","match":"regex","pattern":"(?=a)","action":"retry"}]}))).is_err());
    }
    #[test]
    fn cancellation_wakes_wait() {
        let cancel = CancellationToken::default();
        cancel.cancel();
        assert!(!wait(&cancel, 90000));
    }
}
