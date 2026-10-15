use super::{failure, ModelFailure};
/// Incremental byte framing keeps incomplete UTF-8 and CRLF pairs intact across network chunks.
pub(super) struct Decoder {
    line: Vec<u8>,
    data: String,
    cr: bool,
    limit: usize,
    first_line: bool,
}
impl Decoder {
    pub fn new(limit: usize) -> Self {
        Self {
            line: Vec::new(),
            data: String::new(),
            cr: false,
            limit,
            first_line: true,
        }
    }
    pub fn push(
        &mut self,
        bytes: &[u8],
        event: &mut dyn FnMut(&str) -> Result<bool, ModelFailure>,
    ) -> Result<bool, ModelFailure> {
        for &byte in bytes {
            if self.cr {
                self.cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                self.cr = byte == b'\r';
                let line = std::str::from_utf8(&self.line)
                    .map_err(|_| failure("invalid_sse_utf8", "invalid UTF-8 in SSE stream"))?;
                let line = if self.first_line {
                    self.first_line = false;
                    line.strip_prefix('\u{feff}').unwrap_or(line)
                } else {
                    line
                };
                if line.is_empty() {
                    if !self.data.is_empty() {
                        self.data.pop();
                        let stop = event(&self.data)?;
                        self.data.clear();
                        if stop {
                            self.line.clear();
                            return Ok(true);
                        }
                    }
                } else if let Some(value) =
                    line.strip_prefix("data:")
                        .or_else(|| if line == "data" { Some("") } else { None })
                {
                    self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                    self.data.push('\n');
                }
                self.line.clear();
            } else {
                self.line.push(byte);
            }
            if self.line.len().saturating_add(self.data.len()) > self.limit {
                return Err(failure(
                    "sse_event_budget",
                    "SSE event exceeds configured memory budget",
                ));
            }
        }
        Ok(false)
    }
}
