//! Validation and lossless field mapping for the native-only legacy handoff.
//! Diagnostic strings deliberately omit values, cookie names and site URLs.
use serde_json::{Value, json};
use std::collections::HashMap;
pub const PROTOCOL: &str = "varin-legacy-migration";
pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub const RECOVERY_KEY: &str = "varin.desktopMigration.nativeRecovery.v1";
pub const CREDENTIAL_KEYS: [&str; 3] = ["openaiApiKey", "openaiCompatibleApiKey", "sttApiKey"];

pub const TRANSITION_REQUIRED: &str = "varin:legacy-transition-required";
/// Read metadata only. A new CEF profile under cef/ is never mistaken for the
/// original Electron default/session profile. Unknown access is not absence.
pub fn legacy_profile_present(root: &std::path::Path) -> Result<bool, String> {
    for marker in [
        "Local Storage",
        "IndexedDB",
        "Service Worker",
        "Network/Cookies",
        "Cookies",
        "Partitions/varin-browser",
    ] {
        match std::fs::symlink_metadata(root.join(marker)) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Previous desktop profile presence could not be verified".into()),
        }
    }
    Ok(false)
}
pub fn transition_required(receipt: &Value, present: bool) -> bool {
    !receipt["pendingCookies"].is_null()
        || present
            && !(receipt["schema"] == 1
                && receipt["protocol"] == 1
                && receipt["attemptComplete"] == true
                && receipt["sourceRetained"] == true)
}
pub fn credential_slot(slot: &str) -> bool {
    CREDENTIAL_KEYS.contains(&slot)
        || slot
            .strip_prefix("config-store.state.")
            .is_some_and(|key| CREDENTIAL_KEYS.contains(&key))
}
pub fn credential_change(
    slot: &str,
    value: &str,
    target: &HashMap<String, String>,
    staged_config: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    if value.is_empty() {
        return Err("Legacy credential is empty".into());
    }
    if CREDENTIAL_KEYS.contains(&slot) {
        return Ok(if target.contains_key(slot) {
            None
        } else {
            Some((slot.into(), value.into()))
        });
    }
    let key = slot
        .strip_prefix("config-store.state.")
        .filter(|key| CREDENTIAL_KEYS.contains(key))
        .ok_or("Legacy credential slot is not allowed")?;
    let mut config: Value = match target
        .get("config-store")
        .map(String::as_str)
        .or(staged_config)
    {
        Some(raw) => {
            serde_json::from_str(raw).map_err(|_| "Target credential preferences are malformed")?
        }
        None => json!({"state":{},"version":0}),
    };
    let state = config
        .get_mut("state")
        .and_then(Value::as_object_mut)
        .ok_or("Target credential preference fields are malformed")?;
    if state.contains_key(key) {
        return Ok(None);
    }
    state.insert(key.into(), json!(value));
    Ok(Some((
        "config-store".into(),
        serde_json::to_string(&config)
            .map_err(|_| "Target credential preferences could not be encoded")?,
    )))
}
pub fn storage_entries(value: &Value) -> Result<HashMap<String, String>, String> {
    let entries = value
        .as_array()
        .ok_or("Native local storage inventory is invalid")?;
    let mut result = HashMap::new();
    for entry in entries {
        let pair = entry
            .as_array()
            .filter(|v| v.len() == 2)
            .ok_or("Native local storage item is invalid")?;
        let key = pair[0]
            .as_str()
            .ok_or("Native local storage key is invalid")?;
        let value = pair[1]
            .as_str()
            .ok_or("Native local storage value is invalid")?;
        if result.insert(key.into(), value.into()).is_some() {
            return Err("Native local storage key is duplicated".into());
        }
    }
    Ok(result)
}
pub fn site_origin(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "Legacy site origin is invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.origin().ascii_serialization() != raw
    {
        return Err("Legacy site origin is not a canonical HTTP origin".into());
    }
    if matches!(
        url.host_str(),
        Some("tauri.localhost" | "varin-ui.localhost" | "varin-companion.localhost")
    ) {
        return Err("Application origins are not BrowserUse migration targets".into());
    }
    Ok(url)
}
fn text<'a>(cookie: &'a Value, key: &str) -> Result<&'a str, String> {
    cookie[key]
        .as_str()
        .ok_or("Legacy cookie text is invalid".into())
}
pub fn cookie_identity(cookie: &Value) -> Result<Value, String> {
    let domain = text(cookie, "domain")?;
    let name = text(cookie, "name")?;
    let path = text(cookie, "path")?;
    if domain.is_empty() || !path.starts_with('/') || domain.contains(['/', '@', '\\', '\0']) {
        return Err("Legacy cookie scope is invalid".into());
    }
    // URL parsing validates DNS, bracketed IPv6 and prevents port/path injection.
    let parsed = url::Url::parse(&format!("https://{}/", domain.trim_start_matches('.')))
        .map_err(|_| "Legacy cookie host is invalid")?;
    if parsed.port().is_some() || parsed.host_str() != Some(domain.trim_start_matches('.')) {
        return Err("Legacy cookie host is not canonical".into());
    }
    let mut identity = json!({"domain":domain,"name":name,"path":path});
    if let Some(partition) = cookie.get("partitionKey") {
        let site = partition["topLevelSite"]
            .as_str()
            .ok_or("Legacy cookie partition site is invalid")?;
        site_origin(site)?;
        let ancestor = partition["hasCrossSiteAncestor"]
            .as_bool()
            .ok_or("Legacy cookie partition context is invalid")?;
        identity["partitionKey"] = json!({"topLevelSite":site,"hasCrossSiteAncestor":ancestor});
    }
    if cookie["partitionKeyOpaque"] == true {
        identity["opaque"] = json!(true)
    }
    Ok(identity)
}
pub fn cookie_parameters(cookie: &Value) -> Result<Option<Value>, String> {
    let identity = cookie_identity(cookie)?;
    if identity["opaque"] == true {
        return Ok(None);
    }
    let domain = text(cookie, "domain")?;
    let secure = cookie["secure"]
        .as_bool()
        .ok_or("Legacy cookie secure flag is invalid")?;
    let http_only = cookie["httpOnly"]
        .as_bool()
        .ok_or("Legacy cookie HTTP-only flag is invalid")?;
    let session = cookie["session"]
        .as_bool()
        .ok_or("Legacy cookie persistence is invalid")?;
    let source_scheme = text(cookie, "sourceScheme")?;
    if !matches!(source_scheme, "Unset" | "NonSecure" | "Secure") {
        return Err("Legacy cookie source scheme is invalid".into());
    }
    let port = cookie["sourcePort"]
        .as_i64()
        .filter(|v| *v == -1 || (1..=65535).contains(v))
        .ok_or("Legacy cookie source port is invalid")?;
    let scheme = if secure || source_scheme == "Secure" {
        "https"
    } else {
        "http"
    };
    let mut url = url::Url::parse(&format!("{scheme}://{}/", domain.trim_start_matches('.')))
        .map_err(|_| "Legacy cookie host is invalid")?;
    if port > 0 {
        url.set_port(Some(port as u16))
            .map_err(|_| "Legacy cookie port is invalid")?;
    }
    let mut out = json!({"url":url.as_str(),"name":text(cookie,"name")?,"value":text(cookie,"value")?,"path":text(cookie,"path")?,"secure":secure,"httpOnly":http_only,"sourceScheme":source_scheme,"sourcePort":port});
    // Supplying domain for a host-only cookie would broaden its authority.
    if domain.starts_with('.') {
        out["domain"] = json!(domain);
    }
    if !session {
        let expires = cookie["expires"]
            .as_f64()
            .filter(|x| x.is_finite() && *x >= 0.)
            .ok_or("Legacy cookie expiry is invalid")?;
        out["expires"] = json!(expires);
    }
    if let Some(same_site) = cookie.get("sameSite") {
        if !matches!(same_site.as_str(), Some("Strict" | "Lax" | "None")) {
            return Err("Legacy cookie SameSite is invalid".into());
        }
        out["sameSite"] = same_site.clone();
    }
    let priority = text(cookie, "priority")?;
    if !matches!(priority, "Low" | "Medium" | "High") {
        return Err("Legacy cookie priority is invalid".into());
    }
    out["priority"] = json!(priority);
    if let Some(partition) = identity.get("partitionKey") {
        out["partitionKey"] = partition.clone();
    }
    Ok(Some(out))
}
/// A representation change could broaden host/partition scope. Never write a
/// missing cookie when a different target authority with this name/path exists.
pub fn cookie_scope_related(left: &Value, right: &Value) -> bool {
    left["name"] == right["name"]
        && left["path"] == right["path"]
        && left["domain"]
            .as_str()
            .zip(right["domain"].as_str())
            .is_some_and(|(a, b)| a.trim_start_matches('.') == b.trim_start_matches('.'))
}
pub fn cookie_matches(source: &Value, target: &Value) -> bool {
    if cookie_identity(source).ok() != cookie_identity(target).ok() {
        return false;
    }
    for key in [
        "value",
        "secure",
        "httpOnly",
        "session",
        "sameSite",
        "priority",
        "sourceScheme",
        "sourcePort",
    ] {
        if source.get(key) != target.get(key) {
            return false;
        }
    }
    if source["session"] != true {
        let Some(a) = source["expires"].as_f64() else {
            return false;
        };
        let Some(b) = target["expires"].as_f64() else {
            return false;
        };
        if (a - b).abs() > 0.000001 {
            return false;
        }
    }
    true
}
pub fn safe_recovery(receipt: &Value) -> Value {
    let credentials = receipt["credentials"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter(|v| !matches!(v["status"].as_str(), Some("imported" | "retained")))
                .filter_map(|v| v["slot"].as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let sites = receipt["origins"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|v| v["origin"].as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cookies_pending = receipt["cookies"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter(|v| !matches!(v["status"].as_str(), Some("imported" | "retained")))
                .count()
        })
        .unwrap_or_default();
    let failures = receipt["companionFailures"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(json!({"id":item["id"].as_str()?,"reason":item["reason"].as_str()?}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"schema":1,"cookiesPending":cookies_pending,"credentialSlotsPending":credentials,"browserSourceUnavailable":receipt["browserStatus"]=="source-unavailable","companionFailures":failures,"browserSites":sites,"siteStorageInventory":"cookies-and-saved-browser-pages","indexedDb":"requires-site-recovery","serviceWorkers":"requires-site-recovery","sourceRetained":true})
}
#[cfg(test)]
mod tests {
    use super::*;
    fn cookie() -> Value {
        json!({"name":"fixture","value":"synthetic-cookie","domain":"accounts.example.test","path":"/","secure":true,"httpOnly":true,"session":false,"expires":2000000000.5,"sameSite":"None","priority":"High","sourceScheme":"Secure","sourcePort":443,"partitionKey":{"topLevelSite":"https://example.test","hasCrossSiteAncestor":true}})
    }
    #[test]
    fn later_single_engine_requires_transition_only_for_unhandled_old_data() {
        assert!(!transition_required(&json!({}), false));
        assert!(transition_required(&json!({}), true));
        assert!(!transition_required(
            &json!({"schema":1,"protocol":1,"attemptComplete":true,"sourceRetained":true,"cookiesComplete":false}),
            true
        ));
        assert!(transition_required(
            &json!({"schema":1,"protocol":1,"attemptComplete":true,"sourceRetained":true,"pendingCookies":{"schema":1,"scopes":[]}}),
            false
        ));
    }
    #[test]
    fn new_cef_profiles_do_not_look_like_legacy_electron_storage() {
        let root = std::env::temp_dir().join(format!(
            "varin-profile-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("cef/browser/Local Storage")).unwrap();
        assert!(!legacy_profile_present(&root).unwrap());
        std::fs::create_dir_all(root.join("Partitions/varin-browser")).unwrap();
        assert!(legacy_profile_present(&root).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cookie_mapping_keeps_host_only_partition_http_only_and_expiry() {
        let original = cookie();
        let mapped = cookie_parameters(&original).unwrap().unwrap();
        assert!(mapped.get("domain").is_none());
        assert_eq!(mapped["partitionKey"], original["partitionKey"]);
        assert_eq!(mapped["httpOnly"], true);
        assert_eq!(mapped["expires"], 2000000000.5);
        assert_eq!(mapped["sameSite"], "None");
        assert!(cookie_matches(&original, &original));
        let mut weakened = original.clone();
        weakened["domain"] = json!(".accounts.example.test");
        assert!(!cookie_matches(&original, &weakened));
    }
    #[test]
    fn opaque_partitions_never_silently_become_unpartitioned() {
        let mut original = cookie();
        original["partitionKeyOpaque"] = json!(true);
        assert!(cookie_parameters(&original).unwrap().is_none());
    }
    #[test]
    fn secret_fields_merge_with_staged_ui_only_when_absent() {
        let mut target = HashMap::new();
        let initial = r#"{"state":{"voiceProvider":"openai"},"version":1}"#;
        let update = credential_change(
            "config-store.state.openaiApiKey",
            "synthetic-key",
            &target,
            Some(initial),
        )
        .unwrap()
        .unwrap();
        let config: Value = serde_json::from_str(&update.1).unwrap();
        assert_eq!(config["state"]["voiceProvider"], "openai");
        assert_eq!(config["state"]["openaiApiKey"], "synthetic-key");
        target.insert(update.0, update.1);
        assert!(
            credential_change("config-store.state.openaiApiKey", "other", &target, None)
                .unwrap()
                .is_none()
        );
        assert!(credential_change("arbitrary-secret", "value", &target, None).is_err());
    }
    #[test]
    fn ipv6_host_only_cookie_is_canonical_and_neighbor_scope_is_guarded() {
        let mut original = cookie();
        original["domain"] = json!("[::1]");
        assert_eq!(
            cookie_parameters(&original).unwrap().unwrap()["url"],
            "https://[::1]/"
        );
        original["domain"] = json!("example.test:443");
        assert!(cookie_identity(&original).is_err());
        let original = cookie();
        let mut neighbor = original.clone();
        neighbor["domain"] = json!(".accounts.example.test");
        neighbor.as_object_mut().unwrap().remove("partitionKey");
        assert!(cookie_scope_related(&original, &neighbor));
        assert_ne!(cookie_identity(&original), cookie_identity(&neighbor));
    }
    #[test]
    fn recovery_never_contains_secret_values() {
        let receipt = json!({"credentials":[{"slot":"openaiApiKey","status":"imported","value":"never-copy"}],"origins":[{"origin":"https://example.test","localStorage":[["token","never-copy"]]}]});
        assert!(!safe_recovery(&receipt).to_string().contains("never-copy"));
    }
}
