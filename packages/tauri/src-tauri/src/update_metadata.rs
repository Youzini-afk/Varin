//! Authenticated feed metadata, separate from installer OS signing. Keep its
//! canonical representation compatible with scripts/desktop-update-signatures.
use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;

fn decoded(value: &str) -> Result<String, String> {
    String::from_utf8(
        STANDARD
            .decode(value)
            .map_err(|_| "Invalid update signature encoding")?,
    )
    .map_err(|_| "Invalid update signature text".into())
}
fn canonical(value: &Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            output.push(b'{');
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            for (index, key) in keys.into_iter().enumerate() {
                if key.is_empty() || !key.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
                    return Err("Signed metadata keys must be ASCII".into());
                }
                if index > 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key).map_err(|_| "Invalid metadata key")?;
                output.push(b':');
                canonical(&map[key], output)?;
            }
            output.push(b'}');
        }
        Value::Array(items) => {
            output.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                canonical(item, output)?;
            }
            output.push(b']');
        }
        Value::Number(number) => {
            let valid = number
                .as_i64()
                .is_some_and(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))
                || number.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991);
            if !valid {
                return Err("Signed metadata numbers must be safe integers".into());
            }
            output.extend_from_slice(number.to_string().as_bytes());
        }
        _ => serde_json::to_writer(output, value).map_err(|_| "Invalid signed metadata value")?,
    }
    Ok(())
}
pub fn verify(document: &Value, public_key: &str, target: &str) -> Result<(), String> {
    let mut payload = document.clone();
    let map = payload.as_object_mut().ok_or("Invalid update metadata")?;
    let signature = map
        .remove("varinSignature")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or("Missing signed update metadata")?;
    let key = PublicKey::decode(&decoded(public_key)?)
        .map_err(|_| "Invalid installed update public key")?;
    let signature = Signature::decode(&decoded(&signature)?)
        .map_err(|_| "Invalid update metadata signature")?;
    let mut bytes = Vec::new();
    canonical(&payload, &mut bytes)?;
    bytes.push(b'\n');
    key.verify(&bytes, &signature, true)
        .map_err(|_| "Update metadata signature verification failed")?;
    let version = document["version"]
        .as_str()
        .ok_or("Missing update version")?;
    let signed: Vec<_> = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|f| f.strip_prefix("version:"))
        .collect();
    if signed != [version] {
        return Err("Signed update metadata version mismatch".into());
    }
    if document["varin"]["schema"] != 1
        || document["varin"]["product"] != "varin-tauri-desktop"
        || document["varin"]["channel"] != "stable"
    {
        return Err("Update belongs to a different product or channel".into());
    }
    let source = document["varin"]["sourceSha"].as_str().unwrap_or("");
    if source.len() != 40 || !source.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Update source identity is missing".into());
    }
    let platform = &document["platforms"][target];
    let url = url::Url::parse(
        platform["url"]
            .as_str()
            .ok_or("Update has no artifact for this architecture")?,
    )
    .map_err(|_| "Invalid update URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Updates require credential-free HTTPS artifacts".into());
    }
    let hash = platform["sha256"].as_str().unwrap_or("");
    if hash.len() != 64
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        || platform["size"].as_u64().filter(|n| *n > 0).is_none()
    {
        return Err("Update artifact identity is missing".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, String) {
        let value: Value =
            serde_json::from_str(include_str!("../testdata/update-feed.json")).unwrap();
        (
            value["feed"].clone(),
            value["publicKey"].as_str().unwrap().to_owned(),
        )
    }
    #[test]
    fn javascript_signed_metadata_verifies_in_native_owner() {
        let (feed, key) = fixture();
        verify(&feed, &key, "linux-x64").unwrap();
    }
    #[test]
    fn tampered_feed_cannot_change_source_version_target_or_destination() {
        let (feed, key) = fixture();
        for path in [
            "/version",
            "/varin/sourceSha",
            "/platforms/linux-x64/url",
            "/platforms/linux-x64/sha256",
        ] {
            let mut changed = feed.clone();
            *changed.pointer_mut(path).unwrap() = Value::String("changed".into());
            assert!(verify(&changed, &key, "linux-x64").is_err(), "{path}");
        }
        assert!(verify(&feed, &key, "linux-arm64").is_err());
    }
    #[test]
    fn missing_or_invalid_signatures_are_not_an_empty_update() {
        let (mut feed, key) = fixture();
        feed.as_object_mut().unwrap().remove("varinSignature");
        assert!(verify(&feed, &key, "linux-x64").is_err());
        let (feed, _) = fixture();
        assert!(verify(&feed, "invalid", "linux-x64").is_err());
    }
}
