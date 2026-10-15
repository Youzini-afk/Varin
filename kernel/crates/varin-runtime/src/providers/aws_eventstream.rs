//! AWS eventstream framing. Both CRCs are validated before any payload is admitted.
use super::*;
use std::collections::BTreeMap;
fn invalid() -> ModelFailure {
    failure("invalid_eventstream", "invalid AWS eventstream frame")
}
fn u32be(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("four bytes"))
}
const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = (crc >> 1) ^ (0xedb88320u32 & 0u32.wrapping_sub(crc & 1));
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc = (crc >> 8) ^ CRC_TABLE[((crc ^ u32::from(*byte)) & 255) as usize];
    }
    !crc
}
pub(super) struct Decoder {
    pending: Vec<u8>,
    max: usize,
}
impl Decoder {
    pub fn new(max: usize) -> Self {
        Self {
            pending: Vec::new(),
            max,
        }
    }
    pub fn finish(&self) -> Result<(), ModelFailure> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(failure(
                "stream_interrupted",
                "AWS stream ended within a frame",
            ))
        }
    }
    pub fn feed(
        &mut self,
        mut bytes: &[u8],
        receive: &mut dyn FnMut(&str, Value) -> Result<(), ModelFailure>,
    ) -> Result<(), ModelFailure> {
        while !bytes.is_empty() {
            let target = if self.pending.len() < 12 {
                12
            } else {
                u32be(&self.pending[..4]) as usize
            };
            let count = (target - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.pending.len() < 12 {
                continue;
            }
            let total = u32be(&self.pending[..4]) as usize;
            let headers_len = u32be(&self.pending[4..8]) as usize;
            if total < 16
                || headers_len > total - 16
                || crc32(&self.pending[..8]) != u32be(&self.pending[8..12])
            {
                return Err(invalid());
            }
            if total > self.max {
                return Err(failure(
                    "event_budget_exceeded",
                    "AWS event exceeds the configured memory budget",
                ));
            }
            if self.pending.len() != total {
                continue;
            }
            if crc32(&self.pending[..total - 4]) != u32be(&self.pending[total - 4..]) {
                return Err(invalid());
            }
            let headers = headers(&self.pending[12..12 + headers_len])?;
            let kind = headers.get(":message-type").ok_or_else(invalid)?;
            if kind == "exception" || kind == "error" {
                // Exception payloads may echo prompts. Keep only the known wire exception name.
                let code = headers
                    .get(":exception-type")
                    .or_else(|| headers.get(":error-code"))
                    .map(String::as_str)
                    .unwrap_or("bedrock_stream_error");
                return Err(provider_failure(
                    &serde_json::json!({"code":code}),
                    "bedrock_stream_error",
                ));
            }
            if kind != "event" {
                return Err(invalid());
            }
            let event = headers.get(":event-type").ok_or_else(invalid)?;
            if headers
                .get(":content-type")
                .is_some_and(|v| v != "application/json")
            {
                return Err(invalid());
            }
            let value = serde_json::from_slice(&self.pending[12 + headers_len..total - 4])
                .map_err(|_| invalid())?;
            receive(event, value)?;
            self.pending.clear();
        }
        Ok(())
    }
}
fn headers(mut bytes: &[u8]) -> Result<BTreeMap<String, String>, ModelFailure> {
    let mut result = BTreeMap::new();
    while !bytes.is_empty() {
        let n = bytes[0] as usize;
        bytes = &bytes[1..];
        if n == 0 || bytes.len() < n + 1 {
            return Err(invalid());
        }
        let name = std::str::from_utf8(&bytes[..n])
            .map_err(|_| invalid())?
            .to_owned();
        let ty = bytes[n];
        bytes = &bytes[n + 1..];
        let len = match ty {
            0 | 1 => 0,
            2 => 1,
            3 => 2,
            4 => 4,
            5 | 8 => 8,
            9 => 16,
            6 | 7 => {
                if bytes.len() < 2 {
                    return Err(invalid());
                }
                let n = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
                bytes = &bytes[2..];
                n
            }
            _ => return Err(invalid()),
        };
        if bytes.len() < len {
            return Err(invalid());
        }
        let value = if ty == 7 {
            std::str::from_utf8(&bytes[..len])
                .map_err(|_| invalid())?
                .to_owned()
        } else {
            if matches!(
                name.as_str(),
                ":message-type"
                    | ":event-type"
                    | ":content-type"
                    | ":exception-type"
                    | ":error-code"
            ) {
                return Err(invalid());
            }
            String::new()
        };
        if result.insert(name, value).is_some() {
            return Err(invalid());
        }
        bytes = &bytes[len..];
    }
    Ok(result)
}
