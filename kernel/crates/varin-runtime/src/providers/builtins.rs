//! Builtin protocol adapters use the same typed composition contract as extensions.
use super::registry::{ModelAdapter, ModelAdapterMetadata, MODEL_ADAPTER_CONTRACT};
use super::*;
use crate::types::ModelSessionConfiguration;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;

struct Builtin {
    metadata: ModelAdapterMetadata,
    auth: Option<(&'static str, &'static str)>,
}
impl ModelAdapter for Builtin {
    fn metadata(&self) -> &ModelAdapterMetadata {
        &self.metadata
    }
    fn environment_auth(&self) -> Option<(&str, &str)> {
        self.auth
    }
    fn bind(
        &self,
        config: &ModelSessionConfiguration,
        connection: Connection,
    ) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
        bind(config, connection)
    }
}
pub fn adapters() -> Vec<Arc<dyn ModelAdapter>> {
    [
        (responses::FAMILY, Some(("authorization", "Bearer "))),
        (chat::FAMILY, Some(("authorization", "Bearer "))),
        (anthropic::FAMILY, Some(("x-api-key", ""))),
        (azure::FAMILY, Some(("api-key", ""))),
        (google::FAMILY, Some(("x-goog-api-key", ""))),
        (google::VERTEX_FAMILY, None),
        (mistral::FAMILY, Some(("authorization", "Bearer "))),
        (bedrock::FAMILY, None),
        (codex::FAMILY, None),
        (pi_messages::FAMILY, Some(("authorization", "Bearer "))),
    ]
    .into_iter()
    .map(|(family, auth)| {
        Arc::new(Builtin {
            metadata: ModelAdapterMetadata {
                id: family.into(),
                version: "1".into(),
                contract_version: MODEL_ADAPTER_CONTRACT,
                protocol_family: family.into(),
            },
            auth,
        }) as Arc<dyn ModelAdapter>
    })
    .collect()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    temperature: Option<f64>,
    sampling_params: Option<BTreeMap<String, Value>>,
    #[serde(default = "empty_object")]
    protocol: Value,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseOptions {
    text_verbosity: Option<String>,
    service_tier: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnthropicOptions {
    thinking: Option<Value>,
    output_config: Option<Value>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoogleOptions {
    thinking_config: Option<Value>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BedrockOptions {
    additional_model_request_fields: Option<Value>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiOptions {
    cache_retention: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
fn empty_object() -> Value {
    json!({})
}
fn decode<T: for<'a> Deserialize<'a>>(value: Value) -> Result<T, ExecutionError> {
    serde_json::from_value(value).map_err(|_| {
        ExecutionError::new(
            "model_options",
            "options are invalid for the selected model adapter",
        )
    })
}
fn object(value: &Option<Value>) -> Result<(), ExecutionError> {
    if value.as_ref().is_some_and(|v| !v.is_object()) {
        return Err(ExecutionError::new(
            "model_options",
            "protocol configuration must be an object",
        ));
    }
    Ok(())
}
fn bind(
    c: &ModelSessionConfiguration,
    connection: Connection,
) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
    let options: Options = decode(c.model_options.clone().unwrap_or_else(empty_object))?;
    if options.temperature.is_some_and(|v| !v.is_finite()) {
        return Err(ExecutionError::new(
            "model_temperature",
            "temperature must be finite",
        ));
    }
    let mut fields = json!({});
    let inner: Arc<dyn ModelProvider> = match c.provider_family.as_str() {
        responses::FAMILY | azure::FAMILY | codex::FAMILY => {
            let o: ResponseOptions = decode(options.protocol)?;
            if let Some(v) = &o.text_verbosity {
                fields["text"] = json!({"verbosity":v});
            }
            if let Some(v) = &o.service_tier {
                fields["service_tier"] = json!(v);
            }
            let reasoning = c
                .reasoning_effort
                .as_ref()
                .map(|effort| json!({"effort":effort}));
            if c.provider_family == responses::FAMILY {
                let mut p = responses::ResponsesProvider::new(connection);
                p.max_output_tokens = c.max_output_tokens;
                p.reasoning = reasoning;
                Arc::new(p)
            } else if c.provider_family == azure::FAMILY {
                let deployment = c
                    .azure_deployment
                    .clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        ExecutionError::new(
                            "azure_configuration",
                            "Azure requires an explicit deployment",
                        )
                    })?;
                let version = c
                    .azure_api_version
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        ExecutionError::new(
                            "azure_configuration",
                            "Azure requires an explicit API version",
                        )
                    })?;
                let mut p = azure::AzureResponsesProvider::new(connection, deployment, version)?;
                if let Some(max) = c.max_output_tokens {
                    p.set_max_output_tokens(max);
                }
                p.set_reasoning(reasoning);
                Arc::new(p)
            } else {
                if c.max_output_tokens.is_some()
                    || options.temperature.is_some()
                    || options.sampling_params.is_some()
                {
                    return Err(ExecutionError::new(
                        "unsupported_codex_options",
                        "Codex does not accept output capacity or sampling parameters",
                    ));
                }
                let mut p = codex::CodexProvider::new(connection);
                p.reasoning = c
                    .reasoning_effort
                    .as_ref()
                    .map(|effort| json!({"effort":effort,"summary":"auto"}));
                if let Some(v) = o.text_verbosity {
                    p.text_verbosity = v;
                }
                p.service_tier = o.service_tier;
                Arc::new(p)
            }
        }
        chat::FAMILY => {
            let _: Empty = decode(options.protocol)?;
            let mut p = chat::ChatProvider::new(connection);
            p.max_output_tokens = c.max_output_tokens;
            p.legacy_max_tokens = c.legacy_max_tokens.unwrap_or(false);
            p.include_stream_usage = c.include_stream_usage.unwrap_or(true);
            p.reasoning_effort = c.reasoning_effort.clone();
            Arc::new(p)
        }
        anthropic::FAMILY => {
            let o: AnthropicOptions = decode(options.protocol)?;
            object(&o.thinking)?;
            object(&o.output_config)?;
            if c.reasoning_effort.is_some() && o.thinking.is_none() {
                return Err(ExecutionError::new(
                    "thinking_configuration_required",
                    "Anthropic requires resolved thinking configuration",
                ));
            }
            let mut p = anthropic::AnthropicProvider::new(
                connection,
                c.max_output_tokens.ok_or_else(|| {
                    ExecutionError::new(
                        "output_capacity_required",
                        "Anthropic requires an explicit output capacity",
                    )
                })?,
            );
            p.oauth = c.anthropic_oauth.unwrap_or(false);
            p.thinking = o.thinking;
            if let Some(v) = o.output_config {
                fields["output_config"] = v;
            }
            Arc::new(p)
        }
        google::FAMILY | google::VERTEX_FAMILY => {
            let o: GoogleOptions = decode(options.protocol)?;
            object(&o.thinking_config)?;
            if c.reasoning_effort.is_some() && o.thinking_config.is_none() {
                return Err(ExecutionError::new(
                    "thinking_configuration_required",
                    "Google requires resolved thinking configuration",
                ));
            }
            let mut p = if c.provider_family == google::FAMILY {
                google::GoogleProvider::new(connection)?
            } else {
                google::GoogleProvider::vertex(connection)?
            };
            p.max_output_tokens = c.max_output_tokens;
            p.thinking_config = o.thinking_config;
            Arc::new(p)
        }
        bedrock::FAMILY => {
            let o: BedrockOptions = decode(options.protocol)?;
            object(&o.additional_model_request_fields)?;
            if c.reasoning_effort.is_some() && o.additional_model_request_fields.is_none() {
                return Err(ExecutionError::new(
                    "thinking_configuration_required",
                    "Bedrock requires resolved model-specific thinking configuration",
                ));
            }
            if let Some(v) = o.additional_model_request_fields {
                fields["additionalModelRequestFields"] = v;
            }
            let mut p = bedrock::BedrockProvider::new(connection);
            p.max_output_tokens = c.max_output_tokens;
            Arc::new(p)
        }
        mistral::FAMILY => {
            let _: Empty = decode(options.protocol)?;
            let mut p = mistral::MistralProvider::new(connection);
            if let Some(max) = c.max_output_tokens {
                p.set_max_output_tokens(max);
            }
            p.set_reasoning_effort(c.reasoning_effort.clone());
            Arc::new(p)
        }
        pi_messages::FAMILY => {
            let o: PiOptions = decode(options.protocol)?;
            if o.cache_retention
                .as_ref()
                .is_some_and(|v| !matches!(v.as_str(), "none" | "short" | "long"))
            {
                return Err(ExecutionError::new(
                    "cache_retention",
                    "cache retention must be none, short or long",
                ));
            }
            Arc::new(pi_messages::PiMessagesProvider {
                connection,
                max_output_tokens: c.max_output_tokens,
                reasoning: c.reasoning_effort.clone(),
                cache_retention: o.cache_retention,
            })
        }
        _ => {
            return Err(ExecutionError::new(
                "unsupported_provider",
                "selected model adapter is unavailable",
            ))
        }
    };
    if let Some(t) = options.temperature {
        match c.provider_family.as_str() {
            google::FAMILY | google::VERTEX_FAMILY => {
                fields["generationConfig"]["temperature"] = json!(t)
            }
            bedrock::FAMILY => fields["inferenceConfig"]["temperature"] = json!(t),
            pi_messages::FAMILY => fields["options"]["temperature"] = json!(t),
            _ => fields["temperature"] = json!(t),
        }
    }
    if let Some(parameters) = options.sampling_params {
        if !matches!(
            c.provider_family.as_str(),
            chat::FAMILY | responses::FAMILY | azure::FAMILY
        ) {
            return Err(ExecutionError::new(
                "unsupported_sampling_parameters",
                "selected adapter does not accept OpenAI sampling parameters",
            ));
        }
        for (key, value) in parameters {
            if matches!(
                key.as_str(),
                "model"
                    | "messages"
                    | "input"
                    | "instructions"
                    | "tools"
                    | "stream"
                    | "max_tokens"
                    | "max_completion_tokens"
                    | "max_output_tokens"
            ) {
                return Err(ExecutionError::new("sampling_parameters", "sampling parameters cannot replace the frozen model, history, tools or output capacity"));
            }
            fields[key] = value;
        }
    }
    Ok(Arc::new(ConfiguredProvider { inner, fields }))
}
struct ConfiguredProvider {
    inner: Arc<dyn ModelProvider>,
    fields: Value,
}
impl ModelProvider for ConfiguredProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        let mut value = self.inner.serialize(view)?;
        merge(&mut value, &self.fields);
        Ok(value)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.inner.generate(request, cancel, emit)
    }
}
fn merge(target: &mut Value, fields: &Value) {
    if let (Some(target), Some(fields)) = (target.as_object_mut(), fields.as_object()) {
        for (key, value) in fields {
            if value.is_object() && target.get(key).is_some_and(Value::is_object) {
                merge(target.get_mut(key).unwrap(), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
