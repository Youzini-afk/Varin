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
            v.split_once(' ').is_some_and(|(scheme, token)| {
                let token = token.trim_start_matches(' ');
                scheme.eq_ignore_ascii_case("Bearer")
                    && !token.is_empty()
                    && !token.chars().any(char::is_whitespace)
            })
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
    fn request_budget_protocol(&self) -> Option<crate::context_capacity::RequestBudgetProtocol> {
        self.inner.request_budget_protocol()
    }

    fn serialize(
        &self,
        view: &RequestView,
        mut reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        validate_view(view, FAMILY)?;
        let input = model_input(view, &self.inner.connection, reuse.as_deref_mut());
        let view = input.as_ref();
        let mut instructions = Vec::new();
        let mut sources = Vec::new();
        for item in &view.history {
            if item.provenance.is_system() {
                if let Content::Text { text } = &item.content {
                    instructions.push(text.as_str());
                    sources.push(item.clone());
                } else {
                    return Err(ExecutionError::new(
                        "unsupported_system_content",
                        "Codex instructions require text content",
                    ));
                }
            }
        }
        let instructions = match reuse
            .as_ref()
            .and_then(|reuse| reuse.codex_instructions.as_ref())
        {
            Some((previous, frozen))
                if previous.len() == sources.len()
                    && previous
                        .iter()
                        .zip(&sources)
                        .all(|(a, b)| Arc::ptr_eq(a, b)) =>
            {
                frozen.clone()
            }
            _ => {
                let frozen =
                    crate::request_body::FrozenJson::new(json!(if instructions.is_empty() {
                        "You are a helpful assistant.".into()
                    } else {
                        instructions.join("\n\n")
                    }));
                if let Some(reuse) = reuse.as_mut() {
                    reuse.codex_instructions = Some((sources, frozen.clone()));
                }
                frozen
            }
        };
        let mut body = self.inner.serialize_history(
            view,
            project_history(&view.history, FAMILY, &view.binding.connection_identity)
                .filter(|projected| !projected.item.provenance.is_system()),
            reuse,
        )?;
        body.insert_frozen("instructions", instructions);
        body.insert("text", json!({"verbosity":self.text_verbosity}));
        body.insert("tool_choice", json!("auto"));
        body.insert("parallel_tool_calls", json!(true));
        // A branch is the stable cache/session boundary. The run ID handles branchless callers.
        let session =
            if let crate::execution::RequestOrigin::McpSampling { operation_id, .. }
            | crate::execution::RequestOrigin::AuxiliaryInference { operation_id, .. } =
                &view.origin
            {
                operation_id
            } else if let crate::execution::RequestOrigin::PolicyModelJob { action_id, .. } =
                &view.origin
            {
                action_id
            } else if view.binding.history_range.branch_id.is_empty() {
                &view.run_id
            } else {
                &view.binding.history_range.branch_id
            };
        // Protocol cache keys are at most 64 characters; hashing avoids prefix collisions and
        // keeps arbitrary branch identifiers out of HTTP headers.
        body.insert(
            "prompt_cache_key",
            json!(hex::encode(Sha256::digest(session.as_bytes()))),
        );
        if let Some(reasoning) = &self.reasoning {
            body.insert("reasoning", reasoning.clone());
        }
        if let Some(tier) = &self.service_tier {
            body.insert("service_tier", json!(tier));
        }
        // Codex's locked SDK does not send max_output_tokens to this backend. The orchestration
        // policy owns a run budget; do not pretend a rejected wire field enforces that budget.
        body.remove("max_output_tokens");
        Ok(body)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let session = request
            .serialized
            .get("prompt_cache_key")
            .and_then(|value| value.as_str().map(str::to_owned))
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
                ("session-id", &session),
                ("x-client-request-id", &request.view.request_id),
            ],
        )
    }
}
