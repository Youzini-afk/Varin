//! Varin's private system kernel library. The binary target only starts this runtime.
mod agent_runtime;
mod authority;
mod collaboration;
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

mod reconcile;

#[cfg(test)]
mod host_tool_review;
