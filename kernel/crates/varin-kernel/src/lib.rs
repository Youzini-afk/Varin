//! Varin's private system kernel library. The binary target only starts this runtime.
mod authority;
mod compute;
mod credential_bridge;
mod policy;
mod error;
mod model;
mod agent_runtime;
mod tools;
mod questions;
mod collaboration;
mod process_wait;
mod mcp;
mod language;
mod memory;
mod memory_bridge;
mod plan;
mod plan_bridge;
mod retrieval;
mod process;
mod protocol;
mod protocol_generated;
mod runtime;
mod transport;
mod storage;
mod storage_schema;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--process-worker") {
        return process::worker::run();
    }
    runtime::run()
}

mod reconcile;
