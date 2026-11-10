//! Bounded file pages. Legacy byte boundaries are discovered from a known
//! boundary, not by pretending GBK trail bytes are UTF-8 continuations.
use super::*;
use std::io::{BufReader, Read, Seek, SeekFrom};

pub(crate) fn probe<R: Read + Seek + ?Sized>(
    reader: &mut R,
    params: &Value,
    check: &impl Fn() -> Result<(), KernelError>,
) -> Result<Result<Format, Failure>, KernelError> {
    reader.seek(SeekFrom::Start(0))?;
    let mut probe = Probe::with_encoding(
        params["encoding"].as_str(),
        params["defaultEncoding"].as_str(),
    );
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check()?;
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        probe.push(&buffer[..n]);
    }
    let format = probe.finish(
        params["encoding"].as_str(),
        params["defaultEncoding"].as_str(),
    );
    validate(reader, format, check)
}

/// Complete strict validation of the actual chosen codec, with bounded memory.
/// No sample or successful range read authorizes overwriting malformed bytes.
pub(crate) fn validate<R: Read + Seek + ?Sized>(
    reader: &mut R,
    format: Result<Format, Failure>,
    check: &impl Fn() -> Result<(), KernelError>,
) -> Result<Result<Format, Failure>, KernelError> {
    let format = match format {
        Ok(f) => f,
        Err(e) => return Ok(Err(e)),
    };
    if !matches!(format.source.as_str(), "detected" | "declaration") {
        return Ok(Ok(format));
    }
    let mut validation = Validation::new(&format.encoding).map_err(Failure::kernel)?;
    reader.seek(SeekFrom::Start(0))?;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check()?;
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        validation.push(&buffer[..n], false);
    }
    validation.push(&[], true);
    Ok(validation.format(format.encoding, format.bom, &format.source))
}

/// A decoder emission owns a raw interval, rather than assuming one byte unit
/// always yields one scalar (Big5 can yield two). The same decoder stays alive
/// across ISO-2022 escape sequences and page boundaries.
pub(super) struct Unit {
    pub start: usize,
    pub end: usize,
    bytes: [u8; 32],
    length: usize,
}
impl Unit {
    pub fn text(&self) -> &str {
        std::str::from_utf8(&self.bytes[..self.length]).expect("decoder UTF-8")
    }
}
pub(super) struct Units<R: Read> {
    reader: BufReader<R>,
    decoder: encoding_rs::Decoder,
    profile: ByteProfile,
    label: String,
    position: usize,
    start: usize,
    finished: bool,
    since_check: usize,
    utf8: bool,
}
impl<R: Read> Units<R> {
    pub fn new(reader: R, label: &str, start: usize) -> Result<Self, Failure> {
        Ok(Self {
            reader: BufReader::new(reader),
            decoder: codec(label)?.new_decoder_without_bom_handling(),
            profile: ByteProfile::new(label),
            label: label.into(),
            position: start,
            start,
            finished: false,
            since_check: 0,
            utf8: codec(label)? == UTF_8,
        })
    }
    pub fn next(
        &mut self,
        check: &impl Fn() -> Result<(), KernelError>,
    ) -> Result<Option<Unit>, KernelError> {
        while !self.finished {
            if self.since_check >= 128 * 1024 {
                check()?;
                self.since_check = 0;
            }
            let mut byte = [0u8; 1];
            let n = self.reader.read(&mut byte)?;
            self.finished = n == 0;
            // Validated UTF-8 keeps its cheap local-boundary path. Other codecs
            // use the continuous decoder, never a guessed byte-width table.
            if self.utf8 {
                if self.finished {
                    return Ok(None);
                }
                let width = match byte[0] {
                    0..=0x7f => 1,
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf4 => 4,
                    _ => return Err(KernelError::Operation("Invalid UTF-8 boundary".into())),
                };
                let mut bytes = [0u8; 32];
                bytes[0] = byte[0];
                self.reader.read_exact(&mut bytes[1..width])?;
                std::str::from_utf8(&bytes[..width])
                    .map_err(|_| KernelError::Operation("Invalid UTF-8 character".into()))?;
                let start = self.position;
                self.position += width;
                self.start = self.position;
                self.since_check += width;
                return Ok(Some(Unit {
                    start,
                    end: self.position,
                    bytes,
                    length: width,
                }));
            }
            self.profile.push(&byte[..n]);
            let mut output = [0u8; 32];
            let (result, read, written) = self.decoder.decode_to_utf8_without_replacement(
                &byte[..n],
                &mut output,
                self.finished,
            );
            self.position += read;
            self.since_check += read;
            if matches!(result, DecoderResult::Malformed(..))
                || !self.profile.valid
                || (self.finished && !self.profile.finish())
            {
                return Err(KernelError::Operation(format!(
                    "File is not valid {} text",
                    self.label
                )));
            }
            if matches!(result, DecoderResult::OutputFull) || read != n {
                return Err(KernelError::Operation(
                    "Text decoder made incomplete scalar progress".into(),
                ));
            }
            if written > 0 {
                let mut unit = Unit {
                    start: self.start,
                    end: self.position,
                    bytes: output,
                    length: written,
                };
                if self.label == "gb2312-strict" {
                    if let Cow::Owned(text) = codecs::profile_text(unit.text(), &self.label) {
                        unit.length = text.len();
                        unit.bytes[..text.len()].copy_from_slice(text.as_bytes());
                    }
                }
                self.start = self.position;
                return Ok(Some(unit));
            }
        }
        Ok(None)
    }
}

pub(crate) fn page<R: Read + Seek + ?Sized>(
    reader: &mut R,
    total: u64,
    params: &Value,
    format: Result<Format, Failure>,
    check: &impl Fn() -> Result<(), KernelError>,
) -> Result<Value, KernelError> {
    let start = params["offset"].as_u64().unwrap_or(0).min(total);
    let end = start
        .saturating_add(params["length"].as_u64().unwrap_or(total - start))
        .min(total);
    if params["raw"] == true && params["startLine"].is_u64() && format.is_ok() {
        let mut selected = params.clone();
        selected.as_object_mut().unwrap().remove("raw");
        let mut value = page(reader, total, &selected, format, check)?;
        let offset = value["offset"].as_u64().unwrap();
        let end = value["nextOffset"].as_u64().unwrap();
        reader.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; (end - offset) as usize];
        reader.read_exact(&mut bytes)?;
        value.as_object_mut().unwrap().remove("text");
        value.as_object_mut().unwrap().remove("format");
        value["bytesBase64"] = json!(STANDARD.encode(bytes));
        value["encoding"] = json!("base64");
        return Ok(value);
    }
    if params["raw"] == true || format.is_err() {
        if params["startLine"].is_u64() {
            return Err(KernelError::Operation("Cannot locate text lines in uninterpretable bytes; use an explicit encoding or an offset/length raw range".into()));
        }
        reader.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; (end - start) as usize];
        for part in bytes.chunks_mut(128 * 1024) {
            check()?;
            reader.read_exact(part)?;
        }
        let mut value = json!({"byteLength":total,"offset":start,"nextOffset":end,"returnedBytes":end-start,"eof":end>=total,"bytesBase64":STANDARD.encode(bytes),"encoding":"base64"});
        if let Err(error) = format {
            value["textError"] = error.value();
        }
        return Ok(value);
    }
    let format = format.unwrap();
    let enc = codec(&format.encoding).map_err(Failure::kernel)?;
    let first = params["startLine"].as_u64();
    let last = params["endLine"].as_u64().unwrap_or(u64::MAX);
    let skip = if format.bom {
        marker(enc).len() as u64
    } else {
        0
    };
    let mut position = skip;
    // UTF-8 can start in a tiny local window. GBK and UTF-16 use a known
    // boundary and bounded BufReader, so overlapping lead/trail ranges are safe.
    if first.is_none() && enc == UTF_8 && start > skip {
        position = start.saturating_sub(3).max(skip);
        reader.seek(SeekFrom::Start(position))?;
        let mut b = [0u8; 1];
        while position < start {
            reader.read_exact(&mut b)?;
            if b[0] & 0xc0 != 0x80 {
                reader.seek(SeekFrom::Start(position))?;
                break;
            }
            position += 1;
        }
    } else {
        reader.seek(SeekFrom::Start(position))?;
    }
    let mut units =
        Units::new(reader, &format.encoding, position as usize).map_err(Failure::kernel)?;
    let mut text = String::new();
    let mut actual_start = None;
    let mut actual_end = if start < skip { skip } else { start };
    let mut line = 1u64;
    let mut last_line = None;
    let mut previous_cr = false;
    while let Some(unit) = units.next(check)? {
        let at = unit.start as u64;
        position = unit.end as u64;
        if previous_cr && !unit.text().starts_with('\n') {
            line = line.saturating_add(1);
            previous_cr = false;
        }
        let selected = if let Some(first) = first {
            line >= first && line <= last
        } else {
            start < end && position > start && at < end
        };
        if selected {
            actual_start.get_or_insert(if at == skip && start == 0 { 0 } else { at });
            actual_end = position;
            last_line = Some(line);
            text.push_str(unit.text());
            if text.len() > crate::protocol::MAX_BLOB_RESPONSE_BYTES {
                return Err(KernelError::Operation("Requested text exceeds one response frame; request fewer lines or a smaller byte range".into()));
            }
        }
        for scalar in unit.text().chars() {
            if scalar == '\n' {
                line = line.saturating_add(1);
                previous_cr = false;
            } else if scalar == '\r' {
                previous_cr = true;
            }
        }
        if first.is_some() {
            if line > last {
                break;
            }
        } else if position >= end {
            break;
        }
    }
    check()?;
    let actual_start = actual_start.unwrap_or(if first.is_some() { total } else { start });
    if text.is_empty() {
        actual_end = if first.is_some() { total } else { end };
    }
    // Trailing state reset bytes belong to EOF, not to an empty extra page.
    if units.finished && actual_end == position {
        actual_end = total;
    }
    let mut result = json!({"byteLength":total,"offset":actual_start,"nextOffset":actual_end,"returnedBytes":actual_end-actual_start,"eof":actual_end>=total,"text":text,"format":format});
    if let Some(first) = first {
        result["startLine"] = json!(first);
        result["endLine"] = json!(last_line);
        result["nextLine"] = json!(if actual_end < total {
            last_line.map(|n| n + 1)
        } else {
            None
        });
    }
    Ok(result)
}
