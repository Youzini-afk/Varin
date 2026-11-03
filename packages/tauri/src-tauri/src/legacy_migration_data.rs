//! Application credential validation for the native-only legacy handoff.
//! Browser profiles are deliberately not read, copied or deleted.
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
    for marker in ["Local Storage", "companions"] {
        match std::fs::symlink_metadata(root.join(marker)) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Previous desktop profile presence could not be verified".into()),
        }
    }
    Ok(false)
}
pub fn transition_required(receipt: &Value, present: bool) -> bool {
    present
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
    json!({"schema":1,"credentialSlotsPending":credentials,"companionFailures":failures,
        "browserStatus":"not-migrated","browserRequiresLogin":true,"sourceRetained":true})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn later_single_engine_requires_transition_only_for_unhandled_old_data() {
        assert!(!transition_required(&json!({}), false));
        assert!(transition_required(&json!({}), true));
        assert!(!transition_required(
            &json!({"schema":1,"protocol":1,"attemptComplete":true,"sourceRetained":true,"cookiesComplete":false}),
            true
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
        assert!(!legacy_profile_present(&root).unwrap());
        std::fs::create_dir_all(root.join("Local Storage")).unwrap();
        assert!(legacy_profile_present(&root).unwrap());
        std::fs::remove_dir_all(root).unwrap();
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
    fn recovery_never_contains_secret_values() {
        let receipt = json!({"credentials":[{"slot":"openaiApiKey","status":"imported","value":"never-copy"}],"origins":[{"origin":"https://example.test","localStorage":[["token","never-copy"]]}]});
        assert!(!safe_recovery(&receipt).to_string().contains("never-copy"));
    }
}
