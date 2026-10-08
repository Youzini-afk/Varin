//! A model-only native execution binding. Tool-enabled sessions use an explicitly assembled
//! ToolExecutor and frozen tool catalog; this binding never invents tool permissions.
use crate::execution::*;
use crate::providers::{Connection, EnvironmentCredentialResolver, EnvironmentHeader, NativeHttpTransport};
use crate::providers::{responses, anthropic};
use crate::supervisor::RunStart;
use serde_json::Value;
use std::sync::Arc;

pub use crate::types::ModelSessionConfiguration;
pub fn bind(configuration:ModelSessionConfiguration)->Result<RunStart,ExecutionError>{
    if configuration.model.trim().is_empty()||configuration.endpoint.trim().is_empty()||configuration.max_output_tokens==0 {
        return Err(ExecutionError::new("invalid_model_configuration","model, endpoint and positive output capacity are required"));
    }
    let (header,prefix)=match configuration.provider_family.as_str(){
        responses::FAMILY=>("authorization","Bearer "),
        anthropic::FAMILY=>("x-api-key",""),
        _=>return Err(ExecutionError::new("unsupported_provider","the selected native provider adapter is unavailable")),
    };
    let mut credentials=EnvironmentCredentialResolver{allow_anonymous:configuration.allow_anonymous,..Default::default()};
    let credential_ref=if let Some(variable)=configuration.credential_environment {
        if variable.is_empty(){return Err(ExecutionError::new("invalid_credential_reference","credential environment name is empty"));}
        let key=format!("environment:{variable}");
        credentials.bindings.insert(key.clone(),vec![EnvironmentHeader{variable,header:header.into(),prefix:prefix.into()}]);Some(key)
    }else{None};
    let connection=Connection::new(configuration.endpoint,Arc::new(credentials),Arc::new(NativeHttpTransport::default()));
    let provider:Arc<dyn ModelProvider>=match configuration.provider_family.as_str(){
        responses::FAMILY=>{let mut provider=responses::ResponsesProvider::new(connection);provider.max_output_tokens=Some(configuration.max_output_tokens);Arc::new(provider)},
        anthropic::FAMILY=>Arc::new(anthropic::AnthropicProvider::new(connection,configuration.max_output_tokens)),
        _=>unreachable!("validated provider family"),
    };
    let binding=RequestBinding{provider_family:configuration.provider_family,model:configuration.model,credential_ref,configuration_generation:configuration.configuration_generation,tool_schema_generation:0,tools:vec![],instruction_sources:vec![],memory_checkpoint:None,attachment_refs:vec![],environment_cursor:0,history_range:HistoryRange{branch_id:String::new(),ancestor_id:None,leaf_id:None}};
    Ok(RunStart{binding,policy_state:Value::Null,provider,tools:Arc::new(NoTools),policy:Arc::new(DefaultAgentPolicy),progress:ProgressSink::default()})
}
struct NoTools;
impl ToolExecutor for NoTools {
    fn prepare(&self,_:&ToolCall,_:&RequestSnapshot)->Result<ToolContract,ExecutionError>{Err(ExecutionError::new("tool_unavailable","this model-only binding has no tools"))}
    fn authorize(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->Result<(),ExecutionError>{Err(ExecutionError::new("tool_unavailable","this model-only binding has no tools"))}
    fn execute(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->ToolCompletion{ToolCompletion::NotDispatched{reason:"no tool binding exists".into()}}
}
