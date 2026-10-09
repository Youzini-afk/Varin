//! Agent authority. Network, tool and extension work executes outside catalog transactions.
//! This crate is not yet the production runtime; the cutover must replace, not duplicate, Pi ownership.
pub mod catalog;
pub mod composition;
pub mod types;
mod types_generated;
pub use catalog::{Catalog, RuntimeError};
pub use types::*;

pub mod execution;

pub mod providers;

pub mod supervisor;

pub mod model_session;

pub mod content;

pub mod context_job;
pub mod context_capacity;
mod context_material;

pub mod resource_admission;

pub mod execution_capacity;
