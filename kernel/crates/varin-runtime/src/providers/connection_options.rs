//! Frozen nonsecret channel options over the existing HTTP transport and connection pools.
use super::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Mutex, Weak},
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelHttpConfiguration {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ModelProxyConfiguration>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelProxyConfiguration {
    Direct,
    Proxy { url: String },
}
fn invalid() -> ExecutionError {
    ExecutionError::new(
        "model_connection_invalid",
        "invalid model channel connection options",
    )
}
fn headers(options: &ModelHttpConfiguration) -> Result<reqwest::header::HeaderMap, ExecutionError> {
    let mut result = reqwest::header::HeaderMap::new();
    for (key, value) in options.headers.iter().flatten() {
        let lower = key.to_ascii_lowercase();
        if [
            "authorization",
            "cookie",
            "token",
            "secret",
            "password",
            "credential",
            "session",
            "signature",
            "api-key",
            "apikey",
            "access-key",
            "private-key",
        ]
        .iter()
        .any(|part| lower.contains(part))
            || matches!(
                lower.as_str(),
                "host"
                    | "connection"
                    | "content-length"
                    | "transfer-encoding"
                    | "proxy-connection"
                    | "upgrade"
                    | "trailer"
                    | "te"
            )
        {
            return Err(invalid());
        }
        let name =
            reqwest::header::HeaderName::from_bytes(key.as_bytes()).map_err(|_| invalid())?;
        let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| invalid())?;
        if result.insert(name, value).is_some() {
            return Err(invalid());
        }
    }
    Ok(result)
}
fn proxy_transport(
    proxy: &ModelProxyConfiguration,
) -> Result<Arc<dyn HttpTransport>, ExecutionError> {
    let (key, configured) = match proxy {
        ModelProxyConfiguration::Direct => ("direct".to_owned(), None),
        ModelProxyConfiguration::Proxy { url } => {
            let parsed = reqwest::Url::parse(url).map_err(|_| invalid())?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(invalid());
            }
            (
                parsed.as_str().to_owned(),
                Some(reqwest::Proxy::all(parsed.as_str()).map_err(|_| invalid())?),
            )
        }
    };
    static POOLS: OnceLock<Mutex<HashMap<String, Weak<dyn HttpTransport>>>> = OnceLock::new();
    let mut pools = POOLS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| invalid())?;
    pools.retain(|_, value| value.strong_count() != 0);
    if let Some(pool) = pools.get(&key).and_then(Weak::upgrade) {
        return Ok(pool);
    }
    let transport: Arc<dyn HttpTransport> = Arc::new(ReqwestTransport::new(move || {
        let builder = reqwest::Client::builder().no_proxy();
        if let Some(proxy) = &configured {
            builder.proxy(proxy.clone())
        } else {
            builder
        }
    }));
    pools.insert(key, Arc::downgrade(&transport));
    Ok(transport)
}
pub fn transport(
    options: Option<&ModelHttpConfiguration>,
) -> Result<Arc<dyn HttpTransport>, ExecutionError> {
    let Some(options) = options else {
        return Ok(shared_transport());
    };
    let headers = headers(options)?;
    let inner = if let Some(proxy) = &options.proxy {
        proxy_transport(proxy)?
    } else {
        shared_transport()
    };
    if headers.is_empty() {
        Ok(inner)
    } else {
        Ok(Arc::new(ChannelTransport { inner, headers }))
    }
}
struct ChannelTransport {
    inner: Arc<dyn HttpTransport>,
    headers: reqwest::header::HeaderMap,
}
impl ChannelTransport {
    fn request<'a>(&self, mut request: HttpRequest<'a>) -> HttpRequest<'a> {
        for (name, value) in &self.headers {
            if !request.headers.contains_key(name) {
                request.headers.insert(name, value.clone());
            }
        }
        request
    }
}
impl HttpTransport for ChannelTransport {
    fn stream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.inner.stream(self.request(request), cancel, receive)
    }
    fn stream_to_eof(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.inner
            .stream_to_eof(self.request(request), cancel, receive)
    }
    fn stream_eventstream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.inner
            .stream_eventstream(self.request(request), cancel, receive)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_options_reuse_proxy_pools_without_secret_or_transport_override() {
        let options = ModelHttpConfiguration {
            headers: None,
            proxy: Some(ModelProxyConfiguration::Proxy {
                url: "http://proxy.example:8080".into(),
            }),
        };
        let first = transport(Some(&options)).unwrap();
        let second = transport(Some(&options)).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let direct = transport(Some(&ModelHttpConfiguration {
            headers: None,
            proxy: Some(ModelProxyConfiguration::Direct),
        }))
        .unwrap();
        assert!(!Arc::ptr_eq(&direct, &first));
        for name in [
            "Authorization",
            "X-Api-Key",
            "X-Access-Token",
            "Host",
            "Transfer-Encoding",
        ] {
            assert!(
                transport(Some(&ModelHttpConfiguration {
                    headers: Some(BTreeMap::from([(name.into(), "value".into())])),
                    proxy: None
                }))
                .is_err()
            );
        }
        assert!(
            transport(Some(&ModelHttpConfiguration {
                headers: None,
                proxy: Some(ModelProxyConfiguration::Proxy {
                    url: "http://user:password@proxy.example".into()
                })
            }))
            .is_err()
        );
    }
    struct Capture;
    impl HttpTransport for Capture {
        fn stream(
            &self,
            request: HttpRequest<'_>,
            _: &CancellationToken,
            _: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
        ) -> Result<(), ModelFailure> {
            assert_eq!(request.headers["authorization"], "Bearer private");
            assert_eq!(request.headers["x-region"], "original");
            assert_eq!(request.headers["x-client"], "channel");
            Ok(())
        }
    }
    #[test]
    fn original_dispatch_and_protocol_headers_win_over_channel_defaults() {
        let options = ModelHttpConfiguration {
            headers: Some(BTreeMap::from([
                ("x-region".into(), "edited".into()),
                ("x-client".into(), "channel".into()),
            ])),
            proxy: None,
        };
        let wrapper = ChannelTransport {
            inner: Arc::new(Capture),
            headers: headers(&options).unwrap(),
        };
        let mut authorized = reqwest::header::HeaderMap::new();
        authorized.insert("authorization", "Bearer private".parse().unwrap());
        authorized.insert("x-region", "original".parse().unwrap());
        wrapper
            .stream(
                HttpRequest {
                    endpoint: "https://example.test",
                    headers: authorized,
                    body: &serde_json::json!({}).into(),
                },
                &CancellationToken::default(),
                &mut |_| Ok(false),
            )
            .unwrap();
    }
}
