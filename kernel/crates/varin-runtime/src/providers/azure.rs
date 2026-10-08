//! Azure Responses uses deployment names, an explicit API version, and Azure credential headers.
//! The SSE protocol is shared with Responses, but continuation families remain distinct.
use super::*;
pub const FAMILY: &str = "azure-openai-responses";
pub struct AzureResponsesProvider {
    inner: responses::ResponsesProvider,
    deployment: String,
}
impl AzureResponsesProvider {
    /// `connection.endpoint` is the complete Responses URL, not an inferred resource hostname.
    /// The host resolves trusted resource/base URL defaults and deployment-name maps beforehand.
    pub fn new(
        mut connection: Connection,
        deployment: impl Into<String>,
        api_version: &str,
    ) -> Result<Self, ExecutionError> {
        let deployment = deployment.into();
        if deployment.trim().is_empty() || api_version.trim().is_empty() {
            return Err(ExecutionError::new(
                "invalid_azure_configuration",
                "Azure deployment and API version are required",
            ));
        }
        let mut url = reqwest::Url::parse(&connection.endpoint).map_err(|_| {
            ExecutionError::new(
                "invalid_azure_endpoint",
                "Azure endpoint must be a complete URL",
            )
        })?;
        let mut found = false;
        for (key, value) in url.query_pairs() {
            if key == "api-version" {
                if found || value != api_version {
                    return Err(ExecutionError::new(
                        "azure_api_version_conflict",
                        "endpoint API version conflicts with configuration",
                    ));
                }
                found = true;
            }
        }
        if !found {
            url.query_pairs_mut()
                .append_pair("api-version", api_version);
        }
        connection.endpoint = url.into();
        Ok(Self {
            inner: responses::ResponsesProvider::for_family(connection, FAMILY),
            deployment,
        })
    }
    pub fn set_max_output_tokens(&mut self, max: u64) {
        self.inner.max_output_tokens = Some(max);
    }
    pub fn set_reasoning(&mut self, reasoning: Option<Value>) {
        self.inner.reasoning = reasoning;
    }
}
impl ModelProvider for AzureResponsesProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        let mut value = self.inner.serialize(view)?;
        value["model"] = Value::String(self.deployment.clone());
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
