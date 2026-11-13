use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub id: String,
    pub tool: String,
    #[serde(flatten)]
    pub params: Map<String, Value>,
}
impl Request {
    pub fn value(&self, key: &str) -> &Value {
        self.params.get(key).unwrap_or(&Value::Null)
    }
    pub fn text(&self, key: &str) -> &str {
        self.value(key).as_str().unwrap_or("")
    }
    pub fn boolean(&self, key: &str) -> bool {
        self.value(key).as_bool().unwrap_or(false)
    }
    pub fn number(&self, key: &str) -> f64 {
        self.value(key).as_f64().unwrap_or(0.0)
    }
    pub fn positive(&self, key: &str, default: usize) -> usize {
        self.value(key)
            .as_u64()
            .filter(|v| *v > 0)
            .and_then(|v| usize::try_from(v).ok())
            .unwrap_or(default)
    }
    pub fn is_action(&self) -> bool {
        matches!(
            self.tool.as_str(),
            "click"
                | "perform_secondary_action"
                | "scroll"
                | "drag"
                | "type_text"
                | "press_key"
                | "set_value"
                | "set_checked"
                | "set_expanded"
                | "select"
                | "scroll_into_view"
                | "inject_input"
                | "open"
        )
    }
    pub fn parse(line: &str) -> Result<Self> {
        let request: Self = serde_json::from_str(line).map_err(|_| {
            Failure::new(
                "invalid-request",
                "Expected a UTF-8 JSON request with string id and tool",
            )
        })?;
        if request.id.is_empty() || request.tool.is_empty() {
            return Err(Failure::new(
                "invalid-request",
                "Request id and tool must not be empty",
            ));
        }
        Ok(request)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Failure>;
impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "The computer operation was cancelled")
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Failure {}
#[cfg(windows)]
impl From<windows::core::Error> for Failure {
    fn from(error: windows::core::Error) -> Self {
        // Do not echo provider error descriptions: a provider can include field contents.
        Self::new(
            "driver-error",
            format!(
                "Windows API failed (HRESULT 0x{:08x})",
                error.code().0 as u32
            ),
        )
    }
}

#[derive(Clone, Debug, Default)]
pub struct RequestState {
    active: Option<String>,
    cancelled: HashSet<String>,
    retired: bool,
    dispatched: u64,
    semantic: bool,
    verified: bool,
    mechanism: Option<String>,
    observed_state: Option<Value>,
}
impl RequestState {
    pub fn begin(&mut self, id: &str) -> Result<()> {
        self.active = Some(id.to_owned());
        self.dispatched = 0;
        self.semantic = false;
        self.verified = false;
        self.mechanism = None;
        self.observed_state = None;
        self.check()
    }
    pub fn end(&mut self) {
        if let Some(id) = self.active.take() {
            self.cancelled.remove(&id);
        }
    }
    pub fn check(&self) -> Result<()> {
        if self.retired
            || self
                .active
                .as_ref()
                .is_some_and(|id| self.cancelled.contains(id))
        {
            Err(Failure::cancelled())
        } else {
            Ok(())
        }
    }
    pub fn cancel(&mut self, id: &str) {
        self.cancelled.insert(id.to_owned());
    }
    pub fn retire(&mut self) {
        self.retired = true;
    }
    pub fn is_active(&self, id: &str) -> bool {
        self.active.as_deref() == Some(id)
    }
    pub fn accept(&mut self, count: u64) {
        self.dispatched = self.dispatched.saturating_add(count);
    }
    pub fn attempt_semantic(&mut self) -> Result<()> {
        self.check()?;
        self.semantic = true;
        Ok(())
    }
    pub fn mechanism(&mut self, mechanism: &str) {
        self.mechanism = Some(mechanism.to_owned());
    }
    pub fn observed_state(&mut self, state: Value) {
        self.observed_state = Some(state);
    }
    pub fn verify(&mut self) {
        self.verified = true;
    }
    pub fn effect(&self, success: bool) -> &'static str {
        if self.verified {
            "verified"
        } else if success && (self.dispatched > 0 || self.semantic) {
            "dispatched"
        } else if self.semantic {
            "unknown"
        } else if self.dispatched > 0 {
            "partial"
        } else {
            "none"
        }
    }
    pub fn receipt(&self, failure: Option<&Failure>) -> Value {
        let mut receipt =
            json!({"effect": self.effect(failure.is_none()), "dispatchedEvents": self.dispatched});
        if let Some(mechanism) = &self.mechanism {
            receipt["mechanism"] = json!(mechanism);
        }
        if let Some(state) = &self.observed_state {
            receipt["observedState"] = state.clone();
        }
        if let Some(error) = failure {
            let code = match error.code {
                "target-changed"
                | "focus-changed"
                | "target-unavailable"
                | "unsupported"
                | "input-rejected"
                | "cancelled"
                | "control-changed"
                | "connection-lost"
                | "session-closed"
                | "verification-failed" => error.code,
                _ => "driver-error",
            };
            receipt["reason"] = json!({"code": code, "message": error.message});
            receipt["recovery"] = json!("observe");
        }
        receipt
    }
    pub fn failure(&self, error: &Failure) -> Value {
        json!({"ok":false, "code":error.code, "cancelled":error.code == "cancelled", "rejected": self.effect(false) == "none", "error":error.message, "receipt":self.receipt(Some(error))})
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn center(self) -> Point {
        Point {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
    pub fn absolute(self, window: Rect) -> Rect {
        Rect {
            x: self.x + window.x,
            y: self.y + window.y,
            ..self
        }
    }
    pub fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

pub fn handshake() -> Value {
    json!({"protocolVersion":PROTOCOL_VERSION,"build":{"version":env!("VARIN_COMPUTER_VERSION"),"architecture":if cfg!(target_arch="aarch64") { "arm64" } else if cfg!(target_arch="x86_64") { "x64" } else { std::env::consts::ARCH },"buildId":env!("VARIN_COMPUTER_BUILD_ID")}})
}
pub fn text_limit(value: &Value) -> Option<usize> {
    if value
        .as_str()
        .is_some_and(|s| s.trim().eq_ignore_ascii_case("max"))
    {
        None
    } else {
        Some(
            value
                .as_u64()
                .filter(|v| *v > 0)
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(500),
        )
    }
}
pub fn limit_text(text: &str, limit: Option<usize>) -> String {
    match limit {
        Some(limit) if text.chars().count() > limit => {
            format!("{}...", text.chars().take(limit).collect::<String>())
        }
        _ => text.to_owned(),
    }
}

pub fn normalize_pointer(value: i32, origin: i32, length: i32) -> Result<i32> {
    let offset = value as i64 - origin as i64;
    if length <= 0 || offset < 0 || offset >= length as i64 {
        return Err(Failure::new(
            "target-changed",
            "Pointer coordinate is outside the current virtual desktop; observe again",
        ));
    }
    // Center of the destination physical pixel in the Win32 normalized grid.
    let normalized = (((2 * offset + 1) * 65536) / (2 * length as i64)).clamp(0, 65535);
    if normalized * length as i64 / 65536 != offset {
        return Err(Failure::new(
            "target-changed",
            "Pointer coordinate cannot be represented by the Windows absolute input grid",
        ));
    }
    Ok(normalized as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_feedback_without_dispatch_is_a_noop_not_verification() {
        let mut state = RequestState::default();
        state.begin("already-checked").unwrap();
        state.mechanism("accessibility");
        state.observed_state(json!({"checked":true}));
        assert_eq!(state.receipt(None)["effect"], "none");
        assert_eq!(state.receipt(None)["observedState"]["checked"], true);
        state.attempt_semantic().unwrap();
        assert_eq!(state.receipt(None)["effect"], "dispatched");
        state.verify();
        assert_eq!(state.receipt(None)["effect"], "verified");
        state.end();
        state.begin("next").unwrap();
        assert!(state.receipt(None).get("observedState").is_none());
        assert!(state.receipt(None).get("mechanism").is_none());
    }
    #[test]
    fn a_semantic_failure_does_not_become_a_clean_rejection() {
        let mut state = RequestState::default();
        state.begin("toggle").unwrap();
        state.mechanism("accessibility");
        state.attempt_semantic().unwrap();
        state.observed_state(json!({"checked":"mixed"}));
        let failure = state.failure(&Failure::new("verification-failed", "Still mixed"));
        assert_eq!(failure["code"], "verification-failed");
        assert_eq!(failure["receipt"]["effect"], "unknown");
        assert_eq!(failure["rejected"], false);
        assert_eq!(failure["receipt"]["observedState"]["checked"], "mixed");
    }
    #[test]
    fn state_actions_use_the_existing_action_receipt_and_query_does_not() {
        for tool in ["set_checked", "set_expanded", "select", "scroll_into_view"] {
            assert!(
                Request::parse(&json!({"id":"a","tool":tool}).to_string())
                    .unwrap()
                    .is_action()
            );
        }
        assert!(
            !Request::parse(r#"{"id":"q","tool":"query_elements"}"#)
                .unwrap()
                .is_action()
        );
    }
    #[test]
    fn cancellation_before_delivery_survives_begin_but_not_the_next_request() {
        let mut state = RequestState::default();
        state.cancel("old");
        assert_eq!(state.begin("old").unwrap_err().code, "cancelled");
        state.end();
        state.begin("new").unwrap();
        assert!(state.check().is_ok());
    }
    #[test]
    fn retirement_is_not_cleared_by_a_new_request() {
        let mut state = RequestState::default();
        state.retire();
        assert!(state.begin("next").is_err());
    }
    #[test]
    fn receipts_distinguish_no_partial_unknown_and_verified_effects() {
        let mut state = RequestState::default();
        state.begin("action").unwrap();
        assert_eq!(state.effect(false), "none");
        state.accept(3);
        assert_eq!(state.effect(false), "partial");
        assert_eq!(state.effect(true), "dispatched");
        state.attempt_semantic().unwrap();
        assert_eq!(state.effect(false), "unknown");
        state.verify();
        assert_eq!(state.effect(true), "verified");
    }
    #[test]
    fn cancelled_partial_input_is_not_a_rejection() {
        let mut state = RequestState::default();
        state.begin("a").unwrap();
        state.accept(1);
        state.cancel("a");
        let result = state.failure(&state.check().unwrap_err());
        assert_eq!(result["rejected"], false);
        assert_eq!(result["receipt"]["dispatchedEvents"], 1);
    }
    #[test]
    fn unicode_request_and_limits_do_not_split_surrogates() {
        let request =
            Request::parse(r#"{"id":"中文","tool":"type_text","text":"中文🦀"}"#).unwrap();
        assert_eq!(request.text("text"), "中文🦀");
        assert_eq!(limit_text("中文🦀!", Some(3)), "中文🦀...");
        assert_eq!(text_limit(&json!("max")), None);
        assert_eq!(text_limit(&json!(true)), Some(500));
    }
    #[test]
    fn malformed_requests_do_not_echo_input_contents() {
        let error = Request::parse(r#"{"text":"private password"}"#).unwrap_err();
        assert!(!error.message.contains("private"));
    }
    #[test]
    fn absolute_pointer_grid_preserves_negative_desktop_origins_and_edge_pixels() {
        for width in [1, 1920, 3840, 7680, 32768] {
            for offset in [0, width / 2, width - 1] {
                let normalized = normalize_pointer(-1920 + offset, -1920, width).unwrap();
                assert_eq!(normalized as i64 * width as i64 / 65536, offset as i64);
            }
        }
        assert!(normalize_pointer(-1921, -1920, 3840).is_err());
        assert!(normalize_pointer(1920, -1920, 3840).is_err());
    }
}
