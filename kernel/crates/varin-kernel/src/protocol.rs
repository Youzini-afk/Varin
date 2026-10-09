use crate::error::KernelError;
use crate::model::TrieNode;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const PROTOCOL_VERSION: u64 = 1;
pub(crate) const KERNEL_VERSION: &str = "0.1.0";
pub(crate) const KERNEL_BUILD_IDENTITY: &str = match option_env!("VARIN_KERNEL_BUILD_IDENTITY") {
    Some(value) => value,
    None => env!("CARGO_PKG_VERSION"),
};
pub(crate) const KERNEL_TARGET: &str = match option_env!("VARIN_KERNEL_TARGET") {
    Some(value) => value,
    None => "unknown-target",
};
pub(crate) const KERNEL_ARCH: &str = match option_env!("VARIN_KERNEL_ARCH") {
    Some(value) => value,
    None => "unknown-arch",
};
pub(crate) const STORAGE_FORMAT_VERSION: &str = "10";
// Control frames are deliberately bounded. Content bytes travel through the
// begin/data/finish stream and therefore do not need a giant JSON envelope.
pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_BLOB_RESPONSE_BYTES: usize = (MAX_FRAME_BYTES * 3 / 4).saturating_sub(1024);
pub(crate) const KERNEL_CAPABILITIES: [&str; 9] = [
    "storage",
    "workingState",
    "recovery",
    "fileResources",
    "materialization",
    "processResources",
    "branchCas",
    "pins",
    "gc",
];

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
pub(crate) fn hash_json(value: &Value) -> Result<String, KernelError> {
    Ok(format!(
        "sha256-{}",
        hex::encode(Sha256::digest(serde_json::to_vec(value)?))
    ))
}
pub(crate) fn node_hash(node: &TrieNode) -> String {
    let mut bytes = b"varin-trie-node-v2\0".to_vec();
    bytes.extend(serde_json::to_vec(node).unwrap_or_default());
    format!("sha256-{}", hex::encode(Sha256::digest(bytes)))
}
pub(crate) fn object_path(root: &Path, hash: &str) -> Result<PathBuf, KernelError> {
    varin_runtime::content::object_path(root, hash)
        .map_err(|_| KernelError::Operation(format!("malformed content hash: {hash}")))
}
pub(crate) fn response_ok(id: &str, result: Value) -> Value {
    json!({"v": PROTOCOL_VERSION, "kind": "response", "id": id, "ok": true, "result": result})
}

pub(crate) fn reject_unknown_fields(
    value: &Value,
    allowed: &[&str],
    context: &str,
) -> Result<(), KernelError> {
    let object = value
        .as_object()
        .ok_or_else(|| KernelError::Protocol(format!("{context} must be an object")))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.iter().any(|allowed| allowed == field))
    {
        return Err(KernelError::Protocol(format!(
            "unknown {context} field: {field}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_method_params(method: &str, params: &Value) -> Result<(), KernelError> {
    crate::protocol_generated::validate_generated_method_params(method, params)
        .map_err(|error| KernelError::Protocol(format!("invalid {method} params: {error}")))
}
pub(crate) fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    match input.read(&mut header[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => input.read_exact(&mut header[1..])?,
        Ok(_) => unreachable!("one-byte frame header read returned more than one byte"),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("kernel frame exceeds {} bytes", MAX_FRAME_BYTES),
        ));
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_reader_distinguishes_clean_eof_from_truncation() {
        assert_eq!(
            read_frame(&mut Cursor::new(Vec::<u8>::new())).unwrap(),
            None
        );
        assert_eq!(
            read_frame(&mut Cursor::new(vec![0, 0])).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut partial_payload = vec![0, 0, 0, 4, b'{', b'}'];
        assert_eq!(
            read_frame(&mut Cursor::new(&mut partial_payload))
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn generated_publish_contract_requires_both_cas_fields() {
        assert!(validate_method_params(
            "branch.publish",
            &json!({"operationId": "op", "branchId": "branch"})
        )
        .is_err());
        assert!(validate_method_params(
            "branch.publish",
            &json!({
                "operationId": "op",
                "branchId": "branch",
                "expectedWriteRevision": 3,
                "expectedRoot": "sha256-root"
            })
        )
        .is_ok());
    }
}
pub(crate) fn write_frame(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_encoded_frame(output, &payload)
}
pub(crate) fn write_encoded_frame(output: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("kernel frame exceeds {} bytes", MAX_FRAME_BYTES),
        ));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "kernel frame is too large"))?;
    output.write_all(&length.to_be_bytes())?;
    output.write_all(payload)?;
    output.flush()
}
