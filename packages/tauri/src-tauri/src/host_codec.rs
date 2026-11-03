//! Private desktop framing. Bulk JSON is interleavable, bounded, and never replayed.
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

pub const PROTOCOL: &str = "varin-desktop-host";
pub const CHUNK_BYTES: usize = 64 * 1024;
pub const MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const LINE_BYTES: usize = 1024 * 1024;
pub const MAX_ASSEMBLIES: usize = 64;
const JS_MAX_INTEGER: u64 = 9_007_199_254_740_991;
const INVALID: &str = "Invalid managed desktop control stream";

pub struct DecodedFrame {
    pub value: Value,
    pub bytes: usize,
}
struct Assembly {
    sequence: u64,
    total: usize,
    received: usize,
    parts: Vec<String>,
}
pub struct Decoder {
    sender: &'static str,
    assemblies: HashMap<String, Assembly>,
    reserved: usize,
    latest: u64,
}
pub fn valid_id(id: &str, sender: &str) -> bool {
    id.strip_prefix(sender)
        .and_then(|s| s.strip_prefix(':'))
        .is_some_and(|tail| {
            !tail.is_empty()
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}
fn valid_frame(frame: &Value) -> bool {
    if frame["protocol"] != PROTOCOL || frame["version"] != 1 {
        return false;
    }
    match frame["kind"].as_str() {
        Some("event") => frame["event"].is_string(),
        Some("request" | "response") => {
            if !frame["id"]
                .as_str()
                .is_some_and(|id| valid_id(id, "host") || valid_id(id, "shell"))
            {
                return false;
            }
            if frame["kind"] == "request" {
                frame["method"].is_string()
            } else {
                frame["ok"].as_bool().is_some_and(|ok| {
                    ok || frame["error"]["code"].is_string()
                        && frame["error"]["message"].is_string()
                })
            }
        }
        _ => false,
    }
}
impl Decoder {
    pub fn new(sender: &'static str) -> Self {
        Self {
            sender,
            assemblies: HashMap::new(),
            reserved: 0,
            latest: 0,
        }
    }
    pub fn clear(&mut self) {
        self.assemblies.clear();
        self.reserved = 0;
    }
    pub fn finish(&mut self) -> Result<(), String> {
        if self.assemblies.is_empty() {
            Ok(())
        } else {
            self.clear();
            Err(INVALID.into())
        }
    }
    pub fn line(&mut self, line: &[u8]) -> Result<Option<DecodedFrame>, String> {
        let result = self.decode(line);
        if result.is_err() {
            self.clear();
        }
        result
    }
    fn decode(&mut self, line: &[u8]) -> Result<Option<DecodedFrame>, String> {
        if line.len() > LINE_BYTES {
            return Err(INVALID.into());
        }
        let frame: Value = serde_json::from_slice(line).map_err(|_| INVALID)?;
        if valid_frame(&frame) {
            return Ok(Some(DecodedFrame {
                value: frame,
                bytes: line.len(),
            }));
        }
        if frame["protocol"] != PROTOCOL || frame["version"] != 1 || frame["kind"] != "chunk" {
            return Err(INVALID.into());
        }
        let id = frame["id"].as_str().ok_or(INVALID)?;
        let digits = id
            .strip_prefix(&format!("{}:chunk", self.sender))
            .ok_or(INVALID)?;
        if digits.is_empty()
            || digits.starts_with('0')
            || !digits.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(INVALID.into());
        }
        let serial: u64 = digits.parse().map_err(|_| INVALID)?;
        if serial > JS_MAX_INTEGER {
            return Err(INVALID.into());
        }
        let sequence = frame["sequence"]
            .as_u64()
            .filter(|s| *s <= JS_MAX_INTEGER)
            .ok_or(INVALID)?;
        let total = frame["totalBytes"]
            .as_u64()
            .filter(|t| *t > CHUNK_BYTES as u64 && *t <= MESSAGE_BYTES as u64)
            .ok_or(INVALID)? as usize;
        let final_chunk = frame["final"].as_bool().ok_or(INVALID)?;
        let data = frame["data"].as_str().ok_or(INVALID)?;
        if data.is_empty() || data.len() > CHUNK_BYTES {
            return Err(INVALID.into());
        }
        if !self.assemblies.contains_key(id) {
            if sequence != 0
                || serial <= self.latest
                || self.assemblies.len() >= MAX_ASSEMBLIES
                || self.reserved + total > MESSAGE_BYTES
            {
                return Err(INVALID.into());
            }
            self.latest = serial;
            self.reserved += total;
            self.assemblies.insert(
                id.to_owned(),
                Assembly {
                    sequence: 0,
                    total,
                    received: 0,
                    parts: Vec::new(),
                },
            );
        }
        let assembly = self.assemblies.get_mut(id).unwrap();
        if sequence != assembly.sequence || total != assembly.total {
            return Err(INVALID.into());
        }
        assembly.sequence += 1;
        assembly.received += data.len();
        if assembly.received > total || final_chunk != (assembly.received == total) {
            return Err(INVALID.into());
        }
        assembly.parts.push(data.to_owned());
        if !final_chunk {
            return Ok(None);
        }
        let assembly = self.assemblies.remove(id).unwrap();
        self.reserved -= total;
        let mut bytes = String::with_capacity(total);
        for part in assembly.parts {
            bytes.push_str(&part);
        }
        let value: Value = serde_json::from_str(&bytes).map_err(|_| INVALID)?;
        if !valid_frame(&value) {
            return Err(INVALID.into());
        }
        Ok(Some(DecodedFrame {
            value,
            bytes: total,
        }))
    }
}

pub struct Outgoing<T> {
    bytes: String,
    id: String,
    offset: usize,
    sequence: u64,
    pub context: T,
}
impl<T> Outgoing<T> {
    pub fn new(value: &Value, sender: &str, sequence: u64, context: T) -> Result<Self, String> {
        let bytes = serde_json::to_string(value)
            .map_err(|_| "Desktop control message could not be encoded")?;
        if bytes.len() > MESSAGE_BYTES {
            return Err("Desktop control message exceeds its memory budget".into());
        }
        Ok(Self::from_encoded(bytes, sender, sequence, context))
    }
    pub fn from_encoded(bytes: String, sender: &str, sequence: u64, context: T) -> Self {
        Self {
            bytes,
            id: format!("{sender}:chunk{sequence}"),
            offset: 0,
            sequence: 0,
            context,
        }
    }
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_small(&self) -> bool {
        self.bytes.len() <= CHUNK_BYTES
    }
    pub fn next_line(&mut self) -> (Vec<u8>, bool) {
        if self.is_small() {
            let mut bytes = self.bytes.as_bytes().to_vec();
            bytes.push(b'\n');
            return (bytes, true);
        }
        let mut end = (self.offset + CHUNK_BYTES).min(self.bytes.len());
        while !self.bytes.is_char_boundary(end) {
            end -= 1;
        }
        let final_chunk = end == self.bytes.len();
        let frame = json!({"protocol":PROTOCOL,"version":1,"kind":"chunk","id":self.id,
            "sequence":self.sequence,"totalBytes":self.bytes.len(),"final":final_chunk,"data":&self.bytes[self.offset..end]});
        self.offset = end;
        self.sequence += 1;
        let mut line =
            serde_json::to_vec(&frame).expect("a frame of checked strings can be encoded");
        line.push(b'\n');
        (line, final_chunk)
    }
}
/// One chunk per turn. Small control messages pass queued bulk messages.
pub fn next_outgoing<T>(queue: &mut VecDeque<Outgoing<T>>) -> Option<Outgoing<T>> {
    let index = queue.iter().position(Outgoing::is_small).unwrap_or(0);
    queue.remove(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(id: &str) -> Value {
        json!({"protocol":PROTOCOL,"version":1,"kind":"response","id":id,"ok":true,"result":"😀中文".repeat(20000)})
    }
    fn lines(value: Value) -> Vec<Vec<u8>> {
        let mut frame = Outgoing::new(&value, "host", 1, ()).unwrap();
        let mut lines = Vec::new();
        loop {
            let (line, last) = frame.next_line();
            lines.push(line);
            if last {
                return lines;
            }
        }
    }
    #[test]
    fn unicode_roundtrip_and_strict_completion() {
        let source = message("shell:1");
        let encoded = lines(source.clone());
        let mut decoder = Decoder::new("host");
        let mut result = None;
        for line in encoded {
            assert!(line.len() < LINE_BYTES);
            result = decoder.line(&line).unwrap().or(result);
        }
        assert_eq!(result.unwrap().value, source);
        assert!(decoder.finish().is_ok());
    }
    #[test]
    fn interleaving_preserves_each_transfer_and_prioritizes_controls() {
        let mut queue = VecDeque::new();
        queue.push_back(Outgoing::new(&message("shell:1"), "host", 1, ()).unwrap());
        let (first, _) = queue.front_mut().unwrap().next_line();
        let mut decoder = Decoder::new("host");
        decoder.line(&first).unwrap();
        queue.push_back(Outgoing::new(&message("shell:2"), "host", 2, ()).unwrap());
        let control = json!({"protocol":PROTOCOL,"version":1,"kind":"event","event":"stopping","payload":null});
        queue.push_back(Outgoing::new(&control, "host", 3, ()).unwrap());
        let mut replies = Vec::new();
        while let Some(mut frame) = next_outgoing(&mut queue) {
            let (line, last) = frame.next_line();
            if let Some(value) = decoder.line(&line).unwrap() {
                replies.push(value.value);
            }
            if !last {
                queue.push_back(frame);
            }
        }
        assert_eq!(replies[0], control);
        assert_eq!(replies.len(), 3);
        assert!(decoder.finish().is_ok());
    }
    #[test]
    fn rejects_duplicate_order_direction_lengths_and_partial_eof() {
        let encoded = lines(message("shell:1"));
        let first = &encoded[0];
        let mut decoder = Decoder::new("host");
        decoder.line(first).unwrap();
        assert!(decoder.line(first).is_err());
        assert!(decoder.finish().is_ok());
        let mut decoder = Decoder::new("host");
        decoder.line(first).unwrap();
        assert!(decoder.finish().is_err());
        for (field, value) in [
            ("id", json!("shell:chunk1")),
            ("sequence", json!(1)),
            ("totalBytes", json!(MESSAGE_BYTES + 1)),
            ("final", json!(true)),
        ] {
            let mut frame: Value = serde_json::from_slice(first).unwrap();
            frame[field] = value;
            assert!(
                Decoder::new("host")
                    .line(&serde_json::to_vec(&frame).unwrap())
                    .is_err()
            );
        }
    }
    #[test]
    fn bounds_aggregate_reservations_and_wire_lines() {
        let mut first: Value = serde_json::from_slice(&lines(message("shell:1"))[0]).unwrap();
        first["totalBytes"] = json!(MESSAGE_BYTES);
        let mut decoder = Decoder::new("host");
        decoder.line(&serde_json::to_vec(&first).unwrap()).unwrap();
        first["id"] = json!("host:chunk2");
        assert!(decoder.line(&serde_json::to_vec(&first).unwrap()).is_err());
        assert!(
            Decoder::new("host")
                .line(&vec![b' '; LINE_BYTES + 1])
                .is_err()
        );
    }
}
