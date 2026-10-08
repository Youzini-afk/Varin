//! Dispatch-only credentials behind an injected, sole-owner transactional store.
//! Login and credential-file ownership are deliberately outside the model runtime.
use super::{failure, CredentialResolver, ModelFailure};
use crate::execution::CancellationToken;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialScope {
    pub reference: String,
    pub authority: String,
    /// Durable local credential-binding handle, not an external provider account claim.
    pub account: String,
    /// Changes on account relink/revocation, not normal same-account token refresh.
    pub generation: u64,
}
impl CredentialScope {
    pub fn validate(&self) -> Result<(), CredentialError> {
        if self.reference.is_empty() || self.authority.is_empty() || self.account.is_empty() {
            Err(CredentialError::InvalidScope)
        } else {
            Ok(())
        }
    }
}
/// Secrets have no Debug or serde implementation. They never belong in catalog/history DTOs.
#[derive(Clone)]
pub struct Secret(String);
impl Secret {
    pub fn new(value: impl Into<String>) -> Result<Self, CredentialError> {
        let value = value.into();
        if value.is_empty() {
            Err(CredentialError::Missing)
        } else {
            Ok(Self(value))
        }
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
#[derive(Clone)]
pub struct OAuthTokens {
    pub access: Secret,
    pub refresh: Secret,
    pub expires_at_ms: u64,
}
#[derive(Clone)]
pub enum CredentialMaterial {
    ApiKey(Secret),
    OAuth(OAuthTokens),
}
#[derive(Clone)]
pub struct CredentialRecord {
    pub scope: CredentialScope,
    pub material: CredentialMaterial,
}
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum CredentialError {
    #[error("credential resolution cancelled")]
    Cancelled,
    #[error("invalid trusted credential scope")]
    InvalidScope,
    #[error("credential reference is not registered")]
    Unregistered,
    #[error("credential is missing")]
    Missing,
    #[error("credential identity changed")]
    ScopeChanged,
    #[error("credential store unavailable")]
    StoreUnavailable,
    #[error("credential persistence failed")]
    PersistenceFailed,
    #[error("OAuth refresh handler is unavailable")]
    RefreshUnavailable,
    #[error("OAuth refresh failed")]
    RefreshFailed,
    #[error("OAuth response is invalid")]
    InvalidRefresh,
    #[error("credential header is invalid")]
    InvalidHeader,
    #[error("credential broker worker unavailable")]
    WorkerUnavailable,
}
impl CredentialError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::InvalidScope => "invalid_credential_scope",
            Self::Unregistered => "unknown_credential_ref",
            Self::Missing => "credential_missing",
            Self::ScopeChanged => "credential_scope_changed",
            Self::StoreUnavailable => "credential_store_unavailable",
            Self::PersistenceFailed => "credential_persistence_failed",
            Self::RefreshUnavailable => "oauth_refresh_unavailable",
            Self::RefreshFailed => "oauth_refresh_failed",
            Self::InvalidRefresh => "invalid_oauth_refresh",
            Self::InvalidHeader => "invalid_credential_header",
            Self::WorkerUnavailable => "credential_worker_unavailable",
        }
    }
    fn model_failure(&self) -> ModelFailure {
        failure(self.code(), &self.to_string())
    }
}
/// Sole persistence authority. The transaction must:
/// - acquire a cancellable per-reference lock (cross-process when the backing store is shared)
/// - read the current credential only after acquiring it
/// - run `update`, durably persist its successful mutation, then release the lock
/// - roll back on update failure and report write failures; never return an unpersisted refresh
/// `wait_cancel` cancels lock acquisition only. Once update starts, its refresh must settle.
pub trait CredentialStore: Send + Sync {
    fn transaction(
        &self,
        reference: &str,
        wait_cancel: &CancellationToken,
        update: &mut dyn FnMut(&mut CredentialRecord) -> Result<(), CredentialError>,
    ) -> Result<CredentialRecord, CredentialError>;
}
pub struct OAuthRefresh {
    pub account: String,
    pub tokens: OAuthTokens,
}
pub trait OAuthRefresher: Send + Sync {
    /// Implementations must bound network I/O by timeout. This operation deliberately has no run
    /// cancellation token: a rotated refresh credential must survive cancelled request waiters.
    fn refresh(
        &self,
        scope: &CredentialScope,
        current: &OAuthTokens,
        timeout: Duration,
    ) -> Result<OAuthRefresh, CredentialError>;
}
#[derive(Clone)]
pub struct CredentialBinding {
    pub scope: CredentialScope,
    pub header: HeaderName,
    pub prefix: String,
    pub account_header: Option<HeaderName>,
    /// Verified external provider account ID, required when account_header is configured.
    pub provider_account: Option<String>,
    pub additional_headers: HeaderMap,
    pub refresher: Option<Arc<dyn OAuthRefresher>>,
    pub minimum_validity: Duration,
    pub refresh_timeout: Duration,
}
impl CredentialBinding {
    pub fn bearer(scope: CredentialScope) -> Self {
        Self {
            scope,
            header: reqwest::header::AUTHORIZATION,
            prefix: "Bearer ".into(),
            account_header: None,
            provider_account: None,
            additional_headers: HeaderMap::new(),
            refresher: None,
            minimum_validity: Duration::from_secs(300),
            refresh_timeout: Duration::from_secs(15),
        }
    }
}
struct WorkerRuntime(Option<tokio::runtime::Runtime>);
impl Drop for WorkerRuntime {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.take() {
            runtime.shutdown_background();
        }
    }
}
/// Refresh single-flight is provided by the authoritative store's per-reference transaction,
/// not a process-global credential cache. A cancelled waiter never cancels a started refresh.
pub struct NativeCredentialBroker {
    store: Arc<dyn CredentialStore>,
    bindings: BTreeMap<String, CredentialBinding>,
    runtime: OnceLock<Result<WorkerRuntime, CredentialError>>,
}
impl NativeCredentialBroker {
    pub fn new(
        store: Arc<dyn CredentialStore>,
        bindings: Vec<CredentialBinding>,
    ) -> Result<Self, CredentialError> {
        let mut registered = BTreeMap::new();
        for binding in bindings {
            binding.scope.validate()?;
            if binding.refresh_timeout.is_zero() {
                return Err(CredentialError::InvalidScope);
            }
            if registered
                .insert(binding.scope.reference.clone(), binding)
                .is_some()
            {
                return Err(CredentialError::InvalidScope);
            }
        }
        Ok(Self {
            store,
            bindings: registered,
            runtime: OnceLock::new(),
        })
    }
    pub fn scope(&self, reference: &str) -> Option<&CredentialScope> {
        self.bindings.get(reference).map(|binding| &binding.scope)
    }
    fn resolve(
        &self,
        reference: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<HeaderMap, CredentialError> {
        if cancel.is_cancelled() {
            return Err(CredentialError::Cancelled);
        }
        let binding = self
            .bindings
            .get(reference.ok_or(CredentialError::Missing)?)
            .ok_or(CredentialError::Unregistered)?
            .clone();
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(CredentialError::WorkerUnavailable);
        }
        let runtime = self
            .runtime
            .get_or_init(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .map(|runtime| WorkerRuntime(Some(runtime)))
                    .map_err(|_| CredentialError::WorkerUnavailable)
            })
            .as_ref()
            .map_err(Clone::clone)?
            .0
            .as_ref()
            .ok_or(CredentialError::WorkerUnavailable)?;
        let store = self.store.clone();
        let wait_cancel = cancel.clone();
        let task = runtime.spawn_blocking(move || {
            let record =
                store.transaction(&binding.scope.reference, &wait_cancel, &mut |record| {
                    if wait_cancel.is_cancelled() {
                        return Err(CredentialError::Cancelled);
                    }
                    if record.scope != binding.scope {
                        return Err(CredentialError::ScopeChanged);
                    }
                    if let CredentialMaterial::OAuth(tokens) = &record.material {
                        let deadline = now_ms().saturating_add(
                            binding
                                .minimum_validity
                                .as_millis()
                                .min(u128::from(u64::MAX)) as u64,
                        );
                        if tokens.expires_at_ms <= deadline {
                            let refresher = binding
                                .refresher
                                .as_ref()
                                .ok_or(CredentialError::RefreshUnavailable)?;
                            let refreshed = refresher.refresh(
                                &binding.scope,
                                tokens,
                                binding.refresh_timeout,
                            )?;
                            if refreshed.account != binding.scope.account {
                                return Err(CredentialError::ScopeChanged);
                            }
                            if refreshed.tokens.expires_at_ms <= now_ms() {
                                return Err(CredentialError::InvalidRefresh);
                            }
                            record.material = CredentialMaterial::OAuth(refreshed.tokens);
                        }
                    }
                    Ok(())
                })?;
            if record.scope != binding.scope {
                return Err(CredentialError::ScopeChanged);
            }
            let secret = match &record.material {
                CredentialMaterial::ApiKey(secret) => secret,
                CredentialMaterial::OAuth(tokens) => &tokens.access,
            };
            let mut headers = binding.additional_headers;
            let mut value =
                HeaderValue::from_str(&format!("{}{}", binding.prefix, secret.expose()))
                    .map_err(|_| CredentialError::InvalidHeader)?;
            value.set_sensitive(true);
            headers.insert(binding.header, value);
            if let Some(header) = binding.account_header {
                let account = binding
                    .provider_account
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .ok_or(CredentialError::InvalidScope)?;
                let value =
                    HeaderValue::from_str(account).map_err(|_| CredentialError::InvalidHeader)?;
                headers.insert(header, value);
            }
            Ok(headers)
        });
        runtime.block_on(async{tokio::select!{biased;_ = cancel.cancelled()=>Err(CredentialError::Cancelled),result=task=>result.map_err(|_|CredentialError::WorkerUnavailable)?}})
    }
}
impl CredentialResolver for NativeCredentialBroker {
    fn headers(
        &self,
        reference: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<HeaderMap, ModelFailure> {
        self.resolve(reference, cancel)
            .map_err(|error| error.model_failure())
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[derive(Clone, Copy)]
pub enum RefreshEncoding {
    Form,
    Json,
}
/// Standard public-client OAuth refresh exchange. Registration supplies the trusted endpoint and
/// client ID; there is no login, scope expansion, client-secret storage, or endpoint from model text.
pub struct HttpOAuthRefresher {
    client: reqwest::blocking::Client,
    endpoint: reqwest::Url,
    client_id: String,
    encoding: RefreshEncoding,
    pub response_budget: usize,
}
impl HttpOAuthRefresher {
    pub fn new(
        builder: reqwest::blocking::ClientBuilder,
        endpoint: &str,
        client_id: impl Into<String>,
        encoding: RefreshEncoding,
    ) -> Result<Self, CredentialError> {
        let endpoint = reqwest::Url::parse(endpoint).map_err(|_| CredentialError::InvalidScope)?;
        if endpoint.scheme() != "https"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(CredentialError::InvalidScope);
        }
        let client = builder
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| CredentialError::WorkerUnavailable)?;
        let client_id = client_id.into();
        if client_id.is_empty() {
            return Err(CredentialError::InvalidScope);
        }
        Ok(Self {
            client,
            endpoint,
            client_id,
            encoding,
            response_budget: 1024 * 1024,
        })
    }
}
impl OAuthRefresher for HttpOAuthRefresher {
    fn refresh(
        &self,
        scope: &CredentialScope,
        current: &OAuthTokens,
        timeout: Duration,
    ) -> Result<OAuthRefresh, CredentialError> {
        let values = [
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh.expose()),
            ("client_id", self.client_id.as_str()),
        ];
        let request = self.client.post(self.endpoint.clone()).timeout(timeout);
        let request=match self.encoding{RefreshEncoding::Form=>request.form(&values),RefreshEncoding::Json=>request.json(&json!({"grant_type":"refresh_token","refresh_token":current.refresh.expose(),"client_id":self.client_id}))};
        let response = request.send().map_err(|_| CredentialError::RefreshFailed)?;
        if !response.status().is_success() {
            return Err(CredentialError::RefreshFailed);
        }
        let mut bytes = Vec::new();
        response
            .take(self.response_budget.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| CredentialError::RefreshFailed)?;
        if bytes.len() > self.response_budget {
            return Err(CredentialError::InvalidRefresh);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| CredentialError::InvalidRefresh)?;
        let access = Secret::new(
            value["access_token"]
                .as_str()
                .ok_or(CredentialError::InvalidRefresh)?,
        )?;
        let refresh = match value.get("refresh_token") {
            Some(value) => Secret::new(value.as_str().ok_or(CredentialError::InvalidRefresh)?)?,
            None => current.refresh.clone(),
        };
        let lifetime = value["expires_in"]
            .as_u64()
            .filter(|seconds| *seconds > 0)
            .and_then(|seconds| seconds.checked_mul(1000))
            .ok_or(CredentialError::InvalidRefresh)?;
        Ok(OAuthRefresh {
            account: scope.account.clone(),
            tokens: OAuthTokens {
                access,
                refresh,
                expires_at_ms: now_ms()
                    .checked_add(lifetime)
                    .ok_or(CredentialError::InvalidRefresh)?,
            },
        })
    }
}
