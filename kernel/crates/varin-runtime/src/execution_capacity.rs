//! Transient execution load, separate from durable task state and provider quotas.
use serde::Serialize;
use std::num::NonZeroUsize;

#[derive(Debug, Clone)]
pub struct AdmissionIdentity {
    pub run_id: String,
    pub owner_generation: u64,
    pub origin: crate::execution::ToolOrigin,
    pub family_id: String,
}

/// Keeps an existing capability-owner cancellation registration alive across queue waits.
pub struct AdmissionControlGuard(Option<Box<dyn FnOnce() + Send>>);
impl AdmissionControlGuard {
    pub fn new(release: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(release)))
    }
}
impl Drop for AdmissionControlGuard {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            release();
        }
    }
}

/// Assigned by the bound trusted executor, never from model arguments or MCP annotations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionClass {
    Unmetered,
    LocalCompute,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionSummary {
    pub local_compute_capacity: usize,
    pub local_compute_active: usize,
    pub queued: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionStatus {
    pub admission_id: String,
    pub family_id: String,
    pub class: ExecutionClass,
    pub run_id: Option<String>,
    pub owner_generation: Option<u64>,
    pub origin: Option<crate::execution::ToolOrigin>,
    pub state: &'static str,
    pub reason: Option<&'static str>,
}

/// Hardware-derived default, with an explicit deployment setting for measured resource budgets.
/// Invalid settings are errors, not silent fallback. No tool-count or task-count rejection exists.
pub fn configured_compute_capacity() -> Result<NonZeroUsize, String> {
    static CAPACITY: std::sync::OnceLock<Result<NonZeroUsize, String>> = std::sync::OnceLock::new();
    CAPACITY.get_or_init(read_compute_capacity).clone()
}
fn read_compute_capacity() -> Result<NonZeroUsize, String> {
    match std::env::var("VARIN_COMPUTE_CONCURRENCY") {
        Ok(value) => value
            .parse::<NonZeroUsize>()
            .map_err(|_| "VARIN_COMPUTE_CONCURRENCY must be a positive integer".to_string()),
        // Retain the existing two-foreground-worker deployment budget, reduced on single-core
        // hosts. This is configurable execution capacity, not a limit on accepted tasks.
        Err(std::env::VarError::NotPresent) => Ok(default_compute_capacity()),
        Err(_) => Err("VARIN_COMPUTE_CONCURRENCY is not valid text".into()),
    }
}

pub fn default_compute_capacity() -> NonZeroUsize {
    let hardware = std::thread::available_parallelism().unwrap_or(NonZeroUsize::MIN);
    hardware.min(NonZeroUsize::new(2).expect("existing foreground pool budget"))
}
