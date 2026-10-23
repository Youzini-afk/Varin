//! Line selection over the original byte stream, shared by live and fixed sources.
use super::*;

pub(crate) struct LineRead {
    first: u64,
    last: u64,
    line: u64,
    position: u64,
    start: Option<u64>,
    end: u64,
    last_read: Option<u64>,
    bytes: Vec<u8>,
}
impl LineRead {
    pub(crate) fn from_params(params: &Value) -> Result<Option<Self>, KernelError> {
        if params.get("startLine").is_none() && params.get("endLine").is_none() { return Ok(None); }
        let invalid = || KernelError::Operation("Use positive, inclusive startLine/endLine without a byte offset or length".into());
        let first = params["startLine"].as_u64().filter(|value| *value > 0).ok_or_else(invalid)?;
        let last = params.get("endLine").map(|value| value.as_u64().filter(|value| *value >= first).ok_or_else(invalid)).transpose()?.unwrap_or(u64::MAX);
        if params["offset"].as_u64().unwrap_or(0) != 0 || params.get("length").is_some() { return Err(invalid()); }
        Ok(Some(Self { first, last, line: 1, position: 0, start: None, end: 0, last_read: None, bytes: Vec::new() }))
    }
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<(), KernelError> {
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            if self.line >= self.first && self.line <= self.last {
                if self.bytes.len().saturating_add(part.len()) > MAX_BLOB_RESPONSE_BYTES {
                    return Err(KernelError::Operation("Requested lines exceed one response frame; request fewer lines or use a byte range".into()));
                }
                self.start.get_or_insert(self.position);
                self.bytes.extend_from_slice(part);
                self.end = self.position + part.len() as u64;
                self.last_read = Some(self.line);
            }
            self.position += part.len() as u64;
            if part.last() == Some(&b'\n') { self.line = self.line.saturating_add(1); }
        }
        Ok(())
    }
    pub(crate) fn complete(&self) -> bool { self.line > self.last }
    pub(crate) fn content(self, total: u64) -> Value {
        let offset = self.start.unwrap_or(total);
        let next = if self.start.is_some() { self.end } else { total };
        let mut value = json!({"byteLength":total,"returnedBytes":next-offset,"offset":offset,"nextOffset":next,"eof":next >= total,
            "startLine":self.first,"endLine":self.last_read,"nextLine":if next < total { self.last_read.map(|line| line + 1) } else { None }});
        match String::from_utf8(self.bytes) {
            Ok(text) if !text.contains('\0') => value["text"] = json!(text),
            Ok(text) => { value["bytesBase64"] = json!(BASE64.encode(text.as_bytes())); value["encoding"] = json!("base64"); },
            Err(error) => { value["bytesBase64"] = json!(BASE64.encode(error.into_bytes())); value["encoding"] = json!("base64"); },
        }
        value
    }
}
