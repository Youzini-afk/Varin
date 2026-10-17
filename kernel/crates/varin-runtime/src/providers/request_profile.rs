//! Channel-owned request metadata. Native protocols and ordinary connections have no vendor headers.
use super::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestProfile {
    Opencode,
}

pub(super) fn apply(
    profile: RequestProfile,
    view: &RequestView,
    headers: &mut reqwest::header::HeaderMap,
) {
    match profile {
        RequestProfile::Opencode => {
            let scope = view.binding.request_context.as_ref();
            let session = scope
                .map(|context| context.session_id.as_str())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    if view.binding.history_range.branch_id.is_empty() {
                        &view.run_id
                    } else {
                        &view.binding.history_range.branch_id
                    }
                });
            let purpose = match &view.origin {
                RequestOrigin::AuxiliaryInference { purpose, .. }
                | RequestOrigin::PolicyModelJob { purpose, .. } => purpose.as_str(),
                RequestOrigin::McpSampling { .. } => "mcp-sampling",
                RequestOrigin::Conversation {
                    compaction: Some(_),
                    ..
                } => "compaction",
                RequestOrigin::Conversation { .. } => "conversation",
            };
            headers.insert(
                "x-opencode-client",
                reqwest::header::HeaderValue::from_static("varin"),
            );
            headers.insert(
                "user-agent",
                reqwest::header::HeaderValue::from_static(concat!(
                    "Varin/",
                    env!("CARGO_PKG_VERSION")
                )),
            );
            headers.insert(
                "x-opencode-session",
                identifier("session", &[session, purpose]),
            );
            headers.insert(
                "x-opencode-request",
                identifier("request", &[&view.request_id]),
            );
            if let Some(workspace) = scope.and_then(|context| context.workspace_id.as_deref()) {
                headers.insert("x-opencode-project", identifier("project", &[workspace]));
            }
        }
    }
}
fn identifier(kind: &str, values: &[&str]) -> reqwest::header::HeaderValue {
    let mut hash = Sha256::new();
    for value in values {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    }
    format!("varin-{kind}-{}", hex::encode(hash.finalize()))
        .parse()
        .expect("ASCII identity")
}
