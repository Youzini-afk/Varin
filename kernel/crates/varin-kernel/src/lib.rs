//! Varin's private system kernel library. The binary target only starts this runtime.
mod agent_goals;
mod agent_resources;
mod agent_runtime;
mod authority;
mod collaboration;
mod family_tools;
mod child_capabilities;
mod compute;
mod context;
mod credential_bridge;
mod error;
mod host_query;
mod host_tools;
mod language;
mod memory;
mod model;
mod plan;
mod plan_bridge;
mod policy;
mod process;
mod process_wait;
mod protocol;
mod protocol_generated;
mod questions;
mod retrieval;
mod run_assembly;
mod run_models;
mod run_tools;
mod runtime;
mod storage;
mod storage_schema;
mod tools;
mod transport;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--process-worker") {
        return process::worker::run();
    }
    runtime::run()
}

mod integration_reconciliation;
mod reconcile;

#[cfg(test)]
mod host_tool_review;

#[cfg(test)]
mod policy_activation_planning_review;

#[cfg(test)]
mod agent_resources_review;

#[cfg(test)]
mod process_interaction_review;
