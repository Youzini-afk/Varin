//! Codex SSE body/routing contract. Login, OAuth refresh and verified account selection belong
//! to the injected credential broker; JWT payload decoding is not used as authentication.
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};
pub const FAMILY: &str = "openai-codex-responses";
pub struct CodexProvider {
    inner: responses::ResponsesProvider,
    pub reasoning: Option<Value>,
    pub text_verbosity: String,
    pub service_tier: Option<String>,
}
struct AccountCredentials(Arc<dyn CredentialResolver>);
impl CredentialResolver for AccountCredentials {
    fn headers(
        &self,
        reference: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        let headers = self.0.headers(reference, cancel)?;
        let bearer = headers
            .get(reqwest::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        if !bearer.is_some_and(|v| {
            v.strip_prefix("Bearer ")
                .is_some_and(|token| !token.is_empty())
        }) || !headers
            .get("chatgpt-account-id")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| !v.is_empty())
        {
            return Err(failure(
                "codex_credential_binding_required",
                "Codex requires an explicitly bound bearer token and account identity",
            ));
        }
        Ok(headers)
    }
}
impl CodexProvider {
    /// Endpoint is the complete authorized `/codex/responses` URL, not an inferred base URL.
    pub fn new(mut connection: Connection) -> Self {
        connection.credentials = Arc::new(AccountCredentials(connection.credentials));
        Self {
            inner: responses::ResponsesProvider::for_family(connection, FAMILY),
            reasoning: None,
            text_verbosity: "low".into(),
            service_tier: None,
        }
    }
}
impl ModelProvider for CodexProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        validate_view(view, FAMILY)?;
        let mut compiled = view.clone();
        let mut instructions = Vec::new();
        compiled
            .history
            .retain(|item| !matches!(item.provenance, Provenance::SystemInstruction { .. }));
        for item in &view.history {
            if matches!(item.provenance, Provenance::SystemInstruction { .. }) {
                if let Content::Text { text } = &item.content {
                    instructions.push(text.clone());
                } else {
                    return Err(ExecutionError::new(
                        "unsupported_system_content",
                        "Codex instructions require text content",
                    ));
                }
            }
        }
        let mut body = self.inner.serialize(&compiled)?;
        body["instructions"] = json!(if instructions.is_empty() {
            "You are a helpful assistant.".into()
        } else {
            instructions.join("\n\n")
        });
        body["text"] = json!({"verbosity":self.text_verbosity});
        body["tool_choice"] = json!("auto");
        body["parallel_tool_calls"] = json!(true);
        // A branch is the stable cache/session boundary. The run ID handles branchless callers.
        let session = if view.binding.history_range.branch_id.is_empty() {
            &view.run_id
        } else {
            &view.binding.history_range.branch_id
        };
        // Protocol cache keys are at most 64 characters; hashing avoids prefix collisions and
        // keeps arbitrary branch identifiers out of HTTP headers.
        body["prompt_cache_key"] = json!(hex::encode(Sha256::digest(session.as_bytes())));
        if let Some(reasoning) = &self.reasoning {
            body["reasoning"] = reasoning.clone();
        }
        if let Some(tier) = &self.service_tier {
            body["service_tier"] = json!(tier);
        }
        // Codex's locked SDK does not send max_output_tokens to this backend. The orchestration
        // policy owns a run budget; do not pretend a rejected wire field enforces that budget.
        body.as_object_mut()
            .expect("compiled body")
            .remove("max_output_tokens");
        Ok(body)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let session = request.serialized["prompt_cache_key"]
            .as_str()
            .ok_or_else(|| {
                failure(
                    "invalid_codex_snapshot",
                    "Codex snapshot lacks its session cache identity",
                )
            })?;
        let user_agent = concat!("Varin/", env!("CARGO_PKG_VERSION"));
        self.inner.generate_headers(
            request,
            cancel,
            emit,
            &[
                ("OpenAI-Beta", "responses=experimental"),
                ("originator", "varin"),
                ("user-agent", user_agent),
                ("session-id", session),
                ("x-client-request-id", &request.view.request_id),
            ],
        )
    }
}
