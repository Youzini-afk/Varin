//! Readback of the fixed synthetic installer fixture through the real native
//! storage owners. No arbitrary origin, key, script or profile is accepted.
use super::{HiddenPage, Reply, data};
use crate::cdp::Session;
use serde_json::{Value, json};
use std::{fs, path::Path};
use tauri::{AppHandle, Manager};

const ORIGIN: &str = "https://migration-fixture.invalid";

pub(super) fn verify_source(app: &AppHandle, data_dir: &Path) -> Result<(), String> {
    if !crate::smoke::requested() {
        return Ok(());
    }
    let marker: Value = serde_json::from_slice(
        &fs::read(data_dir.join("smoke-request.json")).map_err(|_| "Smoke marker is unavailable")?,
    ).map_err(|_| "Smoke marker is invalid")?;
    let Some(nonce) = marker.get("legacyFixtureNonce") else { return Ok(()); };
    if marker["disposableOsUser"] != true
        || nonce.as_str().is_none_or(|v| uuid::Uuid::parse_str(v).is_err())
        || std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true")
        || std::env::var("RUNNER_ENVIRONMENT").as_deref() != Ok("github-hosted") {
        return Err("Legacy fixture requires a disposable GitHub-hosted OS user".into());
    }
    // This is the actual OS config directory, not a guessed HOME override.
    let profile = app.path().config_dir().map_err(|_| "Native legacy profile directory is unavailable")?.join("Varin");
    let stat = fs::symlink_metadata(&profile).map_err(|_| "Synthetic legacy profile is missing")?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Err("Synthetic legacy profile must be a real directory".into());
    }
    let file = profile.join("varin-installer-fixture.json");
    let stat = fs::symlink_metadata(&file).map_err(|_| "Refusing a profile not created by the installer fixture")?;
    if !stat.is_file() || stat.len() > 1024 {
        return Err("Synthetic profile marker is not a bounded regular file".into());
    }
    let source: Value = serde_json::from_slice(&fs::read(file).map_err(|_| "Synthetic profile marker cannot be read")?)
        .map_err(|_| "Synthetic profile marker is malformed")?;
    if source["schema"] != 1 || source["product"] != "varin-legacy-smoke-profile" || source["nonce"] != *nonce {
        return Err("Legacy profile does not belong to this smoke invocation".into());
    }
    Ok(())
}

pub(crate) async fn observe(app: &AppHandle, data_dir: &Path, main: &Session, receipt: &Value, nonce: &str) -> Reply {
    verify_source(app, data_dir)?;
    if receipt["attemptComplete"] != true || receipt["sourceRetained"] != true || receipt["browserStatus"] != "available" {
        return Err("The original private exporter did not complete the fixture migration".into());
    }
    let credentials = receipt["credentials"].as_array().ok_or("Original credential acknowledgements are missing")?;
    if credentials.len() != 6 || credentials.iter().any(|v| v["status"] != "imported" && v["status"] != "retained") {
        return Err("The six synthetic legacy slots were not acknowledged by the target owner".into());
    }
    let value = main.request("DOMStorage.getDOMStorageItems", json!({"storageId":{"securityOrigin":"http://tauri.localhost","isLocalStorage":true}})).await?;
    let entries = data::storage_entries(&value["entries"])?;
    if entries.get("varin.editor-workbench.owner").map(String::as_str) != Some(nonce) {
        return Err("The real frontend bootstrap did not preserve the synthetic document owner".into());
    }
    let config: Value = serde_json::from_str(entries.get("config-store").ok_or("Migrated frontend config is absent")?)
        .map_err(|_| "Migrated frontend config is malformed")?;
    if config["state"]["speechRate"] != 1.25 {
        return Err("Frontend preferences and private credentials did not merge".into());
    }
    for key in ["openaiApiKey", "openaiCompatibleApiKey", "sttApiKey"] {
        if entries.get(key) != Some(&format!("fixture-only:{nonce}:{key}"))
            || config["state"][key] != format!("fixture-only:{nonce}:config.{key}") {
            return Err("Native target credential readback differs from the synthetic source".into());
        }
    }
    let mut browser = HiddenPage::open(app, data_dir, false).await?;
    let observation: Reply = async {
        browser.offline().await?;
        browser.origin(ORIGIN).await?;
        let site = browser.cdp.entries(ORIGIN).await?;
        if site.get("varin-installer-fixture").map(String::as_str) != Some(nonce) {
            return Err("The original BrowserUse localStorage was not retained by the target".into());
        }
        let all = browser.cdp.request("Storage.getCookies", json!({})).await?;
        let cookies = all["cookies"].as_array().ok_or("Native cookie readback is invalid")?;
        let matching: Vec<_> = cookies.iter().filter(|v| v["name"] == "varin_installer_fixture" && v["domain"] == "migration-fixture.invalid").collect();
        if matching.len() != 1 || matching[0]["value"] != format!("fixture-only:{nonce}:cookie")
            || matching[0]["path"] != "/" || matching[0]["secure"] != true
            || matching[0]["httpOnly"] != true || matching[0]["sameSite"] != "Lax"
            || matching[0]["session"] != false {
            return Err("Native target cookie readback differs from the synthetic source".into());
        }
        Ok(json!({"source":"real-packaged-private-electron-exporter","fixture":"synthetic-native-profile",
            "frontendOwnerPreserved":true,"preferenceMerged":true,"credentialSlotsVerified":6,
            "browserCookieVerified":true,"browserLocalStorageVerified":true,"valuesDisclosed":false}))
    }.await;
    // A read failure still releases the original native page. Unknown close
    // outcomes fail the whole launch; the driver must retain its private data.
    browser.close().await?;
    observation
}
