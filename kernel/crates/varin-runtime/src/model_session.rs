//! Explicit model bindings. Tool-enabled sessions replace the empty tool binding with an
//! assembled, authorized executor; model configuration never invents tool permissions.
use crate::execution::*;
use crate::providers::auth::CredentialScope;
use crate::providers::{
    registry, shared_transport, Connection, CredentialResolver, EnvironmentCredentialResolver,
    EnvironmentHeader,
};
use crate::supervisor::RunStart;
pub use crate::types::ModelSessionConfiguration;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Environment-only bootstrap. Production credential/account selection uses bind_with_credentials.
pub fn bind(configuration: ModelSessionConfiguration) -> Result<RunStart, ExecutionError> {
    let identity = connection_identity(&configuration)?;
    let (header, prefix) = registry::model_adapters()
        .read()
        .map_err(|_| {
            ExecutionError::new(
                "model_adapter_registry",
                "model adapter registry unavailable",
            )
        })?
        .environment_auth(
            configuration
                .adapter_id
                .as_deref()
                .unwrap_or(&configuration.provider_family),
        )?
        .ok_or_else(|| {
            ExecutionError::new(
                "credential_binding_required",
                "this adapter requires an explicitly bound credential owner",
            )
        })?;
    let mut credentials = EnvironmentCredentialResolver {
        allow_anonymous: configuration.allow_anonymous,
        ..Default::default()
    };
    let reference = if let Some(variable) = &configuration.credential_environment {
        if variable.is_empty() {
            return Err(ExecutionError::new(
                "invalid_credential_reference",
                "credential environment name is empty",
            ));
        }
        let key = format!("environment:{variable}");
        credentials.bindings.insert(
            key.clone(),
            vec![EnvironmentHeader {
                variable: variable.clone(),
                header: header.clone(),
                prefix: prefix.clone(),
            }],
        );
        Some(key)
    } else {
        None
    };
    build(configuration, Arc::new(credentials), reference, identity)
}
/// The credential authority supplies and pins a verified account scope. Same-account token
/// refresh does not change this identity; relinking the reference to another account does.
pub fn bind_with_credentials(
    configuration: ModelSessionConfiguration,
    credentials: Arc<dyn CredentialResolver>,
    scope: CredentialScope,
) -> Result<RunStart, ExecutionError> {
    let identity = connection_identity_with_scope(&configuration, &scope)?;
    build(configuration, credentials, Some(scope.reference), identity)
}
/// Pure, nonsecret identity construction shared by admission and executable binding.
pub fn connection_identity_with_scope(
    configuration: &ModelSessionConfiguration,
    scope: &CredentialScope,
) -> Result<String, ExecutionError> {
    scope
        .validate()
        .map_err(|error| ExecutionError::new("credential_scope", error.to_string()))?;
    hash_identity(
        configuration,
        json!({"authority":scope.authority,"account":scope.account,"reference":scope.reference,"generation":scope.generation}),
    )
}
pub struct BoundModel {
    pub binding: RequestBinding,
    pub provider: Arc<dyn ModelProvider>,
}
pub fn bind_provider_with_credentials(
    configuration: ModelSessionConfiguration,
    credentials: Arc<dyn CredentialResolver>,
    scope: CredentialScope,
) -> Result<BoundModel, ExecutionError> {
    let identity = connection_identity_with_scope(&configuration, &scope)?;
    build_provider(configuration, credentials, Some(scope.reference), identity)
}
fn build(
    configuration: ModelSessionConfiguration,
    credentials: Arc<dyn CredentialResolver>,
    credential_ref: Option<String>,
    identity: String,
) -> Result<RunStart, ExecutionError> {
    let BoundModel { binding, provider } =
        build_provider(configuration, credentials, credential_ref, identity)?;
    Ok(RunStart {
        context_preparation: Arc::new(NoopContextPreparation),
        binding,
        policy_state: Value::Null,
        provider,
        tools: Arc::new(NoTools),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    })
}
pub fn build_provider(
    configuration: ModelSessionConfiguration,
    credentials: Arc<dyn CredentialResolver>,
    credential_ref: Option<String>,
    identity: String,
) -> Result<BoundModel, ExecutionError> {
    if configuration.model.trim().is_empty() || configuration.max_output_tokens == Some(0) {
        return Err(ExecutionError::new(
            "invalid_model_configuration",
            "model and positive output capacity are required",
        ));
    }
    if configuration.context_window_tokens == Some(0) {
        return Err(ExecutionError::new(
            "invalid_context_capacity",
            "context capacity must be positive",
        ));
    }
    let selected = registry::model_adapters()
        .read()
        .map_err(|_| {
            ExecutionError::new(
                "model_adapter_registry",
                "model adapter registry unavailable",
            )
        })?
        .select(&configuration)?;
    let mut connection = Connection::new(
        configuration.endpoint.clone(),
        credentials,
        shared_transport(),
    );
    connection.accepts_images = configuration.accepts_images;
    let provider = selected.bind(&configuration, connection)?;
    let binding = RequestBinding {
        connection_identity: identity,
        provider_family: configuration.provider_family,
        model: configuration.model,
        credential_ref,
        configuration_generation: configuration.configuration_generation,
        tool_schema_generation: 0,
        tools: vec![],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: String::new(),
            ancestor_id: None,
            leaf_id: None,
        },
    };
    Ok(BoundModel { binding, provider })
}
struct NoTools;
impl ToolExecutor for NoTools {
    fn plan(
        &self,
        call: &crate::execution::ToolCall,
        context: &crate::execution::FrozenToolContext,
        cancel: &crate::execution::CancellationToken,
    ) -> Result<crate::execution::ToolPreparation, crate::execution::ExecutionError> {
        self.prepare(call, context, cancel)
            .map(crate::execution::ToolPreparation::Ready)
    }

    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Err(ExecutionError::new(
            "tool_unavailable",
            "this binding has no tools",
        ))
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(ExecutionError::new(
            "tool_unavailable",
            "this binding has no tools",
        ))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "no tool binding exists".into(),
        }
    }
}
/// Bootstrap reference generations are assigned by trusted Host configuration. No credential
/// values or per-request generation IDs enter the continuation identity.
pub fn connection_identity(
    configuration: &ModelSessionConfiguration,
) -> Result<String, ExecutionError> {
    hash_identity(
        configuration,
        json!({"environment_reference":configuration.credential_environment,"reference_generation":configuration.configuration_generation}),
    )
}
fn hash_identity(
    configuration: &ModelSessionConfiguration,
    credential_scope: Value,
) -> Result<String, ExecutionError> {
    let url = reqwest::Url::parse(&configuration.endpoint).map_err(|_| {
        ExecutionError::new(
            "invalid_endpoint",
            "model endpoint must be an absolute HTTP(S) URL",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ExecutionError::new(
            "invalid_endpoint",
            "model endpoint cannot embed credentials or fragments",
        ));
    }
    for (key, _) in url.query_pairs() {
        let key = key.to_ascii_lowercase();
        if key.contains("token")
            || key.contains("secret")
            || key.contains("credential")
            || key.contains("signature")
            || matches!(
                key.as_str(),
                "key" | "api_key" | "api-key" | "apikey" | "authorization" | "sig" | "password"
            )
        {
            return Err(ExecutionError::new(
                "credential_in_endpoint",
                "model credentials must use the credential resolver, not endpoint query parameters",
            ));
        }
    }
    let adapter = registry::selected_metadata(configuration)?;
    if adapter.protocol_family != configuration.provider_family
        || configuration
            .adapter_version
            .as_ref()
            .is_some_and(|v| v != &adapter.version)
    {
        return Err(ExecutionError::new(
            "model_adapter_selection_changed",
            "selected model adapter identity/version changed",
        ));
    }
    let identity = json!({"adapter":adapter,"provider":configuration.provider_id,"family":configuration.provider_family,"endpoint":url.as_str(),"model":configuration.model,"credential_scope":credential_scope,"azure_deployment":configuration.azure_deployment,"azure_api_version":configuration.azure_api_version});
    let bytes = serde_json::to_vec(&identity).map_err(|_| {
        ExecutionError::new(
            "connection_identity",
            "could not encode trusted connection configuration",
        )
    })?;
    Ok(format!(
        "connection-sha256-{}",
        hex::encode(Sha256::digest(bytes))
    ))
}
