use serde_json::Value;
use std::io;
use thiserror::Error;

#[derive(Debug, Clone, Copy)]
pub(crate) enum FileObservationSourceCode {
    RootChanged,
    SourceUnavailable,
    AuthorityDenied,
    WatchUnavailable,
    Cancelled,
}
impl FileObservationSourceCode {
    pub(crate) fn parse(code: &str) -> Option<Self> {
        match code {
            "root_changed" => Some(Self::RootChanged),
            "source_unavailable" => Some(Self::SourceUnavailable),
            "authority_denied" => Some(Self::AuthorityDenied),
            "watch_unavailable" => Some(Self::WatchUnavailable),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::RootChanged => "root_changed",
            Self::SourceUnavailable => "source_unavailable",
            Self::AuthorityDenied => "authority_denied",
            Self::WatchUnavailable => "watch_unavailable",
            Self::Cancelled => "cancelled",
        }
    }
}
impl std::fmt::Display for FileObservationSourceCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Error)]
pub(crate) enum KernelError {
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("authorization error: {0}")]
    Authorization(String),
    #[error("operation error: {0}")]
    Operation(String),
    #[error("file observation source failed: {0}")]
    FileObservationSource(FileObservationSourceCode),
    #[error("file observation is busy under an existing writer or capture lease")]
    FileObservationBusy,
    #[error("snapshot changed: {0}")]
    SnapshotChanged(String),
    #[error("activation held: {0}")]
    ActivationHeld(String),
    #[error("operation cancelled")]
    Cancelled,
}

impl From<rusqlite::Error> for KernelError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value.to_string())
    }
}
impl From<io::Error> for KernelError {
    fn from(value: io::Error) -> Self {
        Self::Storage(value.to_string())
    }
}
impl From<serde_json::Error> for KernelError {
    fn from(value: serde_json::Error) -> Self {
        Self::Protocol(value.to_string())
    }
}

pub(crate) fn error_code(error: &KernelError) -> &'static str {
    match error {
        KernelError::Protocol(_) => "protocol-error",
        KernelError::Storage(_) => "storage-error",
        KernelError::Authorization(_) => "unauthorized",
        KernelError::Operation(_)
        | KernelError::FileObservationSource(_)
        | KernelError::FileObservationBusy
        | KernelError::SnapshotChanged(_) => "operation-error",
        KernelError::Cancelled => "cancelled",
        KernelError::ActivationHeld(_) => "activation-held",
    }
}

pub(crate) fn response_error(id: &str, error: &KernelError) -> Value {
    serde_json::json!({"v": 1, "kind": "response", "id": id, "ok": false, "error": {"code": error_code(error), "message": error.to_string(), "retryable": matches!(error, KernelError::Cancelled | KernelError::ActivationHeld(_))}})
}

#[cfg(test)]
mod tests {
    #[test]
    fn original_ingress_hold_has_its_own_retryable_wire_code() {
        let held = crate::agent_runtime::domain(varin_runtime::RuntimeError::RequestActivationHeld);
        let value = super::response_error("same-execution", &held);
        assert_eq!(value["error"]["code"], "activation-held");
        assert_eq!(value["error"]["retryable"], true);
        assert_eq!(
            super::error_code(&super::KernelError::Cancelled),
            "cancelled"
        );
    }
}
