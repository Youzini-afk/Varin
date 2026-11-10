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
    Ok(probe.finish(
        params["encoding"].as_str(),
        params["defaultEncoding"].as_str(),
    ))
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
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    let mut actual_start = None;
    let mut actual_end = if start < skip { skip } else { start };
    let mut line = 1u64;
    let mut last_line = None;
    let mut previous_cr = false;
    let mut since_check = 0;
    while position < total {
        if since_check >= 128 * 1024 {
            check()?;
            since_check = 0;
        }
        let at = position;
        let mut unit = [0u8; 4];
        reader.read_exact(&mut unit[..1])?;
        let n = if enc == UTF_8 {
            if unit[0] < 0x80 {
                1
            } else if unit[0] < 0xe0 {
                2
            } else if unit[0] < 0xf0 {
                3
            } else {
                4
            }
        } else if enc == GBK {
            if (0x81..=0xfe).contains(&unit[0]) {
                2
            } else {
                1
            }
        } else {
            reader.read_exact(&mut unit[1..2])?;
            let u = if enc == UTF_16LE {
                u16::from_le_bytes([unit[0], unit[1]])
            } else {
                u16::from_be_bytes([unit[0], unit[1]])
            };
            if (0xd800..=0xdbff).contains(&u) {
                4
            } else {
                2
            }
        };
        let already = if enc == UTF_16LE || enc == UTF_16BE {
            2
        } else {
            1
        };
        if n > already {
            reader.read_exact(&mut unit[already..n])?;
        }
        position += n as u64;
        since_check += n;
        let scalar = if first.is_some() {
            enc.decode_without_bom_handling_and_without_replacement(&unit[..n])
                .ok_or_else(|| {
                    KernelError::Operation(
                        "Text changed or contains an invalid character boundary".into(),
                    )
                })?
                .chars()
                .next()
        } else {
            None
        };
        if previous_cr && scalar != Some('\n') {
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
            bytes.extend_from_slice(&unit[..n]);
            if bytes.len() > crate::protocol::MAX_BLOB_RESPONSE_BYTES && first.is_some() {
                return Err(KernelError::Operation("Requested lines exceed one response frame; request fewer lines or use a byte range".into()));
            }
        }
        if scalar == Some('\n') {
            line = line.saturating_add(1);
            previous_cr = false;
        } else if scalar == Some('\r') {
            previous_cr = true;
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
    if bytes.is_empty() {
        actual_end = if first.is_some() { total } else { end };
    }
    let text = enc
        .decode_without_bom_handling_and_without_replacement(&bytes)
        .ok_or_else(|| {
            KernelError::Operation("Selected text range changed encoding boundaries".into())
        })?;
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
