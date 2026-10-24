//! Readable tool projection. Native protocol/terminal readers retain exact spool bytes.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode { #[default] Text, Raw }

pub(crate) fn code_page() -> Option<u32> {
    #[cfg(windows)] { Some(unsafe { windows_sys::Win32::Globalization::GetOEMCP() }) }
    #[cfg(not(windows))] { None }
}

pub(crate) fn validate_encoding(label: Option<&str>) -> Result<(), String> {
    if let Some(label) = label.filter(|label| *label != "auto") {
        if Encoding::for_label(label.as_bytes()).is_none() {
            return Err(format!("Unsupported text encoding {label:?}; use an Encoding Standard label such as utf-8, gbk, shift_jis or utf-16le, or mode: raw for original bytes."));
        }
    }
    Ok(())
}

fn readable(text: &str) -> bool {
    !text.chars().any(|c| c == '\0' || c.is_control() && !matches!(c, '\n'|'\r'|'\t'|'\x08'|'\x1b'|'\x07'|'\x0c'))
}

fn code_page_encoding(page: u32) -> Option<&'static Encoding> {
    match page {
        65001 => Some(encoding_rs::UTF_8), 936 => Some(encoding_rs::GBK),
        932 => Some(encoding_rs::SHIFT_JIS), 949 => Some(encoding_rs::EUC_KR), 950 => Some(encoding_rs::BIG5),
        866 => Some(encoding_rs::IBM866), 874 => Some(encoding_rs::WINDOWS_874),
        1250..=1258 => Encoding::for_label(format!("windows-{page}").as_bytes()), _ => None,
    }
}
fn windows_text(bytes: &[u8], page: u32) -> Option<String> {
    // A remote Windows process can be observed by a Linux/macOS coordinator.
    // Decode common codepages from the source hint without consulting this Host's locale.
    if let Some(encoding) = code_page_encoding(page) {
        let (text, _, errors) = encoding.decode(bytes);
        return (!errors && readable(&text)).then(|| text.into_owned());
    }
    #[cfg(windows)] {
        use windows_sys::Win32::Globalization::{MultiByteToWideChar, MB_ERR_INVALID_CHARS};
        let count = i32::try_from(bytes.len()).ok()?;
        let length = unsafe { MultiByteToWideChar(page, MB_ERR_INVALID_CHARS, bytes.as_ptr(), count, std::ptr::null_mut(), 0) };
        if length <= 0 { return None; }
        let mut wide = vec![0; length as usize];
        if unsafe { MultiByteToWideChar(page, MB_ERR_INVALID_CHARS, bytes.as_ptr(), count, wide.as_mut_ptr(), length) } != length { return None; }
        String::from_utf16(&wide).ok().filter(|text| readable(text))
    }
    #[cfg(not(windows))] { let _ = (bytes, page); None }
}

// Presentation strips terminal controls; it never changes offsets or the retained spool.
fn plain(text: &str) -> String {
    let mut chars = text.chars().peekable(); let mut result = String::new();
    while let Some(c) = chars.next() {
        if c != '\x1b' { if c != '\x07' { result.push(c); } continue; }
        match chars.next() {
            Some('[') => { for c in chars.by_ref() { if ('@'..='~').contains(&c) { break; } } }
            Some(']'|'P'|'_'|'^') => { while let Some(c) = chars.next() { if c == '\x07' { break; } if c == '\x1b' && chars.peek() == Some(&'\\') { chars.next(); break; } } }
            Some('('|')'|'*'|'+') => { chars.next(); }
            _ => {}
        }
    }
    result
}

/// Explains the existing exit and output facts of one observation together. Exit and output
/// completion are independent: only `outputComplete` proves no further bytes will be appended.
pub(crate) fn output_state(value: &Value) -> Option<Value> {
    let process = &value["process"];
    let field = |name: &str| if value.get(name).is_some_and(|v| !v.is_null()) { &value[name] } else { &process[name] };
    let status = process["status"].as_str()?;
    let more = matches!((value["nextCursor"].as_u64(), value["endCursor"].as_u64()), (Some(next), Some(end)) if next < end);
    let (kind, note) = if field("outputError").as_str().is_some_and(|error| !error.is_empty()) {
        ("output_error", "The retained output is incomplete or unreadable; the process status above is reported independently.")
    } else if field("outputComplete") == true {
        ("complete", if more { "Output is complete; more retained bytes follow nextCursor." } else { "Output is complete; no further bytes will be appended." })
    } else if matches!(status, "exited" | "failed") {
        ("finishing", "The process has exited and its output is still being drained. Read again from nextCursor, or wait until outputComplete is true.")
    } else if process["writerActive"] == true || matches!(status, "starting" | "running") {
        ("running", "The process is running; more output may follow.")
    } else {
        ("unknown", "Whether more output will follow is not yet known; read again from nextCursor.")
    };
    Some(json!({"kind":kind,"note":note}))
}

pub(crate) fn project(value: &mut Value, mode: &Mode, label: Option<&str>) {
    if let Some(state) = output_state(value) { value["outputState"] = state; }
    let process = &value["process"];
    let page = process["outputCodePage"].as_u64().and_then(|v| u32::try_from(v).ok());
    let pty = process["mode"] == "pty";
    let explicit = label.filter(|label| *label != "auto").and_then(|label| Encoding::for_label(label.as_bytes()));
    let Some(chunks) = value["chunks"].as_array_mut() else { return; };
    for chunk in chunks {
        let Some(fields) = chunk.as_object_mut() else { continue; };
        if matches!(mode, Mode::Raw) { fields.remove("text"); fields.insert("encoding".into(), json!("base64")); continue; }
        let Some(bytes) = fields.get("bytesBase64").and_then(Value::as_str).and_then(|s| BASE64.decode(s).ok()) else { continue; };
        let bom = Encoding::for_bom(&bytes).map(|(encoding, _)| encoding);
        let selected = explicit.or(bom);
        let decoded = if let Some(encoding) = selected {
            let (text, _, errors) = encoding.decode(&bytes);
            (!errors && readable(&text)).then(|| (text.into_owned(), encoding.name().to_lowercase(), if explicit.is_some() {"requested"} else {"bom"}))
        } else if let Ok(text) = std::str::from_utf8(&bytes) {
            readable(text).then(|| (text.into(), "utf-8".into(), "utf8"))
        } else if !pty {
            // A page beginning inside a UTF-8 character cannot be distinguished
            // from a legacy codepage just by guessing. Keep that page lossless.
            let boundary = fields.get("offset").and_then(Value::as_u64).unwrap_or(0) > 0
                && bytes.first().is_some_and(|b| b & 0xc0 == 0x80);
            if boundary { None } else { page.and_then(|page| windows_text(&bytes, page).map(|text| (text,
                code_page_encoding(page).map_or_else(||format!("cp{page}"),|encoding|encoding.name().to_lowercase()), "system_code_page"))) }
        } else { None };
        if let Some((text, encoding, source)) = decoded {
            fields.insert("text".into(), json!(plain(&text)));
            fields.insert("encoding".into(), json!(encoding));
            fields.insert("encodingSource".into(), json!(source));
            fields.remove("bytesBase64"); fields.remove("encodingReason");
        } else {
            fields.remove("text");
            fields.insert("encodingReason".into(), json!("No lossless text decoding was established for this byte page. For known text, repeat process_read at this cursor with encoding (for example gbk or utf-16le). mode: raw always returns exact bytes."));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exit_and_output_completion_stay_distinct_facts() {
        let state = |value: Value| output_state(&value).unwrap()["kind"].as_str().unwrap().to_owned();
        assert_eq!(state(json!({"process":{"status":"running","writerActive":true},"outputComplete":false,"nextCursor":4,"endCursor":4})), "running");
        // Reading to the current end of the spool is not proof that no bytes remain.
        assert_eq!(state(json!({"process":{"status":"exited","writerActive":false},"outputComplete":false,"nextCursor":4,"endCursor":4})), "finishing");
        assert_eq!(state(json!({"process":{"status":"exited","writerActive":false},"outputComplete":true,"nextCursor":4,"endCursor":4})), "complete");
        assert_eq!(state(json!({"process":{"status":"exited","outputComplete":true}})), "complete");
        assert_eq!(state(json!({"process":{"status":"exited"},"outputComplete":false,"outputError":"spool unreadable"})), "output_error");
        assert!(output_state(&json!({"chunks":[]})).is_none());
    }
    fn output(bytes: &[u8]) -> Value { json!({"process":{"mode":"pipe","outputCodePage":936},"nextCursor":bytes.len(),"chunks":[{"offset":0,"bytesBase64":BASE64.encode(bytes),"encoding":"base64"}]}) }
    #[test]
    fn text_projection_preserves_cursor_and_raw_mode_preserves_bytes() {
        let bytes = b"\x1b[31merror\x1b[0m\n"; let raw = output(bytes);
        let mut shown=raw.clone(); project(&mut shown,&Mode::Text,None);
        assert_eq!(shown["chunks"][0]["text"],"error\n"); assert!(shown["chunks"][0].get("bytesBase64").is_none());
        assert_eq!(shown["nextCursor"],bytes.len());
        let mut exact=raw; project(&mut exact,&Mode::Raw,None);
        assert_eq!(BASE64.decode(exact["chunks"][0]["bytesBase64"].as_str().unwrap()).unwrap(),bytes);
        let mut binary=output(b"\0\x01\xff");project(&mut binary,&Mode::Text,None);assert!(binary["chunks"][0].get("text").is_none());
    }
    #[test]
    fn explicit_codepage_and_bom_decode_without_replacement() {
        let (bytes,_,_) = encoding_rs::GBK.encode("中文错误"); let mut value=output(&bytes);
        project(&mut value,&Mode::Text,Some("gbk"));assert_eq!(value["chunks"][0]["text"],"中文错误");
        assert_eq!(value["chunks"][0]["encodingSource"],"requested");
        let mut utf16=output(&[0xff,0xfe,0x2d,0x4e,0x87,0x65]);project(&mut utf16,&Mode::Text,None);assert_eq!(utf16["chunks"][0]["text"],"中文");
        let mut automatic=output(&bytes); project(&mut automatic,&Mode::Text,None);assert_eq!(automatic["chunks"][0]["text"],"中文错误");
    }
}
