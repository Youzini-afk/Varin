//! Explicit model bindings. Tool-enabled sessions replace the empty tool binding with an
//! assembled, authorized executor; model configuration never invents tool permissions.
use crate::execution::*;
use crate::providers::{Connection,CredentialResolver,EnvironmentCredentialResolver,EnvironmentHeader,ReqwestTransport};
use crate::providers::{anthropic,azure,bedrock,chat,codex,google,mistral,responses,auth::CredentialScope};
use crate::supervisor::RunStart;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::sync::Arc;
pub use crate::types::ModelSessionConfiguration;

/// Environment-only bootstrap. Production credential/account selection uses bind_with_credentials.
pub fn bind(configuration:ModelSessionConfiguration)->Result<RunStart,ExecutionError>{
    let identity=connection_identity(&configuration)?;
    let (header,prefix)=match configuration.provider_family.as_str(){
        responses::FAMILY|chat::FAMILY|mistral::FAMILY=>("authorization","Bearer "),
        azure::FAMILY=>("api-key",""),anthropic::FAMILY=>("x-api-key",""),
        google::FAMILY=>("x-goog-api-key",""),
        google::VERTEX_FAMILY|codex::FAMILY|bedrock::FAMILY=>return Err(ExecutionError::new("credential_binding_required","this provider requires an explicitly bound credential owner")),
        _=>return Err(ExecutionError::new("unsupported_provider","the selected provider adapter is unavailable")),
    };
    let mut credentials=EnvironmentCredentialResolver{allow_anonymous:configuration.allow_anonymous,..Default::default()};
    let reference=if let Some(variable)=&configuration.credential_environment{
        if variable.is_empty(){return Err(ExecutionError::new("invalid_credential_reference","credential environment name is empty"));}
        let key=format!("environment:{variable}");credentials.bindings.insert(key.clone(),vec![EnvironmentHeader{variable:variable.clone(),header:header.into(),prefix:prefix.into()}]);Some(key)
    }else{None};
    build(configuration,Arc::new(credentials),reference,identity)
}
/// The credential authority supplies and pins a verified account scope. Same-account token
/// refresh does not change this identity; relinking the reference to another account does.
pub fn bind_with_credentials(configuration:ModelSessionConfiguration,credentials:Arc<dyn CredentialResolver>,scope:CredentialScope)->Result<RunStart,ExecutionError>{
    let identity=connection_identity_with_scope(&configuration,&scope)?;
    build(configuration,credentials,Some(scope.reference),identity)
}
/// Pure, nonsecret identity construction shared by admission and executable binding.
pub fn connection_identity_with_scope(configuration:&ModelSessionConfiguration,scope:&CredentialScope)->Result<String,ExecutionError>{
    scope.validate().map_err(|error|ExecutionError::new("credential_scope",error.to_string()))?;
    hash_identity(configuration,json!({"authority":scope.authority,"account":scope.account,"reference":scope.reference,"generation":scope.generation}))
}
pub struct BoundModel { pub binding: RequestBinding, pub provider: Arc<dyn ModelProvider> }
pub fn bind_provider_with_credentials(configuration:ModelSessionConfiguration,credentials:Arc<dyn CredentialResolver>,scope:CredentialScope)->Result<BoundModel,ExecutionError>{
    let identity=connection_identity_with_scope(&configuration,&scope)?;
    build_provider(configuration,credentials,Some(scope.reference),identity)
}
fn build(configuration:ModelSessionConfiguration,credentials:Arc<dyn CredentialResolver>,credential_ref:Option<String>,identity:String)->Result<RunStart,ExecutionError>{
    let BoundModel{binding,provider}=build_provider(configuration,credentials,credential_ref,identity)?;
    Ok(RunStart{context_preparation:Arc::new(NoopContextPreparation),binding,policy_state:Value::Null,provider,tools:Arc::new(NoTools),policy:Arc::new(DefaultAgentPolicy),progress:ProgressSink::default()})
}
pub fn build_provider(configuration:ModelSessionConfiguration,credentials:Arc<dyn CredentialResolver>,credential_ref:Option<String>,identity:String)->Result<BoundModel,ExecutionError>{
    if configuration.model.trim().is_empty()||configuration.max_output_tokens==Some(0){return Err(ExecutionError::new("invalid_model_configuration","model and positive output capacity are required"));}
    let mut connection=Connection::new(configuration.endpoint.clone(),credentials,Arc::new(ReqwestTransport::default()));
    connection.accepts_images=configuration.accepts_images;
    let provider:Arc<dyn ModelProvider>=match configuration.provider_family.as_str(){
        responses::FAMILY=>{let mut provider=responses::ResponsesProvider::new(connection);provider.max_output_tokens=configuration.max_output_tokens;provider.reasoning=configuration.reasoning_effort.map(|effort|json!({"effort":effort}));Arc::new(provider)},
        anthropic::FAMILY=>{let mut provider=anthropic::AnthropicProvider::new(connection,configuration.max_output_tokens.ok_or_else(||ExecutionError::new("output_capacity_required","Anthropic requires an explicit positive output capacity"))?);provider.oauth=configuration.anthropic_oauth.unwrap_or(false);Arc::new(provider)},
        chat::FAMILY=>{let mut provider=chat::ChatProvider::new(connection);provider.max_output_tokens=configuration.max_output_tokens;provider.legacy_max_tokens=configuration.legacy_max_tokens.unwrap_or(false);provider.include_stream_usage=configuration.include_stream_usage.unwrap_or(true);provider.reasoning_effort=configuration.reasoning_effort;Arc::new(provider)},
        azure::FAMILY=>{
            let deployment=configuration.azure_deployment.clone().filter(|s|!s.trim().is_empty()).ok_or_else(||ExecutionError::new("azure_configuration","Azure requires an explicit deployment"))?;
            let version=configuration.azure_api_version.clone().filter(|s|!s.trim().is_empty()).ok_or_else(||ExecutionError::new("azure_configuration","Azure requires an explicit API version"))?;
            let mut provider=azure::AzureResponsesProvider::new(connection,deployment,&version)?;if let Some(max)=configuration.max_output_tokens{provider.set_max_output_tokens(max);}provider.set_reasoning(configuration.reasoning_effort.map(|effort|json!({"effort":effort})));Arc::new(provider)
        },
        google::FAMILY=>{let mut provider=google::GoogleProvider::new(connection)?;provider.max_output_tokens=configuration.max_output_tokens;Arc::new(provider)},
        google::VERTEX_FAMILY=>{let mut provider=google::GoogleProvider::vertex(connection)?;provider.max_output_tokens=configuration.max_output_tokens;Arc::new(provider)},
        mistral::FAMILY=>{let mut provider=mistral::MistralProvider::new(connection);if let Some(max)=configuration.max_output_tokens{provider.set_max_output_tokens(max);}provider.set_reasoning_effort(configuration.reasoning_effort);Arc::new(provider)},
        bedrock::FAMILY=>{
            if configuration.reasoning_effort.is_some(){return Err(ExecutionError::new("unsupported_reasoning_configuration","Bedrock model-specific reasoning configuration is not yet bound"));}
            let mut provider=bedrock::BedrockProvider::new(connection);provider.max_output_tokens=configuration.max_output_tokens;Arc::new(provider)
        },
        codex::FAMILY=>{
            if configuration.max_output_tokens.is_some(){return Err(ExecutionError::new("unsupported_output_capacity","Codex SSE does not support a max_output_tokens request field"));}
            let mut provider=codex::CodexProvider::new(connection);
            provider.reasoning=configuration.reasoning_effort.map(|effort|json!({"effort":effort,"summary":"auto"}));
            Arc::new(provider)
        },
        _=>return Err(ExecutionError::new("unsupported_provider","the selected provider adapter is unavailable")),
    };
    let binding=RequestBinding{connection_identity:identity,provider_family:configuration.provider_family,model:configuration.model,credential_ref,configuration_generation:configuration.configuration_generation,tool_schema_generation:0,tools:vec![],instruction_sources:vec![],memory_checkpoint:None,attachment_refs:vec![],environment_cursor:0,history_range:HistoryRange{branch_id:String::new(),ancestor_id:None,leaf_id:None}};
    Ok(BoundModel{binding,provider})
}
struct NoTools;
impl ToolExecutor for NoTools {
    fn plan(&self, call: &crate::execution::ToolCall, context: &crate::execution::FrozenToolContext,
        cancel: &crate::execution::CancellationToken) -> Result<crate::execution::ToolPreparation, crate::execution::ExecutionError> {
        self.prepare(call, context, cancel).map(crate::execution::ToolPreparation::Ready)
    }

    fn prepare(&self,_:&ToolCall,_:&FrozenToolContext, _cancel: &CancellationToken)->Result<ToolContract,ExecutionError>{Err(ExecutionError::new("tool_unavailable","this binding has no tools"))}
    fn authorize(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->Result<(),ExecutionError>{Err(ExecutionError::new("tool_unavailable","this binding has no tools"))}
    fn execute(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->ToolCompletion{ToolCompletion::NotDispatched{reason:"no tool binding exists".into()}}
}
/// Bootstrap reference generations are assigned by trusted Host configuration. No credential
/// values or per-request generation IDs enter the continuation identity.
pub fn connection_identity(configuration:&ModelSessionConfiguration)->Result<String,ExecutionError>{
    hash_identity(configuration,json!({"environment_reference":configuration.credential_environment,"reference_generation":configuration.configuration_generation}))
}
fn hash_identity(configuration:&ModelSessionConfiguration,credential_scope:Value)->Result<String,ExecutionError>{
    let url=reqwest::Url::parse(&configuration.endpoint).map_err(|_|ExecutionError::new("invalid_endpoint","model endpoint must be an absolute HTTP(S) URL"))?;
    if !matches!(url.scheme(),"http"|"https")||!url.username().is_empty()||url.password().is_some()||url.fragment().is_some(){return Err(ExecutionError::new("invalid_endpoint","model endpoint cannot embed credentials or fragments"));}
    for (key,_) in url.query_pairs(){let key=key.to_ascii_lowercase();if key.contains("token")||key.contains("secret")||key.contains("credential")||key.contains("signature")||matches!(key.as_str(),"key"|"api_key"|"api-key"|"apikey"|"authorization"|"sig"|"password"){return Err(ExecutionError::new("credential_in_endpoint","model credentials must use the credential resolver, not endpoint query parameters"));}}
    let identity=json!({"provider":configuration.provider_id,"family":configuration.provider_family,"endpoint":url.as_str(),"model":configuration.model,"credential_scope":credential_scope,"azure_deployment":configuration.azure_deployment,"azure_api_version":configuration.azure_api_version});
    let bytes=serde_json::to_vec(&identity).map_err(|_|ExecutionError::new("connection_identity","could not encode trusted connection configuration"))?;
    Ok(format!("connection-sha256-{}",hex::encode(Sha256::digest(bytes))))
}
