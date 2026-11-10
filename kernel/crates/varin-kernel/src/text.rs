//! One file codec and serializer for Storage, Compute and the trusted Host.
//! Disk revisions always describe raw bytes; formats describe their interpretation.
use crate::error::KernelError;
use base64::{engine::general_purpose::STANDARD, Engine};
use encoding_rs::{DecoderResult, EncoderResult, Encoding, GBK, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::borrow::Cow;
pub(crate) mod stream;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Format {
    pub encoding: String,
    pub bom: bool,
    pub line_ending: String,
    pub default_line_ending: String,
    pub source: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TargetFormat {
    pub encoding: Option<String>,
    pub bom: Option<bool>,
    pub line_ending: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}
#[derive(Debug)]
pub(crate) struct Failure {
    pub kind: &'static str,
    pub message: String,
    pub encoding: Option<String>,
    pub position: Option<usize>,
    pub character: Option<String>,
}
impl Failure {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid",
            message: message.into(),
            encoding: None,
            position: None,
            character: None,
        }
    }
    pub(crate) fn value(&self) -> Value {
        json!({"kind":self.kind,"message":self.message,"encoding":self.encoding,"position":self.position,"character":self.character})
    }
    pub(crate) fn kernel(self) -> KernelError {
        KernelError::Execution(
            varin_runtime::execution::ExecutionError::new(
                if self.kind == "unrepresentable" {
                    "text_unrepresentable"
                } else {
                    "text_encoding"
                },
                &self.message,
            )
            .with_details(self.value()),
        )
    }
}
mod codecs;
pub(crate) use codecs::{canonical, codec};
use codecs::{decode_payload, registry, ByteProfile};
fn name(codec: &'static Encoding) -> String {
    codec.name().to_ascii_lowercase()
}
fn marker(codec: &Encoding) -> &'static [u8] {
    if codec == UTF_8 {
        b"\xef\xbb\xbf"
    } else if codec == UTF_16LE {
        b"\xff\xfe"
    } else if codec == UTF_16BE {
        b"\xfe\xff"
    } else {
        b""
    }
}
pub(crate) fn clearly_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(b"\xff\xfe") || bytes.starts_with(b"\xfe\xff") {
        return false;
    }
    bytes.contains(&0) || bytes.iter().any(|b| matches!(*b,1..=8|14..=26|28..=31|127))
}
#[derive(Default)]
pub(crate) struct Endings {
    crlf: u64,
    lf: u64,
    cr: u64,
    pending_cr: bool,
    first: Option<&'static str>,
}
impl Endings {
    fn record(&mut self, e: &'static str) {
        self.first.get_or_insert(e);
        match e {
            "crlf" => self.crlf += 1,
            "cr" => self.cr += 1,
            _ => self.lf += 1,
        }
    }
    pub(crate) fn push(&mut self, text: &str) {
        for &c in text.as_bytes() {
            if self.pending_cr {
                self.pending_cr = false;
                if c == b'\n' {
                    self.record("crlf");
                    continue;
                }
                self.record("cr");
            }
            if c == b'\r' {
                self.pending_cr = true;
            } else if c == b'\n' {
                self.record("lf");
            }
        }
    }
    fn finish(mut self) -> (String, String) {
        if self.pending_cr {
            self.record("cr");
        }
        let n = usize::from(self.crlf > 0) + usize::from(self.lf > 0) + usize::from(self.cr > 0);
        (
            if n == 0 {
                "none"
            } else if n > 1 {
                "mixed"
            } else {
                self.first.unwrap_or("lf")
            }
            .into(),
            self.first.unwrap_or("lf").into(),
        )
    }
}
struct Validation {
    decoder: encoding_rs::Decoder,
    profile: ByteProfile,
    valid: bool,
    endings: Endings,
    binary: bool,
    stateful: bool,
}
impl Validation {
    fn new(label: &str) -> Result<Self, Failure> {
        let enc = codec(label)?;
        Ok(Self {
            decoder: enc.new_decoder_without_bom_handling(),
            profile: ByteProfile::new(label),
            valid: true,
            endings: Endings::default(),
            binary: false,
            stateful: enc == encoding_rs::ISO_2022_JP,
        })
    }
    fn push(&mut self, mut bytes: &[u8], last: bool) {
        if !self.valid {
            return;
        }
        self.profile.push(bytes);
        if !self.profile.valid {
            self.valid = false;
            return;
        }
        let mut output = [0u8; 8192];
        loop {
            let (result, read, written) =
                self.decoder
                    .decode_to_utf8_without_replacement(bytes, &mut output, last);
            let text = std::str::from_utf8(&output[..written]).expect("decoder UTF-8");
            self.endings.push(text);
            self.binary |= text
                .as_bytes()
                .iter()
                .any(|c| matches!(*c,0..=8|14..=31|127) && !(self.stateful && *c == 27));
            bytes = &bytes[read..];
            match result {
                DecoderResult::InputEmpty => break,
                DecoderResult::Malformed(..) => {
                    self.valid = false;
                    break;
                }
                DecoderResult::OutputFull => {}
            }
        }
        if last {
            self.valid &= self.profile.finish();
        }
    }
    fn format(self, encoding: String, bom: bool, source: &str) -> Result<Format, Failure> {
        if self.binary {
            return Err(Failure {
                kind: "binary",
                message: "File contains binary control characters".into(),
                encoding: None,
                position: None,
                character: None,
            });
        }
        if !self.valid {
            return Err(Failure {
                kind: "unsupported-encoding",
                message: format!("File is not valid {encoding} text"),
                encoding: Some(encoding),
                position: None,
                character: None,
            });
        }
        let (line_ending, default_line_ending) = self.endings.finish();
        Ok(Format {
            encoding,
            bom,
            line_ending,
            default_line_ending,
            source: source.into(),
        })
    }
}
/// Detection consumes the complete stream with constant memory. Only the UTF-8
/// and configured interpretations are validated in this pass. A guessed or
/// declared legacy interpretation is validated on the existing seekable reader
/// before it becomes a text result; decode success alone never proves identity.
pub(crate) struct Probe {
    utf8: Validation,
    configured: Option<(String, Validation)>,
    detector: Option<chardetng::EncodingDetector>,
    gbk_shape: ByteProfile,
    prefix: Vec<u8>,
    header: Vec<u8>,
    ascii: bool,
    explicit: bool,
    initialized: bool,
}
impl Probe {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::with_encoding(None, None)
    }
    pub(crate) fn with_encoding(explicit: Option<&str>, default: Option<&str>) -> Self {
        let selected = explicit
            .filter(|e| !e.trim().eq_ignore_ascii_case("auto"))
            .or(default)
            .and_then(|e| canonical(e).ok());
        Self {
            utf8: Validation::new("utf-8").unwrap(),
            configured: selected
                .filter(|e| e != "utf-8")
                .and_then(|e| Validation::new(&e).ok().map(|v| (e, v))),
            detector: explicit
                .filter(|e| !e.trim().eq_ignore_ascii_case("auto"))
                .is_none()
                .then(|| chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow)),
            gbk_shape: ByteProfile::new("gbk"),
            prefix: Vec::new(),
            header: Vec::new(),
            ascii: true,
            explicit: explicit.is_some_and(|e| !e.trim().eq_ignore_ascii_case("auto")),
            initialized: false,
        }
    }
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        // HTML's encoding declaration prescan is its standard 1024-byte window;
        // this bounds sniffing metadata, never the file or decoder input.
        let n = (1024 - self.header.len()).min(bytes.len());
        self.header.extend_from_slice(&bytes[..n]);
        if !self.initialized {
            let n = (3 - self.prefix.len()).min(bytes.len());
            self.prefix.extend_from_slice(&bytes[..n]);
            if self.prefix.len() < 3 {
                return;
            }
            self.initialize();
            let initial = self.prefix.clone();
            self.feed(&initial);
            self.feed(&bytes[n..]);
        } else {
            self.feed(bytes);
        }
    }
    fn initialize(&mut self) {
        self.initialized = true;
        if let Some(enc) = Encoding::for_bom(&self.prefix).map(|(e, _)| e) {
            // Explicit reinterpretation wins over the marker. Otherwise validate
            // its real Unicode codec instead of feeding UTF-16 into a legacy one.
            if !self.explicit {
                let label = name(enc);
                self.configured = if enc == UTF_8 {
                    None
                } else {
                    Some((label.clone(), Validation::new(&label).unwrap()))
                };
            }
        }
    }
    fn feed(&mut self, bytes: &[u8]) {
        self.ascii &= bytes.is_ascii();
        self.utf8.push(bytes, false);
        if let Some((_, validation)) = &mut self.configured {
            validation.push(bytes, false);
        }
        self.gbk_shape.push(bytes);
        if let Some(detector) = &mut self.detector {
            detector.feed(bytes, false);
        }
    }
    pub(crate) fn finish(
        mut self,
        explicit: Option<&str>,
        default: Option<&str>,
    ) -> Result<Format, Failure> {
        if !self.initialized {
            self.initialize();
            let initial = self.prefix.clone();
            self.feed(&initial);
        }
        self.utf8.push(&[], true);
        if let Some(detector) = &mut self.detector {
            detector.feed(&[], true);
        }
        if let Some((_, v)) = &mut self.configured {
            v.push(&[], true);
        }
        let explicit = explicit.filter(|e| !e.trim().eq_ignore_ascii_case("auto"));
        let (chosen, source) = if let Some(e) = explicit {
            (canonical(e)?, "explicit")
        } else if let Some((e, _)) = Encoding::for_bom(&self.prefix) {
            (name(e), "bom")
        } else if let Some(e) = declaration(&self.header) {
            (canonical(&e)?, "declaration")
        } else if self.ascii && !self.utf8.binary {
            let chosen = default
                .map(canonical)
                .transpose()?
                .unwrap_or_else(|| "utf-8".into());
            if !self.prefix.is_empty() && matches!(chosen.as_str(), "utf-16le" | "utf-16be") {
                ("utf-8".into(), "utf8")
            } else {
                (chosen, if default.is_some() { "default" } else { "utf8" })
            }
        } else if self.utf8.valid && !self.utf8.binary {
            ("utf-8".into(), "utf8")
        } else if self
            .configured
            .as_ref()
            .is_some_and(|(_, v)| v.valid && !v.binary)
            && default.is_some()
        {
            (canonical(default.unwrap())?, "default")
        } else {
            let enc = self
                .detector
                .as_ref()
                .expect("auto detector")
                .guess(None, chardetng::Utf8Detection::Deny);
            let label = if enc == GBK || enc == encoding_rs::GB18030 {
                if self.gbk_shape.finish() {
                    "gbk".into()
                } else {
                    "gb18030".into()
                }
            } else {
                name(enc)
            };
            (label, "detected")
        };
        let bom =
            !marker(codec(&chosen)?).is_empty() && self.prefix.starts_with(marker(codec(&chosen)?));
        if chosen == "utf-8" {
            return self.utf8.format(chosen, bom, source);
        }
        if self.configured.as_ref().is_some_and(|(e, _)| *e == chosen) {
            return self.configured.unwrap().1.format(chosen, bom, source);
        }
        // The caller completes strict validation using the chosen decoder.
        Ok(Format {
            encoding: chosen,
            bom,
            line_ending: "none".into(),
            default_line_ending: "lf".into(),
            source: source.into(),
        })
    }
}
/// Recognize declarations in the header, not arbitrary occurrences of the word
/// encoding in program text. Browser aliases remain compatibility aliases.
fn declaration(header: &[u8]) -> Option<String> {
    let header = String::from_utf8_lossy(header);
    let lower = header.to_ascii_lowercase();
    let mut candidates = Vec::new();
    if lower.starts_with("<?xml") {
        candidates.push(lower.split("?>").next().unwrap_or(&lower));
    }
    for line in lower.lines().take(2) {
        if line.trim_start().starts_with('#') {
            candidates.push(line);
        }
    }
    let mut rest = lower.as_str();
    while let Some((_, tail)) = rest.split_once("<meta") {
        let (tag, tail) = tail.split_once('>').unwrap_or((tail, ""));
        candidates.push(tag);
        rest = tail;
    }
    for text in candidates {
        for key in ["encoding", "charset", "coding"] {
            let mut rest = text;
            while let Some((before, tail)) = rest.split_once(key) {
                rest = tail;
                if before
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                {
                    continue;
                }
                let tail = tail.trim_start();
                if !tail.starts_with(['=', ':']) {
                    continue;
                }
                let tail = tail[1..].trim_start().trim_start_matches(['\'', '"']);
                let label = tail
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                    .collect::<String>();
                if !label.is_empty() && codec(&label).is_ok() {
                    return Some(label);
                }
            }
        }
    }
    None
}
pub(crate) fn decode<'a>(
    bytes: &'a [u8],
    explicit: Option<&str>,
    default: Option<&str>,
) -> Result<(Cow<'a, str>, Format), Failure> {
    decode_with_content(bytes, explicit, default, true)
}
fn decode_with_content<'a>(
    bytes: &'a [u8],
    explicit: Option<&str>,
    default: Option<&str>,
    include_content: bool,
) -> Result<(Cow<'a, str>, Format), Failure> {
    let forced = explicit
        .filter(|e| !e.trim().eq_ignore_ascii_case("auto"))
        .map(codec)
        .transpose()?;
    let utf8_candidate = declaration(&bytes[..bytes.len().min(1024)]).is_none()
        && (forced == Some(UTF_8)
            || (forced.is_none()
                && (!bytes.is_ascii() || default.is_none() || default == Some("utf-8"))));
    if utf8_candidate && !clearly_binary(bytes) {
        if let Ok(text) = std::str::from_utf8(bytes) {
            let bom = bytes.starts_with(marker(UTF_8));
            let text = if bom { &text[3..] } else { text };
            let mut endings = Endings::default();
            endings.push(text);
            let (line_ending, default_line_ending) = endings.finish();
            return Ok((
                Cow::Borrowed(if include_content { text } else { "" }),
                Format {
                    encoding: "utf-8".into(),
                    bom,
                    line_ending,
                    default_line_ending,
                    source: if forced.is_some() {
                        "explicit"
                    } else if bom {
                        "bom"
                    } else {
                        "utf8"
                    }
                    .into(),
                },
            ));
        }
    }
    let mut probe = Probe::with_encoding(explicit, default);
    probe.push(bytes);
    let format = probe.finish(explicit, default)?;
    let enc = codec(&format.encoding)?;
    let payload = if format.bom {
        &bytes[marker(enc).len()..]
    } else {
        bytes
    };
    let needs_validation = matches!(format.source.as_str(), "detected" | "declaration");
    let (text, format) = if include_content {
        let text = decode_payload(payload, &format.encoding)?;
        let mut format = format;
        if needs_validation {
            let stateful = enc == encoding_rs::ISO_2022_JP;
            if text
                .as_bytes()
                .iter()
                .any(|c| matches!(*c,0..=8|14..=31|127) && !(stateful && *c == 27))
            {
                return Err(Failure {
                    kind: "binary",
                    message: "File contains binary control characters".into(),
                    encoding: None,
                    position: None,
                    character: None,
                });
            }
            let mut endings = Endings::default();
            endings.push(&text);
            (format.line_ending, format.default_line_ending) = endings.finish();
        }
        (text, format)
    } else if needs_validation {
        let mut validation = Validation::new(&format.encoding)?;
        validation.push(payload, true);
        (
            Cow::Borrowed(""),
            validation.format(format.encoding, format.bom, &format.source)?,
        )
    } else {
        (Cow::Borrowed(""), format)
    };
    Ok((text, format))
}
pub(crate) fn encode(text: &str, format: &Format) -> Result<Vec<u8>, Failure> {
    let enc = codec(&format.encoding)?;
    let mut bytes = Vec::new();
    if format.bom {
        if marker(enc).is_empty() {
            return Err(Failure::invalid(format!("{} has no BOM", format.encoding)));
        }
        bytes.extend_from_slice(marker(enc));
    }
    if canonical(&format.encoding)? == "gb2312-strict" {
        return codecs::encode_gb2312(text, format);
    }
    if enc == UTF_8 {
        bytes.extend_from_slice(text.as_bytes());
    } else if enc == UTF_16LE || enc == UTF_16BE {
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&if enc == UTF_16LE {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
    } else {
        let mut encoder = enc.new_encoder();
        let mut consumed = 0;
        let mut output = [0u8; 8192];
        loop {
            let (result, read, written) =
                encoder.encode_from_utf8_without_replacement(&text[consumed..], &mut output, true);
            bytes.extend_from_slice(&output[..written]);
            consumed += read;
            match result {
                EncoderResult::InputEmpty => break,
                EncoderResult::OutputFull => {}
                EncoderResult::Unmappable(c) => {
                    let position = text[..consumed - c.len_utf8()].encode_utf16().count();
                    return Err(Failure{kind:"unrepresentable",message:format!("Character U+{:04X} at UTF-16 position {position} cannot be saved as {}",c as u32,format.encoding),encoding:Some(format.encoding.clone()),position:Some(position),character:Some(c.to_string())});
                }
            }
        }
    }
    if enc != UTF_8 && enc != UTF_16LE && enc != UTF_16BE {
        codecs::verify_encoded_text(text, &bytes, &format.encoding)?;
    }
    Ok(bytes)
}
fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
fn ending(text: &str, eol: &str) -> String {
    let text = normalize(text);
    match eol {
        "crlf" => text.replace('\n', "\r\n"),
        "cr" => text.replace('\n', "\r"),
        _ => text,
    }
}
fn utf16_index(text: &str, index: usize) -> Result<usize, Failure> {
    let mut pos = 0;
    for (i, c) in text.char_indices() {
        if pos == index {
            return Ok(i);
        }
        pos += c.len_utf16();
        if pos > index {
            return Err(Failure::invalid("Edit splits a UTF-16 surrogate pair"));
        }
    }
    if pos == index {
        Ok(text.len())
    } else {
        Err(Failure::invalid("Edit position is outside the baseline"))
    }
}
/// Raw scalar spans are derived from the validated byte stream, never by
/// re-encoding Unicode (GBK has non-bijective mappings such as A3 A0 / A1 A1).
fn raw_positions(
    bytes: &[u8],
    format: &Format,
    text: &str,
    normalized: bool,
    requested: &std::collections::BTreeSet<usize>,
) -> Result<Vec<(usize, usize)>, Failure> {
    let enc = codec(&format.encoding)?;
    let skip = if format.bom { marker(enc).len() } else { 0 };
    let mut units =
        stream::Units::new(std::io::Cursor::new(&bytes[skip..]), &format.encoding, skip)?;
    let mut spans = Vec::new();
    let mut decoded = 0;
    let mut pending_cr = false;
    if requested.contains(&0) {
        spans.push((0, skip));
    }
    while let Some(unit) = units
        .next(&|| Ok(()))
        .map_err(|e| Failure::invalid(e.to_string()))?
    {
        let value = unit.text();
        if pending_cr && normalized && value == "\n" {
            if let Some((at, raw)) = spans.last_mut() {
                if *at == decoded {
                    *raw = unit.end;
                }
            }
            pending_cr = false;
            continue;
        }
        let before = decoded;
        if normalized && value == "\r" {
            decoded += 1;
            pending_cr = true;
        } else {
            decoded += value.len();
            pending_cr = false;
        }
        if requested
            .range((
                std::ops::Bound::Excluded(before),
                std::ops::Bound::Excluded(decoded),
            ))
            .next()
            .is_some()
        {
            if spans.last().is_none_or(|p| p.0 != before) {
                spans.push((before, unit.start));
            }
            spans.push((decoded, unit.end));
        } else if requested.contains(&decoded) {
            spans.push((decoded, unit.end));
        }
    }
    let expected = if normalized {
        normalize(text).len()
    } else {
        text.len()
    };
    if decoded != expected {
        return Err(Failure::invalid("Source character mapping changed"));
    }
    if requested.contains(&decoded) {
        if let Some((at, raw)) = spans.last_mut() {
            if *at == decoded {
                *raw = bytes.len();
            }
        }
    }

    Ok(spans)
}
/// Deterministic full-replacement fallback. Line anchors preserve unchanged
/// regions, character refinement preserves within-line aliases. The deadline
/// may coarsen a replacement, never omit text or split a Unicode scalar. Exact
/// editor-provided edits bypass this inference entirely.
fn replacement_ranges(old: &str, new: &str) -> Vec<(usize, usize, String)> {
    fn ranges<'a>(
        diff: &similar::TextDiff<'a, 'a, 'a, str>,
        offset: usize,
    ) -> Vec<(usize, usize, String)> {
        let mut result = Vec::new();
        let mut cursor = offset;
        let mut pending: Option<(usize, usize, String)> = None;
        for change in diff.iter_all_changes() {
            match change.tag() {
                similar::ChangeTag::Equal => {
                    if let Some(edit) = pending.take() {
                        result.push(edit);
                    }
                    cursor += change.value().len();
                }
                similar::ChangeTag::Delete => {
                    let entry = pending.get_or_insert((cursor, cursor, String::new()));
                    cursor += change.value().len();
                    entry.1 = cursor;
                }
                similar::ChangeTag::Insert => pending
                    .get_or_insert((cursor, cursor, String::new()))
                    .2
                    .push_str(change.value()),
            }
        }
        if let Some(edit) = pending {
            result.push(edit);
        }
        result
    }
    if old == new {
        return Vec::new();
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    let line_diff = similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Patience)
        .deadline(deadline)
        .diff_lines(old, new);
    let mut refined = Vec::new();
    for (start, end, replacement) in ranges(&line_diff, 0) {
        if std::time::Instant::now() >= deadline {
            refined.push((start, end, replacement));
            continue;
        }
        let diff = similar::TextDiff::configure()
            .deadline(deadline)
            .diff_chars(&old[start..end], &replacement);
        refined.extend(ranges(&diff, start));
    }
    refined
}
fn encode_at(
    body: &str,
    format: &Format,
    normalized: bool,
    offset: usize,
) -> Result<Vec<u8>, Failure> {
    encode(body, format).map_err(|mut error| {
        if let Some(position) = error.position {
            let local = if normalized {
                utf16_index(body, position)
                    .map(|i| normalize(&body[..i]).encode_utf16().count())
                    .unwrap_or(position)
            } else {
                position
            };
            error.position = Some(offset + local);
            if let Some(character) = &error.character {
                error.message = format!(
                    "Character {character} at UTF-16 position {} cannot be saved as {}",
                    offset + local,
                    format.encoding
                );
            }
        }
        error
    })
}
fn raw_at(spans: &[(usize, usize)], index: usize) -> Result<usize, Failure> {
    spans
        .binary_search_by_key(&index, |p| p.0)
        .map(|i| spans[i].1)
        .map_err(|_| Failure::invalid("Edit is not on a character boundary"))
}
/// A Big5 combining pair cannot be split on disk. Expand only the touched
/// encoded unit, retaining every unrelated original byte and line ending.
fn expand_ranges(
    ranges: Vec<(usize, usize, String)>,
    baseline: &str,
    spans: &[(usize, usize)],
) -> Result<Vec<(usize, usize, String)>, Failure> {
    let mut groups: Vec<(usize, usize, Vec<(usize, usize, String)>)> = Vec::new();
    for (start, end, text) in ranges {
        let a = match spans.binary_search_by_key(&start, |p| p.0) {
            Ok(i) => spans[i].0,
            Err(i) if i > 0 => spans[i - 1].0,
            _ => return Err(Failure::invalid("Missing source boundary")),
        };
        let b = match spans.binary_search_by_key(&end, |p| p.0) {
            Ok(i) => spans[i].0,
            Err(i) if i < spans.len() => spans[i].0,
            _ => return Err(Failure::invalid("Missing source boundary")),
        };
        if let Some(group) = groups.last_mut().filter(|group| a <= group.1) {
            group.1 = group.1.max(b);
            group.2.push((start, end, text));
        } else {
            groups.push((a, b, vec![(start, end, text)]));
        }
    }
    Ok(groups
        .into_iter()
        .map(|(start, end, edits)| {
            let mut text = String::new();
            let mut cursor = start;
            for (a, b, value) in edits {
                text.push_str(&baseline[cursor..a]);
                text.push_str(&value);
                cursor = b;
            }
            text.push_str(&baseline[cursor..end]);
            (start, end, text)
        })
        .collect())
}
pub(crate) fn serialize(
    content: &str,
    source: Option<&[u8]>,
    source_format: Option<&Format>,
    target: Option<&TargetFormat>,
    normalized: bool,
    edits: Option<&[Edit]>,
) -> Result<(Vec<u8>, Format), Failure> {
    let decoded = source
        .map(|b| decode(b, source_format.map(|f| f.encoding.as_str()), None))
        .transpose()?;
    let mut format = decoded
        .as_ref()
        .map(|(_, f)| f.clone())
        .or_else(|| source_format.cloned())
        .unwrap_or(Format {
            encoding: "utf-8".into(),
            bom: false,
            line_ending: "lf".into(),
            default_line_ending: "lf".into(),
            source: "default".into(),
        });
    format.encoding = canonical(&format.encoding)?;
    let original = format.clone();
    if let Some(target) = target {
        if let Some(encoding) = &target.encoding {
            format.encoding = canonical(encoding)?;
            format.source = "explicit".into();
            if marker(codec(&format.encoding)?).is_empty() && target.bom.is_none() {
                format.bom = false;
            }
        }
        if let Some(bom) = target.bom {
            format.bom = bom;
        }
        if let Some(eol) = &target.line_ending {
            if !matches!(eol.as_str(), "lf" | "crlf" | "cr" | "mixed") {
                return Err(Failure::invalid("Invalid line ending"));
            }
            if eol != "mixed" {
                format.line_ending = eol.clone();
                format.default_line_ending = eol.clone();
            }
        }
    }
    if source.is_none()
        && target.is_none_or(|target| target.bom.is_none())
        && matches!(format.encoding.as_str(), "utf-16le" | "utf-16be")
    {
        format.bom = true;
    }
    if format.bom && marker(codec(&format.encoding)?).is_empty() {
        return Err(Failure::invalid(format!("{} has no BOM", format.encoding)));
    }
    let convert_eol = target
        .and_then(|f| f.line_ending.as_deref())
        .filter(|e| *e != "mixed");
    let same_format = format.encoding == original.encoding
        && format.bom == original.bom
        && (convert_eol.is_none() || convert_eol == Some(original.line_ending.as_str()));
    let comparison = if normalized {
        Cow::Owned(normalize(content))
    } else {
        Cow::Borrowed(content)
    };
    if let Some((old, _)) = &decoded {
        let old_comparison = if normalized {
            Cow::Owned(normalize(old))
        } else {
            Cow::Borrowed(old.as_ref())
        };
        // Editor provenance is checked even on the reversible whole-file fast path.
        // It is only used for raw boundary mapping when byte preservation needs it.
        let edit_ranges = edits
            .map(|edits| {
                let positions = edits
                    .iter()
                    .flat_map(|edit| [edit.start, edit.end])
                    .collect::<std::collections::BTreeSet<_>>();
                let mut positions = positions.into_iter().peekable();
                let mut mapped = std::collections::BTreeMap::new();
                let mut utf16 = 0;
                for (byte, character) in old_comparison
                    .char_indices()
                    .map(|(byte, c)| (byte, Some(c)))
                    .chain(std::iter::once((old_comparison.len(), None)))
                {
                    while positions.peek() == Some(&utf16) {
                        mapped.insert(positions.next().unwrap(), byte);
                    }
                    if positions.peek().is_some_and(|position| *position < utf16) {
                        return Err(Failure::invalid("Edit splits a UTF-16 surrogate pair"));
                    }
                    if positions.peek().is_none() {
                        break;
                    }
                    utf16 += character.map_or(0, char::len_utf16);
                }
                if positions.peek().is_some() {
                    return Err(Failure::invalid("Edit lies beyond source text"));
                }
                let mut ranges = Vec::new();
                for edit in edits {
                    ranges.push((
                        mapped[&edit.start],
                        mapped[&edit.end],
                        if normalized {
                            normalize(&edit.text)
                        } else {
                            edit.text.clone()
                        },
                    ));
                }
                ranges.sort_by_key(|e| e.0);
                let mut assembled = String::new();
                let mut cursor = 0;
                for (start, end, replacement) in &ranges {
                    if *start < cursor || end < start {
                        return Err(Failure::invalid("Edits overlap or reverse their range"));
                    }
                    assembled.push_str(&old_comparison[cursor..*start]);
                    assembled.push_str(replacement);
                    cursor = *end;
                }
                assembled.push_str(&old_comparison[cursor..]);
                if assembled != comparison {
                    return Err(Failure::invalid(
                        "Edits do not produce the supplied content",
                    ));
                }
                Ok(ranges)
            })
            .transpose()?;
        if old_comparison == comparison && same_format {
            return Ok((source.unwrap().to_vec(), format));
        }
        if same_format
            && original.line_ending != "mixed"
            && encode(old, &original).is_ok_and(|encoded| encoded == source.unwrap())
        {
            let body = if normalized {
                ending(content, &format.default_line_ending)
            } else {
                content.into()
            };
            let bytes = encode_at(&body, &format, normalized, 0)?;
            let mut e = Endings::default();
            e.push(&body);
            (format.line_ending, format.default_line_ending) = e.finish();
            return Ok((bytes, format));
        }
        if convert_eol.is_none() || convert_eol == Some(original.line_ending.as_str()) {
            let baseline = old_comparison.as_ref();
            let ranges = edit_ranges.unwrap_or_else(|| replacement_ranges(baseline, &comparison));
            let requested = ranges.iter().flat_map(|(a, b, _)| [*a, *b]).collect();
            let spans = raw_positions(source.unwrap(), &original, old, normalized, &requested)?;
            let ranges = expand_ranges(ranges, baseline, &spans)?;
            let independent = codec(&original.encoding)? != encoding_rs::ISO_2022_JP
                && ranges
                    .iter()
                    .all(|(a, b, _)| raw_at(&spans, *a).is_ok() && raw_at(&spans, *b).is_ok());
            if !independent {
                let mut body = String::new();
                let mut cursor = 0;
                let positions = ranges.iter().flat_map(|(a, b, _)| [*a, *b]).collect();
                let utf8_format = Format {
                    encoding: "utf-8".into(),
                    bom: false,
                    ..original.clone()
                };
                let utf8_spans =
                    raw_positions(old.as_bytes(), &utf8_format, old, normalized, &positions)?;
                for (start, end, replacement) in &ranges {
                    let start = raw_at(&utf8_spans, *start)?;
                    let end = raw_at(&utf8_spans, *end)?;
                    body.push_str(&old[cursor..start]);
                    body.push_str(&if normalized {
                        ending(replacement, &format.default_line_ending)
                    } else {
                        replacement.clone()
                    });
                    cursor = end;
                }
                body.push_str(&old[cursor..]);
                let bytes = encode_at(&body, &format, normalized, 0)?;
                let mut endings = Endings::default();
                endings.push(&body);
                (format.line_ending, format.default_line_ending) = endings.finish();
                return Ok((bytes, format));
            }
            let mut assembled = String::new();
            let same_codec = format.encoding == original.encoding;
            let source_codec = codec(&original.encoding)?;
            let mut bytes = Vec::new();
            let mut transcoded = String::new();
            if same_codec && format.bom {
                bytes.extend_from_slice(marker(source_codec));
            }
            let mut cursor = 0;
            let mut raw_cursor = if original.bom {
                marker(source_codec).len()
            } else {
                0
            };
            let mut fragment_format = format.clone();
            fragment_format.bom = false;
            for (start, end, replacement) in ranges {
                if start < cursor || end < start {
                    return Err(Failure::invalid("Edits overlap or reverse their range"));
                }
                assembled.push_str(&baseline[cursor..start]);
                let replacement_position = assembled.encode_utf16().count();
                assembled.push_str(&replacement);
                let raw_start = raw_at(&spans, start)?;
                let raw_end = raw_at(&spans, end)?;
                let unchanged = &source.unwrap()[raw_cursor..raw_start];
                if same_codec {
                    bytes.extend_from_slice(unchanged);
                } else {
                    transcoded.push_str(&decode_payload(unchanged, &original.encoding)?);
                }
                let replacement = if normalized {
                    ending(&replacement, &format.default_line_ending)
                } else {
                    replacement
                };
                if same_codec {
                    bytes.extend(encode_at(
                        &replacement,
                        &fragment_format,
                        normalized,
                        replacement_position,
                    )?);
                } else {
                    transcoded.push_str(&replacement);
                }
                cursor = end;
                raw_cursor = raw_end;
            }
            assembled.push_str(&baseline[cursor..]);
            if assembled != comparison {
                return Err(Failure::invalid(
                    "Edits do not produce the supplied content",
                ));
            }
            if same_codec {
                bytes.extend_from_slice(&source.unwrap()[raw_cursor..]);
            } else {
                transcoded.push_str(&decode_payload(
                    &source.unwrap()[raw_cursor..],
                    &original.encoding,
                )?);
                bytes = encode_at(&transcoded, &format, normalized, 0)?;
            }
            let (_, actual) = decode(&bytes, Some(&format.encoding), None)?;
            format.line_ending = actual.line_ending;
            format.default_line_ending = actual.default_line_ending;
            return Ok((bytes, format));
        }
    }
    let body = if let Some(eol) = convert_eol {
        ending(content, eol)
    } else if normalized {
        ending(content, &format.default_line_ending)
    } else {
        content.into()
    };
    let bytes = encode_at(&body, &format, normalized, 0)?;
    let mut e = Endings::default();
    e.push(&body);
    (format.line_ending, format.default_line_ending) = e.finish();
    Ok((bytes, format))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecodeParams {
    bytes_base64: String,
    encoding: Option<String>,
    default_encoding: Option<String>,
    include_content: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SerializeParams {
    content: String,
    source_bytes_base64: Option<String>,
    source_format: Option<Format>,
    target_format: Option<TargetFormat>,
    normalize_line_endings: Option<bool>,
    edits: Option<Vec<Edit>>,
}
pub(crate) fn request(method: &str, params: Value) -> Result<Value, KernelError> {
    if method == "text.encodings" {
        return Ok(registry());
    }
    if method == "text.decode" {
        let p: DecodeParams = serde_json::from_value(params)?;
        let bytes = STANDARD
            .decode(p.bytes_base64)
            .map_err(|_| KernelError::Protocol("Invalid text bytes base64".into()))?;
        return Ok(
            match decode_with_content(
                &bytes,
                p.encoding.as_deref(),
                p.default_encoding.as_deref(),
                p.include_content != Some(false),
            ) {
                Ok((text, format)) => {
                    let mut result =
                        json!({"kind":"text","format":format,"byteLength":bytes.len()});
                    if p.include_content != Some(false) {
                        result["content"] = json!(text);
                    }
                    result
                }
                Err(e) => {
                    let mut v = e.value();
                    if v["kind"] == "invalid" {
                        v["kind"] = json!("unsupported-encoding");
                    }
                    v["byteLength"] = json!(bytes.len());
                    v["candidates"] = json!(registry()
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| e["encoding"].clone())
                        .collect::<Vec<_>>());
                    v
                }
            },
        );
    }
    let p: SerializeParams = serde_json::from_value(params)?;
    let bytes = p
        .source_bytes_base64
        .map(|b| STANDARD.decode(b))
        .transpose()
        .map_err(|_| KernelError::Protocol("Invalid source bytes base64".into()))?;
    Ok(
        match serialize(
            &p.content,
            bytes.as_deref(),
            p.source_format.as_ref(),
            p.target_format.as_ref(),
            p.normalize_line_endings.unwrap_or(false),
            p.edits.as_deref(),
        ) {
            Ok((bytes, format)) => {
                json!({"kind":"serialized","byteLength":bytes.len(),"bytesBase64":STANDARD.encode(bytes),"format":format})
            }
            Err(e) => e.value(),
        },
    )
}

/// Frozen with the existing source binding. Path names select an interpretation,
/// never filesystem authority; materialized sources retain the original rules.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Policy {
    pub default_encoding: Option<String>,
    pub files: Option<std::collections::BTreeMap<String, String>>,
    pub root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice_revisions: Option<std::collections::BTreeMap<String, u64>>,
}
impl Policy {
    fn relative(&self, path: &str) -> Option<String> {
        let windows = self.root.as_ref().is_some_and(|root| {
            root.as_bytes().get(1) == Some(&b':')
                || root.starts_with("\\\\")
                || root.starts_with("//")
        });
        let canonical = |value: &str| {
            let value = value.replace('\\', "/");
            if windows {
                value.to_lowercase()
            } else {
                value
            }
        };
        let lexical = |value: String| -> Option<String> {
            let absolute = value.starts_with('/') || value.as_bytes().get(1) == Some(&b':');
            let prefix = if value.starts_with("//") {
                "//"
            } else if value.starts_with('/') {
                "/"
            } else {
                ""
            };
            let floor = if prefix == "//" {
                2
            } else if value.as_bytes().get(1) == Some(&b':') {
                1
            } else {
                0
            };
            let mut components = Vec::new();
            for part in value.split('/') {
                match part {
                    "" | "." => (),
                    ".." => {
                        if components.len() > floor {
                            components.pop();
                        } else if !absolute {
                            return None;
                        }
                    }
                    _ => components.push(part),
                }
            }
            Some(format!("{prefix}{}", components.join("/")))
        };
        let path = lexical(canonical(path))?;
        let absolute = path.starts_with('/') || path.as_bytes().get(1) == Some(&b':');
        if !absolute {
            return Some(path);
        }
        let root = lexical(canonical(self.root.as_deref()?))?;
        let root = root.trim_end_matches('/');
        if path == root {
            return Some(String::new());
        }
        path.strip_prefix(&format!("{root}/")).map(str::to_owned)
    }
    pub(crate) fn choice_revision(&self, path: &str) -> Option<u64> {
        let relative = self.relative(path)?;
        Some(
            self.choice_revisions
                .as_ref()
                .and_then(|values| values.get(&relative))
                .copied()
                .unwrap_or(0),
        )
    }
    pub(crate) fn default_for(&self, path: &str) -> Option<&str> {
        self.relative(path)?;
        self.default_encoding.as_deref()
    }
    pub(crate) fn encoding(&self, path: &str) -> Option<&str> {
        let relative = self.relative(path)?;
        let files = self.files.as_ref()?;
        files
            .get(&relative)
            .or_else(|| {
                files
                    .iter()
                    .filter(|(key, _)| {
                        key.as_str() == "./"
                            || (key.ends_with('/') && relative.starts_with(key.as_str()))
                    })
                    .max_by_key(|(key, _)| if key.as_str() == "./" { 0 } else { key.len() })
                    .map(|(_, value)| value)
            })
            .map(String::as_str)
    }
}
pub(crate) fn format_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"encoding":{"type":"string"},"bom":{"type":"boolean"},"lineEnding":{"type":"string"},"defaultLineEnding":{"type":"string"},"source":{"type":"string"}},"required":["encoding","bom","lineEnding","defaultLineEnding","source"],"description":"Copy content.format from the original file_read along with readVersion. It fixes the interpretation, not a conversion."})
}
pub(crate) fn target_schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"encoding":{"type":"string"},"bom":{"type":"boolean"},"lineEnding":{"type":"string","enum":["lf","crlf","cr","mixed"]}},"description":"Only provide for an explicit conversion. Ordinary saves preserve the source format."})
}
/// Map only requested parser boundaries. No per-character map is retained by
/// normal search or structure parsing; unit readers need these raw positions.
pub(crate) fn locate_structure_ranges(
    value: &mut Value,
    bytes: &[u8],
    text: &str,
    format: &Format,
) -> Result<(), Failure> {
    fn gather(value: &Value, positions: &mut std::collections::BTreeMap<usize, usize>) {
        match value {
            Value::Object(o) => {
                for key in ["startByte", "endByte"] {
                    if let Some(n) = o.get(key).and_then(Value::as_u64) {
                        positions.insert(n as usize, 0);
                    }
                }
                for v in o.values() {
                    gather(v, positions);
                }
            }
            Value::Array(a) => {
                for v in a {
                    gather(v, positions)
                }
            }
            _ => {}
        }
    }
    let mut positions = std::collections::BTreeMap::new();
    gather(value, &mut positions);
    // Parser offsets stay in Unicode bytes; original ranges cover the complete
    // decoder emission when a boundary lies inside a multi-scalar mapping.
    let enc = codec(&format.encoding)?;
    let skip = if format.bom { marker(enc).len() } else { 0 };
    let mut units =
        stream::Units::new(std::io::Cursor::new(&bytes[skip..]), &format.encoding, skip)?;
    let mut decoded = 0;
    let mut bounds = std::collections::BTreeMap::new();
    while let Some(unit) = units
        .next(&|| Ok(()))
        .map_err(|e| Failure::invalid(e.to_string()))?
    {
        let end = decoded + unit.text().len();
        for (&offset, _) in positions.range(decoded..=end) {
            bounds.entry(offset).or_insert(if offset == decoded {
                (unit.start, unit.start)
            } else if offset == end {
                (unit.end, unit.end)
            } else {
                (unit.start, unit.end)
            });
        }
        decoded = end;
    }
    bounds.insert(text.len(), (bytes.len(), bytes.len()));
    fn project(value: &mut Value, bounds: &std::collections::BTreeMap<usize, (usize, usize)>) {
        match value {
            Value::Object(o) => {
                for (key, raw, end) in [
                    ("startByte", "sourceStartByte", false),
                    ("endByte", "sourceEndByte", true),
                ] {
                    if let Some(&(a, b)) = o
                        .get(key)
                        .and_then(Value::as_u64)
                        .and_then(|n| bounds.get(&(n as usize)))
                    {
                        o.insert(raw.into(), json!(if end { b } else { a }));
                    }
                }
                for value in o.values_mut() {
                    project(value, bounds);
                }
            }
            Value::Array(a) => {
                for value in a {
                    project(value, bounds);
                }
            }
            _ => {}
        }
    }
    project(value, &bounds);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn gbk() -> Format {
        Format {
            encoding: "gbk".into(),
            bom: false,
            line_ending: "lf".into(),
            default_line_ending: "lf".into(),
            source: "explicit".into(),
        }
    }
    #[test]
    fn utf8_fast_path_and_ambiguous_bytes_follow_explicit_rules() {
        let (text, format) = decode("中文🙂".as_bytes(), None, None).unwrap();
        assert!(matches!(text, Cow::Borrowed(_)));
        assert_eq!(format.encoding, "utf-8");
        assert_eq!(decode(b"\xc2\xa9", None, None).unwrap().0, "©");
        assert_eq!(decode(b"\xc2\xa9", Some("gb2312"), None).unwrap().0, "漏");
        assert_eq!(
            decode(b"ascii", None, Some("gbk")).unwrap().1.encoding,
            "gbk"
        );
        assert_eq!(
            decode("中文".as_bytes(), None, Some("gbk"))
                .unwrap()
                .1
                .encoding,
            "utf-8"
        );
        assert_eq!(
            decode(b"ascii", Some("gb2312-strict"), None)
                .unwrap()
                .1
                .encoding,
            "gb2312-strict"
        );
        // GBK's encoding_rs decoder also accepts GB18030. Our profile does not
        // silently claim that a four-byte-only character is GBK-encodable.
        assert!(decode(b"\x94\x39\xfc\x36", Some("gbk"), None).is_err());
    }
    #[test]
    fn strict_gbk_encoder_reports_utf16_position_without_entities_or_replacement() {
        assert_eq!(encode("中文", &gbk()).unwrap(), b"\xd6\xd0\xce\xc4");
        let error = encode("中🙂", &gbk()).unwrap_err();
        assert_eq!(error.kind, "unrepresentable");
        assert_eq!(error.position, Some(1));
        assert_eq!(error.character.as_deref(), Some("🙂"));
        let result = request(
            "text.serialize",
            json!({"content":"中🙂","sourceFormat":gbk()}),
        )
        .unwrap();
        assert_eq!(result["kind"], "unrepresentable");
        assert!(result.get("bytesBase64").is_none());
    }
    #[test]
    fn raw_noop_and_local_edits_preserve_nonbijective_gbk_and_mixed_endings() {
        let bytes = b"\xa3\xa0\r\nold\nlast\r";
        let (text, format) = decode(bytes, Some("gbk"), None).unwrap();
        assert_ne!(encode(&text, &format).unwrap(), bytes);
        assert_eq!(
            serialize(
                &normalize(&text),
                Some(bytes),
                Some(&format),
                None,
                true,
                None
            )
            .unwrap()
            .0,
            bytes
        );
        let changed = normalize(&text).replace("old", "新");
        let (bytes, format) = serialize(
            &changed,
            Some(bytes),
            Some(&format),
            None,
            true,
            Some(&[Edit {
                start: 2,
                end: 5,
                text: "新".into(),
            }]),
        )
        .unwrap();
        assert_eq!(bytes, b"\xa3\xa0\r\n\xd0\xc2\nlast\r");
        assert_eq!(format.line_ending, "mixed");
    }
    #[test]
    fn bom_is_metadata_only_at_the_physical_start_and_utf16_write_is_real() {
        for encoding in ["utf-8", "utf-16le", "utf-16be"] {
            let format = Format {
                encoding: encoding.into(),
                bom: true,
                ..gbk()
            };
            let text = "\u{feff}中🙂e\u{301}\r\n";
            let bytes = encode(text, &format).unwrap();
            let (decoded, resolved) = decode(&bytes, None, None).unwrap();
            assert_eq!(decoded, text);
            assert!(resolved.bom);
            assert_eq!(
                serialize(text, Some(&bytes), Some(&resolved), None, false, None)
                    .unwrap()
                    .0,
                bytes
            );
            let mut no_bom = format;
            no_bom.bom = false;
            assert_eq!(
                decode(&encode(text, &no_bom).unwrap(), Some(encoding), None)
                    .unwrap()
                    .0,
                "中🙂e\u{301}\r\n"
            );
        }
    }
    #[test]
    fn range_pages_follow_raw_gbk_boundaries_and_keep_raw_mode_exact() {
        let bytes = b"\xd6\xd0\xce\xc4\r\n\xd0\xc2\n";
        let mut cursor = std::io::Cursor::new(bytes);
        let format = stream::probe(&mut cursor, &json!({"encoding":"gbk"}), &|| Ok(()))
            .unwrap()
            .unwrap();
        let a = stream::page(
            &mut cursor,
            bytes.len() as u64,
            &json!({"offset":1,"length":1}),
            Ok(format.clone()),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(a["text"], "中");
        assert_eq!(a["offset"], 0);
        assert_eq!(a["nextOffset"], 2);
        let b = stream::page(
            &mut cursor,
            bytes.len() as u64,
            &json!({"offset":2,"length":1}),
            Ok(format.clone()),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(b["text"], "文");
        assert_eq!(b["nextOffset"], 4);
        let line = stream::page(
            &mut cursor,
            bytes.len() as u64,
            &json!({"startLine":2,"endLine":2}),
            Ok(format.clone()),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(line["text"], "新\n");
        assert_eq!(line["offset"], 6);
        let raw = stream::page(
            &mut cursor,
            bytes.len() as u64,
            &json!({"offset":1,"length":1,"raw":true}),
            Ok(format),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(
            STANDARD
                .decode(raw["bytesBase64"].as_str().unwrap())
                .unwrap(),
            [0xd0]
        );
    }
    #[test]
    fn streamed_probe_does_not_lock_ascii_prefix_and_formats_are_host_independent() {
        let mut probe = Probe::new();
        for byte in b"ascii\n\xd6\xd0\xce\xc4" {
            probe.push(&[*byte]);
        }
        assert_eq!(probe.finish(None, None).unwrap().encoding, "gbk");
        let policy = Policy {
            choice_revisions: None,
            default_encoding: Some("utf-8".into()),
            files: Some(std::collections::BTreeMap::from([
                ("src/".into(), "gbk".into()),
                ("src/new/".into(), "utf-8".into()),
                ("src/new/x".into(), "gbk".into()),
            ])),
            root: Some("/original".into()),
        };
        assert_eq!(policy.encoding("/original/src/old/a"), Some("gbk"));
        assert_eq!(policy.encoding("src/new/a"), Some("utf-8"));
        assert_eq!(policy.encoding("src/new/x"), Some("gbk"));
    }
    #[test]
    fn structure_ranges_distinguish_unicode_offsets_from_raw_bytes() {
        let bytes = b"//\xd6\xd0\nhello";
        let (text, format) = decode(bytes, Some("gbk"), None).unwrap();
        let mut value = json!({"range":{"startByte":6,"endByte":11}});
        locate_structure_ranges(&mut value, bytes, &text, &format).unwrap();
        assert_eq!(value["range"]["startByte"], 6);
        assert_eq!(value["range"]["sourceStartByte"], 5);
        assert_eq!(value["range"]["sourceEndByte"], 10);
    }
    #[test]
    fn separated_replacements_preserve_middle_raw_aliases_and_eol() {
        let original = b"old\r\n\xa3\xa0keep\nlast\r";
        let (old, format) = decode(original, Some("gbk"), None).unwrap();
        let new = normalize(&old)
            .replace("old", "new")
            .replace("last", "done");
        let (bytes, _) = serialize(&new, Some(original), Some(&format), None, true, None).unwrap();
        assert_eq!(bytes, b"new\r\n\xa3\xa0keep\ndone\r");
    }
    #[test]
    fn format_only_conversion_preserves_each_original_line_ending() {
        let original = b"a\r\nb\nc\r";
        let (_, format) = decode(original, None, None).unwrap();
        for encoding in ["utf-8", "utf-16le", "gbk"] {
            let target = TargetFormat {
                encoding: Some(encoding.into()),
                bom: Some(encoding != "gbk"),
                line_ending: None,
            };
            let (bytes, actual) = serialize(
                "a\nb\nc\n",
                Some(original),
                Some(&format),
                Some(&target),
                true,
                Some(&[]),
            )
            .unwrap();
            assert_eq!(
                decode(&bytes, Some(encoding), None).unwrap().0,
                "a\r\nb\nc\r"
            );
            assert_eq!(actual.line_ending, "mixed");
        }
    }
    #[test]
    fn utf16_default_is_prior_not_ascii_override_and_new_files_get_a_bom() {
        for encoding in ["utf-16le", "UTF_16BE"] {
            let (_, format) = decode(&[], None, Some(encoding)).unwrap();
            assert!(format.encoding.starts_with("utf-16"));
            assert_eq!(decode(b"abcd", None, Some(encoding)).unwrap().0, "abcd");
            assert_eq!(
                decode(b"abcd", None, Some(encoding)).unwrap().1.encoding,
                "utf-8"
            );
            let (bytes, _) = serialize("a中\n", None, Some(&format), None, false, None).unwrap();
            assert_eq!(decode(&bytes, None, None).unwrap().0, "a中\n");
            assert!(decode(&bytes, None, None).unwrap().1.bom);
            let explicit = TargetFormat {
                encoding: Some(encoding.into()),
                bom: None,
                line_ending: None,
            };
            let (bytes, _) = serialize("new", None, None, Some(&explicit), false, None).unwrap();
            assert!(decode(&bytes, None, None).unwrap().1.bom);
            let utf8 = TargetFormat {
                encoding: Some("utf-8".into()),
                bom: None,
                line_ending: None,
            };
            let (bytes, _) =
                serialize("new", None, Some(&format), Some(&utf8), false, None).unwrap();
            assert_eq!(bytes, b"new");

            let no_bom = TargetFormat {
                encoding: None,
                bom: Some(false),
                line_ending: None,
            };
            let (bytes, _) =
                serialize("a中\n", None, Some(&format), Some(&no_bom), false, None).unwrap();
            let mut reader = std::io::Cursor::new(&bytes);
            let params = json!({"encoding":encoding,"raw":true,"startLine":1,"endLine":1});
            let resolved = stream::probe(&mut reader, &params, &|| Ok(())).unwrap();
            let page = stream::page(&mut reader, bytes.len() as u64, &params, resolved, &|| {
                Ok(())
            })
            .unwrap();
            assert_eq!(
                STANDARD
                    .decode(page["bytesBase64"].as_str().unwrap())
                    .unwrap(),
                bytes
            );
            assert!(page.get("text").is_none());
        }
    }
    #[test]
    fn raw_lines_never_turn_undecodable_ranges_into_whole_file_reads() {
        let mut reader = std::io::Cursor::new(b"\xff\xff\xff");
        assert!(stream::page(
            &mut reader,
            3,
            &json!({"raw":true,"startLine":2,"endLine":2}),
            Err(Failure::invalid("invalid")),
            &|| Ok(())
        )
        .is_err());
        let policy = Policy {
            choice_revisions: None,
            root: Some("/source".into()),
            default_encoding: Some("gbk".into()),
            files: Some(std::collections::BTreeMap::from([(
                "./".into(),
                "gbk".into(),
            )])),
        };
        assert_eq!(policy.encoding("/other/a"), None);
        assert_eq!(policy.encoding("/source/../other/a"), None);
        assert_eq!(policy.encoding("../other/a"), None);
        assert_eq!(policy.default_for("/other/a"), None);
        assert_eq!(policy.encoding("/source/a"), Some("gbk"));
        let policy = Policy {
            choice_revisions: None,
            root: Some("C:/Root".into()),
            files: Some(std::collections::BTreeMap::from([(
                "src/".into(),
                "gbk".into(),
            )])),
            default_encoding: None,
        };
        assert_eq!(policy.encoding("c:\\ROOT\\SRC\\a"), Some("gbk"));
    }
    #[test]
    #[ignore = "explicit 10 MiB range cost probe; reports hash, codec and page costs separately"]
    fn ten_mib_range_cost_probe() {
        use sha2::{Digest, Sha256};
        use std::io::{Read, Seek, SeekFrom};
        struct Counted {
            inner: std::io::Cursor<Vec<u8>>,
            read: u64,
        }
        impl Read for Counted {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                let n = self.inner.read(b)?;
                self.read += n as u64;
                Ok(n)
            }
        }
        impl Seek for Counted {
            fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
                self.inner.seek(p)
            }
        }
        for (encoding, unit) in [
            ("utf-8", "中文a\n".as_bytes()),
            ("gbk", b"\xd6\xd0\xce\xc4a\n".as_slice()),
        ] {
            let raw = unit.repeat((10 * 1024 * 1024) / unit.len());
            let total = raw.len() as u64;
            let begin = std::time::Instant::now();
            let _ = Sha256::digest(&raw);
            let hash_us = begin.elapsed().as_micros();
            let mut reader = Counted {
                inner: std::io::Cursor::new(raw),
                read: 0,
            };
            let begin = std::time::Instant::now();
            let format = stream::probe(&mut reader, &json!({}), &|| Ok(()))
                .unwrap()
                .unwrap();
            let probe_us = begin.elapsed().as_micros();
            let probe_bytes = reader.read;
            assert_eq!(format.encoding, encoding);
            let mut measurements = Vec::new();
            for offset in [0, total - 4096, total - 2048] {
                reader.read = 0;
                let begin = std::time::Instant::now();
                let page = stream::page(
                    &mut reader,
                    total,
                    &json!({"offset":offset,"length":1024}),
                    Ok(format.clone()),
                    &|| Ok(()),
                )
                .unwrap();
                measurements.push((offset, begin.elapsed().as_micros(), reader.read));
                assert!(page["text"].as_str().unwrap().len() < 4096);
                if encoding == "utf-8" {
                    assert!(reader.read <= 8200);
                } else if offset > 0 {
                    assert!(reader.read >= offset);
                }
            }
            eprintln!("range-probe encoding={encoding} raw_bytes={total} hash_us={hash_us} codec_probe_us={probe_us} codec_probe_bytes={probe_bytes} pages(offset,us,read_bytes)={measurements:?}");
        }
    }
    #[test]
    fn explicit_utf16_endianness_is_not_overwritten_by_a_conflicting_bom() {
        let bytes = b"\xff\xfe\xd8\x00\x41\x00";
        assert_eq!(decode(bytes, None, None).unwrap().0, "ØA");
        assert!(decode(bytes, Some("utf-16be"), None).is_err());
        let mut reader = std::io::Cursor::new(bytes);
        let params = json!({"encoding":"utf-16be","startLine":1,"endLine":1});
        let probe = stream::probe(&mut reader, &params, &|| Ok(())).unwrap();
        assert!(probe.is_err());
        assert!(stream::page(&mut reader, bytes.len() as u64, &params, probe, &|| Ok(())).is_err());
    }
    #[test]
    fn explicit_ambiguous_journal_basis_keeps_utf16_edits_and_raw_bytes() {
        let raw = "中文".as_bytes();
        let (old, format) = decode(raw, Some("gbk"), None).unwrap();
        assert_eq!(old.encode_utf16().count(), 3);
        let (written, _) = serialize(
            &format!("{old}!"),
            Some(raw),
            Some(&format),
            None,
            true,
            Some(&[Edit {
                start: 3,
                end: 3,
                text: "!".into(),
            }]),
        )
        .unwrap();
        assert_eq!(written, [raw, b"!"].concat());
    }
}
