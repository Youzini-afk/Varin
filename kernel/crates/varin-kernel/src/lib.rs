//! Varin's private system kernel library. The binary target only starts this runtime.
mod authority;
mod compute;
mod credential_bridge;
mod native_policy;
mod error;
mod model;
mod native_runtime;
mod native_tools;
mod native_questions;
mod native_collaboration;
mod native_mcp;
mod native_language;
mod native_memory;
mod native_memory_bridge;
mod native_retrieval;
mod process;
mod protocol;
mod protocol_generated;
mod runtime;
mod storage;
mod storage_schema;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--process-worker") {
        return process::worker::run();
    }
    runtime::run()
}

mod native_reconcile;
