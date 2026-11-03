//! Inert native presentation policies. Input is a renderer/Host projection, never
//! a second source of session, approval, or execution state.
#[cfg(test)]
#[path = "native_notifications_windows_policy.rs"]
mod windows_notification_policy_tests;

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::OnceLock,
    time::{Duration, Instant},
};

static CATALOG: OnceLock<Value> = OnceLock::new();
pub fn normalize_locale(locale: &str) -> &'static str {
    let value = locale.to_lowercase().replace('_', "-");
    if value == "zh-tw" || value == "zh-hant" || value.starts_with("zh-hant-") {
        return "zh-TW";
    }
    if value.starts_with("zh") {
        return "zh-CN";
    }
    for language in ["en", "fr", "uk", "es", "ko", "ja", "pl"] {
        if value == language || value.starts_with(&format!("{language}-")) {
            return language;
        }
    }
    if value == "ua" || value.starts_with("ua-") {
        return "uk";
    }
    if value == "pt" || value == "pt-br" || value.starts_with("pt-br-") {
        return "pt-BR";
    }
    "en"
}
pub fn text(locale: &str, key: &str) -> String {
    let catalog = CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../application-client/src/native-messages.json"
        ))
        .expect("checked-in native catalog")
    });
    catalog["translatedLocales"]
        .as_array()
        .and_then(|locales| {
            locales
                .iter()
                .position(|value| value == normalize_locale(locale))
        })
        .and_then(|index| catalog["messages"][key][index].as_str())
        .unwrap_or(key)
        .to_owned()
}
pub fn counted(locale: &str, key: &str, count: usize) -> String {
    text(locale, key).replace("{count}", &count.to_string())
}
pub fn truncate(value: &str, max: usize) -> String {
    let value = value.trim();
    // Match JavaScript's UTF-16 length budget, without splitting a surrogate pair.
    if value.encode_utf16().count() <= max {
        return value.into();
    }
    let mut remaining = max.saturating_sub(1);
    let mut output = String::new();
    for ch in value.chars() {
        if ch.len_utf16() > remaining {
            break;
        }
        output.push(ch);
        remaining -= ch.len_utf16();
    }
    output.push('…');
    output
}
pub fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}
pub fn runtime_key(bootstrap: &Value) -> String {
    let endpoint = bootstrap["apiBaseUrl"].as_str().unwrap_or_default();
    let endpoint = url::Url::parse(endpoint)
        .map(|mut url| {
            url.set_fragment(None);
            url.to_string().trim_end_matches('/').to_owned()
        })
        .unwrap_or_else(|_| endpoint.into());
    json!([
        endpoint,
        bootstrap["relayHostId"].as_str().unwrap_or_default()
    ])
    .to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrayRow {
    pub label: String,
    pub subtitle: Option<String>,
    pub icon: Option<&'static str>,
    pub action: Value,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconState {
    Idle,
    Busy,
    Unseen,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TrayPresentation {
    pub header: String,
    pub title: String,
    pub tooltip: String,
    pub icon: IconState,
    pub approvals: Vec<TrayRow>,
    pub sessions: Vec<TrayRow>,
    pub badge: Option<i64>,
}
pub const VISIBLE_APPROVALS: usize = 10;
pub const VISIBLE_SESSIONS: usize = 8;
pub const BREATH_INTERVAL: Duration = Duration::from_millis(75);

fn rows<'a>(snapshot: &'a Value, key: &str) -> Vec<&'a Value> {
    snapshot[key]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|row| {
                    nonempty(&row["threadId"]).is_some() && nonempty(&row["branchId"]).is_some()
                })
                .collect()
        })
        .unwrap_or_default()
}
fn focus_action(row: &Value) -> Value {
    json!({"type":"focus-thread", "threadId":row["threadId"], "branchId":row["branchId"], "directory":row["directory"].as_str().unwrap_or_default()})
}
pub fn tray_presentation(snapshot: &Value, locale: &str) -> TrayPresentation {
    let sessions = rows(snapshot, "threads");
    let approvals = rows(snapshot, "approvals");
    let busy = sessions
        .iter()
        .filter(|s| matches!(s["status"].as_str(), Some("busy" | "retry")))
        .count();
    let errors = sessions.iter().filter(|s| s["hasError"] == true).count();
    let unseen: usize = sessions
        .iter()
        .map(|s| s["unseen"].as_u64().unwrap_or(0).min(usize::MAX as u64) as usize)
        .fold(0usize, usize::saturating_add);
    let title = if !approvals.is_empty() {
        format!("◆ {}", approvals.len())
    } else if errors > 0 {
        format!("▲ {errors}")
    } else {
        String::new()
    };
    let tooltip = if sessions.is_empty() {
        format!("Varin — {}", text(locale, "No active sessions"))
    } else {
        let mut bits = Vec::new();
        for (count, key) in [
            (approvals.len(), "{count} awaiting approval"),
            (errors, "{count} with errors"),
            (busy, "{count} working"),
            (unseen, "{count} unread"),
        ] {
            if count > 0 {
                bits.push(counted(locale, key, count));
            }
        }
        if bits.is_empty() {
            bits.push(text(locale, "Idle"));
        }
        format!(
            "Varin — {} · {}",
            counted(
                locale,
                if sessions.len() == 1 {
                    "{count} session"
                } else {
                    "{count} sessions"
                },
                sessions.len()
            ),
            bits.join(" · ")
        )
    };
    TrayPresentation {
        header: nonempty(&snapshot["instanceName"])
            .unwrap_or("Varin")
            .into(),
        title,
        tooltip,
        icon: if busy > 0 {
            IconState::Busy
        } else if unseen > 0 {
            IconState::Unseen
        } else {
            IconState::Idle
        },
        approvals: approvals
            .into_iter()
            .map(|a| {
                let permission = a["kind"] == "permission";
                let who = truncate(
                    a["threadTitle"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&text(locale, "Session")),
                    24,
                );
                let what = truncate(
                    a["label"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&text(
                            locale,
                            if permission {
                                "Permission request"
                            } else {
                                "Question"
                            },
                        )),
                    34,
                );
                TrayRow {
                    label: format!("{} {who} — {what}", if permission { "⛔" } else { "❓" }),
                    subtitle: None,
                    icon: None,
                    action: focus_action(a),
                }
            })
            .collect(),
        sessions: sessions
            .into_iter()
            .map(|s| TrayRow {
                label: truncate(
                    s["title"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&text(locale, "Untitled session")),
                    40,
                ),
                subtitle: nonempty(&s["subtitle"]).map(|s| truncate(s, 48)),
                icon: Some(if s["status"] == "busy" {
                    "busy"
                } else if s["status"] == "retry" {
                    "retry"
                } else if s["hasError"] == true {
                    "error"
                } else if s["unseen"].as_f64().unwrap_or(0.) > 0. {
                    "unseen"
                } else {
                    "blank"
                }),
                action: focus_action(s),
            })
            .collect(),
        badge: snapshot["dockBadgeCount"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.)
            .map(|n| n.floor().min(i64::MAX as f64) as i64)
            .filter(|n| *n > 0),
    }
}

/// Endpoint identity, never bearer rotation, scopes cross-source deduplication.
#[derive(Default)]
pub struct NotificationClaims {
    claims: HashMap<String, Instant>,
}
pub const NOTIFICATION_TTL: Duration = Duration::from_secs(5);
pub fn notification_payload(raw: &Value) -> Value {
    let mut payload = raw.as_object().cloned().unwrap_or_default();
    if let Some(nested) = raw["payload"].as_object() {
        payload.extend(nested.clone());
    }
    payload.remove("payload");
    Value::Object(payload)
}
pub fn notification_claim_key(payload: &Value, bootstrap: &Value) -> String {
    let tag = nonempty(&payload["tag"])
        .map(str::to_owned)
        .unwrap_or_else(|| {
            ["threadId", "branchId", "kind", "title", "body"]
                .iter()
                .filter_map(|key| nonempty(&payload[*key]))
                .collect::<Vec<_>>()
                .join("|")
        });
    json!([runtime_key(bootstrap), tag]).to_string()
}
pub fn notification_requires_hidden(payload: &Value) -> bool {
    payload
        .get("requireHidden")
        .filter(|v| !v.is_null())
        .unwrap_or(&payload["require_hidden"])
        == &Value::Bool(true)
}
impl NotificationClaims {
    pub fn claim(&mut self, key: String, now: Instant) -> bool {
        self.claims
            .retain(|_, claimed| now.saturating_duration_since(*claimed) < NOTIFICATION_TTL);
        if self.claims.contains_key(&key) {
            return false;
        }
        self.claims.insert(key, now);
        true
    }
    pub fn release(&mut self, key: &str) {
        self.claims.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activity_and_status_precedence_follow_real_projection() {
        let p = tray_presentation(
            &json!({"threads":[{"threadId":"t","branchId":"b","status":"retry","hasError":true,"unseen":3}],"approvals":[{"threadId":"t","branchId":"b","kind":"permission"}]}),
            "en",
        );
        assert_eq!(p.icon, IconState::Busy);
        assert_eq!(p.title, "◆ 1");
        assert_eq!(p.sessions[0].icon, Some("retry"));
        assert_eq!(
            p.tooltip,
            "Varin — 1 session · 1 awaiting approval · 1 with errors · 1 working · 3 unread"
        );
        assert_eq!(
            p.approvals[0].action,
            json!({"type":"focus-thread","threadId":"t","branchId":"b","directory":""})
        );
    }
    #[test]
    fn overflow_keeps_every_original_target_and_no_fake_idle_work() {
        let rows:Vec<_>=(0..23).map(|i|json!({"threadId":format!("t{i}"),"branchId":format!("b{i}"),"directory":format!("/work/{i}")})).collect();
        let p = tray_presentation(&json!({"threads":rows,"approvals":rows}), "en");
        assert_eq!(p.sessions[VISIBLE_SESSIONS..].len(), 15);
        assert_eq!(p.approvals[VISIBLE_APPROVALS..].len(), 13);
        assert_eq!(p.sessions[22].action["branchId"], "b22");
        assert_eq!(p.icon, IconState::Idle);
        let idle = tray_presentation(&json!({"threads":[{"threadId":"missing-branch"}]}), "en");
        assert_eq!(idle.tooltip, "Varin — No active sessions");
        assert_eq!(idle.title, "");
        assert!(idle.sessions.is_empty());
    }
    #[test]
    fn locale_refresh_and_titles_never_translate_user_content() {
        let snapshot = json!({"instanceName":"  Work  ","threads":[{"threadId":"t","branchId":"b","title":"Settings","unseen":1}]});
        let en = tray_presentation(&snapshot, "en");
        let zh = tray_presentation(&snapshot, "zh_Hans_CN");
        assert_eq!(zh.sessions[0].label, "Settings");
        assert_eq!(zh.header, "Work");
        assert_ne!(en.tooltip, zh.tooltip);
        assert_eq!(zh.icon, IconState::Unseen);
        assert_eq!(normalize_locale("zh-Hant-HK"), "zh-TW");
        assert_eq!(normalize_locale("ua-UA"), "uk");
        assert_eq!(normalize_locale("pt-PT"), "en");
        assert_eq!(truncate("  😀😀😀  ", 4), "😀…");
    }
    #[test]
    fn notifications_normalize_wrappers_and_dedupe_only_same_host() {
        let payload = notification_payload(
            &json!({"title":"outer","payload":{"title":"inner","tag":"one","require_hidden":true}}),
        );
        assert_eq!(payload["title"], "inner");
        assert!(notification_requires_hidden(&payload));
        let a =
            json!({"apiBaseUrl":"https://a.invalid/","clientToken":"secret-a","relayHostId":"a"});
        let rotated = json!({"apiBaseUrl":"https://a.invalid#ignored","clientToken":"secret-b","relayHostId":"a"});
        let b = json!({"apiBaseUrl":"https://a.invalid/","relayHostId":"b"});
        let mut claims = NotificationClaims::default();
        let now = Instant::now();
        assert!(claims.claim(notification_claim_key(&payload, &a), now));
        assert!(!claims.claim(
            notification_claim_key(&payload, &rotated),
            now + Duration::from_secs(4)
        ));
        assert!(claims.claim(notification_claim_key(&payload, &b), now));
        assert!(claims.claim(notification_claim_key(&payload, &a), now + NOTIFICATION_TTL));
        assert!(!notification_claim_key(&payload, &a).contains("secret-a"));
    }
}
