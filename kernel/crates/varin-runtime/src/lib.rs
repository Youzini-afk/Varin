//! Agent authority. Network, tool and extension work executes outside catalog transactions.
//! This crate is not yet the production runtime; the cutover must replace, not duplicate, Pi ownership.
pub mod catalog;
pub mod composition;
pub mod types;
mod types_generated;
pub use catalog::{Catalog, RuntimeError};
pub use types::*;

pub mod execution;
pub mod request_body;
pub mod nested_tools;
pub mod tool_disclosure;

pub mod providers;

pub mod supervisor;

pub mod model_session;
pub mod model_retry;

pub mod content;
pub mod output;

pub mod context_capacity;
pub mod context_composition;
pub mod context_job;
pub mod summary_tools;
mod context_execution;
mod context_material;
pub mod context_retention;
pub mod token_count;

#[cfg(test)]
extern crate self as varin_runtime;
#[cfg(test)]
#[path = "../tests/fixtures/input_admission.rs"]
mod test_submission;

pub mod resource_admission;

pub mod execution_capacity;

pub mod mcp_sampling;
pub mod questions;
