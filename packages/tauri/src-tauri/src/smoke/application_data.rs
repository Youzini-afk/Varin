//! Admission/readback of only the real-owner, synthetic installer fixture.
//! No production profile or arbitrary input is admitted by this acceptance path.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const FILE: &str = "application-data-fixture.json";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fixture {
    schema: u8,
    product: String,
    nonce: String,
    source_sha: String,
    version: String,
    complete: bool,
    owner_stopped: bool,
    identity: Identity,
    head: String,
    history_sha256: String,
    run_id: String,
    project: Project,
    channel_id: String,
    model_id: String,
    credential_reference: String,
    credential_account: String,
    credential_generation: u64,
    install_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    runtime: String,
    thread_id: String,
    branch_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Project {
    id: String,
    path: String,
    label: String,
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn read(data: &Path, nonce: &str, expected_digest: &str) -> Result<Fixture, String> {
    let fail = || {
        "Original synthetic application-data fixture is unavailable, redirected or incompatible"
            .to_owned()
    };
    if uuid::Uuid::parse_str(nonce).is_err() || !hex(expected_digest, 64) {
        return Err(fail());
    }
    let file = data.join(FILE);
    let stat = fs::symlink_metadata(&file).map_err(|_| fail())?;
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 16384 {
        return Err(fail());
    }
    let bytes = fs::read(file).map_err(|_| fail())?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected_digest {
        return Err(fail());
    }
    let fixture: Fixture = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let id = |value: &str, prefix: &str| value.strip_prefix(prefix).is_some_and(|v| hex(v, 64));
    if fixture.schema != 1
        || fixture.product != "varin-installed-application-data"
        || fixture.nonce != nonce
        || !hex(&fixture.source_sha, 40)
        || fixture.version != env!("CARGO_PKG_VERSION")
        || !fixture.complete
        || !fixture.owner_stopped
        || fixture.identity.runtime != "agent"
        || !id(&fixture.identity.thread_id, "thread:")
        || !id(&fixture.identity.branch_id, "branch:")
        || fixture.head.is_empty()
        || fixture.run_id.is_empty()
        || !hex(&fixture.history_sha256, 64)
        || fixture.project.id != format!("installer_{}", nonce.replace('-', ""))
        || fixture.project.label != "Installer preservation fixture"
        || fixture.channel_id != "installer-preservation"
        || fixture.model_id != "installer-model"
        || fixture.credential_reference != "installer-preservation"
        || uuid::Uuid::parse_str(&fixture.credential_account).is_err()
        || fixture.credential_generation != 1
        || uuid::Uuid::parse_str(&fixture.install_id).is_err()
    {
        return Err(fail());
    }
    let workspace = data.parent().ok_or_else(fail)?.join("workspace");
    let stat = fs::symlink_metadata(&workspace).map_err(|_| fail())?;
    if !stat.is_dir()
        || stat.file_type().is_symlink()
        || workspace.canonicalize().map_err(|_| fail())? != workspace
        || Path::new(&fixture.project.path)
            .canonicalize()
            .map_err(|_| fail())?
            != workspace
    {
        return Err(fail());
    }
    Ok(fixture)
}

#[cfg(feature = "desktop")]
pub async fn observe(
    main: &crate::cdp::Session,
    fixture: &Fixture,
) -> Result<serde_json::Value, String> {
    use serde_json::json;
    // This script can only inspect its already authenticated, local installed
    // Host. Values remain inside the synthetic page; only booleans are returned.
    let source = include_str!("application-data.js");
    let expression = format!(
        "({source})({})",
        serde_json::to_string(fixture).map_err(|_| "Synthetic fixture could not be encoded")?
    );
    let result = main
        .request(
            "Runtime.evaluate",
            json!({"expression":expression,"awaitPromise":true,"returnByValue":true}),
        )
        .await?;
    let value = &result["result"]["value"];
    if result.get("exceptionDetails").is_some()
        || value["chatHistoryPreserved"] != true
        || value["completedRunPreserved"] != true
        || value["projectRegistrationPreserved"] != true
        || value["hostSettingsPreserved"] != true
        || value["modelCredentialBindingPreserved"] != true
    {
        return Err("Installed Host did not reopen the original synthetic chat, project, settings and credential binding".into());
    }
    Ok(value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn seeded_admission_requires_original_nonce_bytes_owner_stop_and_private_project() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let workspace = root.path().join("workspace");
        fs::create_dir(&data).unwrap();
        fs::create_dir(&workspace).unwrap();
        // macOS /tmp and Windows temporary paths may contain OS-level aliases.
        let data = data.canonicalize().unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let nonce = uuid::Uuid::new_v4().to_string();
        let base = json!({"schema":1,"product":"varin-installed-application-data","nonce":nonce,"sourceSha":"a".repeat(40),"version":env!("CARGO_PKG_VERSION"),"complete":true,"ownerStopped":true,
            "identity":{"runtime":"agent","threadId":format!("thread:{}","b".repeat(64)),"branchId":format!("branch:{}","b".repeat(64))},"head":"original-head","historySha256":"c".repeat(64),"runId":"original-run",
            "project":{"id":format!("installer_{}",nonce.replace('-',"")),"path":workspace,"label":"Installer preservation fixture"},"channelId":"installer-preservation","modelId":"installer-model","credentialReference":"installer-preservation",
            "credentialAccount":uuid::Uuid::new_v4().to_string(),"credentialGeneration":1,"installId":uuid::Uuid::new_v4().to_string()});
        let publish = |value: &serde_json::Value| {
            let bytes = serde_json::to_vec(value).unwrap();
            fs::write(data.join(FILE), &bytes).unwrap();
            format!("{:x}", Sha256::digest(&bytes))
        };
        let digest = publish(&base);
        assert!(read(&data, &nonce, &digest).is_ok());
        assert!(read(&data, &uuid::Uuid::new_v4().to_string(), &digest).is_err());
        assert!(read(&data, &nonce, &"0".repeat(64)).is_err());
        for field in ["complete", "ownerStopped"] {
            let mut bad = base.clone();
            bad[field] = json!(false);
            let digest = publish(&bad);
            assert!(read(&data, &nonce, &digest).is_err());
        }
        let mut bad = base.clone();
        bad["secret"] = json!("not-permitted");
        let digest = publish(&bad);
        assert!(read(&data, &nonce, &digest).is_err());
        let mut bad = base.clone();
        bad["project"]["path"] = json!(data);
        let digest = publish(&bad);
        assert!(read(&data, &nonce, &digest).is_err());
    }
}
