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

fn automatic_text(bytes: &[u8], page: Option<u32>, pty: bool, offset: u64) -> Option<(String, String, &'static str)> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return readable(text).then(|| (text.into(), "utf-8".into(), "utf8"));
    }
    if pty { return None; }
    let page = page?;
    let mut text = String::new();
    let mut utf8 = false;
    let mut legacy = false;
    // Shells and their child programs can write differently encoded lines to
    // the same pipe/read chunk. ASCII newlines delimit both UTF-8 and the legacy
    // codepages supported here; do not guess encoding switches inside a line.
    for (index, line) in bytes.split_inclusive(|byte| *byte == b'\n').enumerate() {
        if let Ok(value) = std::str::from_utf8(line) {
            if !readable(value) { return None; }
            utf8 |= !line.is_ascii();
            text.push_str(value);
        } else {
            // Keep the original page-boundary ambiguity explicit. A caller can
            // select a known encoding or reread from an earlier byte cursor.
            if index == 0 && offset > 0 && line.first().is_some_and(|byte| byte & 0xc0 == 0x80) { return None; }
            text.push_str(&windows_text(line, page)?);
            legacy = true;
        }
    }
    if utf8 && legacy { Some((text, "mixed".into(), "line_detection")) }
    else { Some((text, code_page_encoding(page).map_or_else(|| format!("cp{page}"), |encoding| encoding.name().to_lowercase()), "system_code_page")) }
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
    if let (Some(next), Some(end), Some(chunks)) = (value["nextCursor"].as_u64(), value["endCursor"].as_u64(), value["chunks"].as_array()) {
        let returned: u64 = chunks.iter().filter_map(|chunk| chunk["byteLength"].as_u64()).sum();
        let unread = end.saturating_sub(next);
        value["outputSummary"] = json!({"returnedBytes":returned,"retainedBytes":end,
            "unreadBytes":unread,"nextCursor":next,
            "message":format!("Read a {returned}-byte page; {end} bytes retained at this observation, {unread} bytes remain after cursor {next}. {}",
                if unread > 0 {"Continue with process_read using nextCursor."} else if value["outputComplete"] == true {"Output is complete."} else {"The output may still grow."})});
    }
    let process = &value["process"];
    let process_id = process["processId"].as_str().or_else(|| value["processId"].as_str()).map(str::to_owned);
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
        } else { automatic_text(&bytes, page, pty, fields.get("offset").and_then(Value::as_u64).unwrap_or(0)) };
        let mut raw_available = false;
        if let Some((text, encoding, source)) = decoded {
            fields.insert("text".into(), json!(plain(&text)));
            fields.insert("encoding".into(), json!(encoding));
            fields.insert("encodingSource".into(), json!(source));
            fields.remove("bytesBase64"); fields.remove("encodingReason");
            if source == "line_detection" {
                fields.insert("encodingReason".into(), json!("Output contains UTF-8 lines and lines decoded with the process code-page hint. Encoding was selected per line; use encoding to override a known encoding or mode: raw for the original bytes."));
                raw_available = true;
            }
        } else {
            fields.remove("text");
            fields.remove("bytesBase64");
            fields.insert("encodingReason".into(), json!("This output page could not be decoded losslessly (mixed encodings, binary data, or a split character). Original bytes remain in the process output. Read this page with mode: raw to obtain base64, or specify encoding if the page uses one known encoding."));
            raw_available = true;
        }
        if raw_available {
            fields.insert("rawAvailable".into(), json!(true));
            if let Some(id) = &process_id {
                fields.insert("rawRead".into(), json!({"tool":"process_read","arguments":{
                    "processId":id,"cursor":fields.get("offset"),"maxBytes":bytes.len(),"mode":"raw"}}));
            }
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
    #[test]
    fn mixed_pipe_lines_are_readable_and_keep_the_original_byte_cursor() {
        let (legacy, _, _) = encoding_rs::GBK.encode("活动代码页: 936\r\n");
        let bytes = [legacy.as_ref(), "UTF-8 输出：体检通过 ✓ 🚀\n".as_bytes()].concat();
        let mut value = output(&bytes);
        value["process"]["processId"] = json!("mixed-output");
        let raw = value.clone();
        project(&mut value, &Mode::Text, None);
        assert_eq!(value["chunks"][0]["text"], "活动代码页: 936\r\nUTF-8 输出：体检通过 ✓ 🚀\n");
        assert_eq!(value["chunks"][0]["encoding"], "mixed");
        assert_eq!(value["chunks"][0]["encodingSource"], "line_detection");
        assert_eq!(value["nextCursor"], bytes.len());
        assert_eq!(value["chunks"][0]["rawRead"]["arguments"]["maxBytes"], bytes.len());
        let mut exact = raw;
        project(&mut exact, &Mode::Raw, None);
        assert_eq!(BASE64.decode(exact["chunks"][0]["bytesBase64"].as_str().unwrap()).unwrap(), bytes);
    }
    #[test]
    fn explicit_encoding_recovers_legacy_pipe_output_with_a_utf8_session_hint() {
        let (bytes, _, _) = encoding_rs::GBK.encode("中文错误\n");
        let mut original = output(&bytes);
        original["process"]["outputCodePage"] = json!(65001);
        let mut automatic = original.clone();
        project(&mut automatic, &Mode::Text, None);
        assert!(automatic["chunks"][0].get("text").is_none());
        assert_eq!(automatic["chunks"][0]["rawAvailable"], true);
        project(&mut original, &Mode::Text, Some("gbk"));
        assert_eq!(original["chunks"][0]["text"], "中文错误\n");
        assert_eq!(original["chunks"][0]["encodingSource"], "requested");
        let mut boundary = output(&"中".as_bytes()[1..]);
        boundary["chunks"][0]["offset"] = json!(1);
        project(&mut boundary, &Mode::Text, None);
        assert!(boundary["chunks"][0].get("text").is_none());
    }
    #[test]
    fn unread_bytes_and_undecodable_output_have_actionable_summaries() {
        let mut value = output(b"\0\x01\xff");
        value["process"]["processId"] = json!("original-process");
        value["chunks"][0]["byteLength"] = json!(3);
        value["endCursor"] = json!(100);
        let raw = value.clone();
        project(&mut value, &Mode::Text, None);
        assert_eq!(value["outputSummary"]["unreadBytes"], 97);
        assert_eq!(value["outputSummary"]["returnedBytes"], 3);
        assert!(value["chunks"][0].get("bytesBase64").is_none());
        assert_eq!(value["chunks"][0]["rawRead"]["arguments"], json!({"processId":"original-process","cursor":0,"maxBytes":3,"mode":"raw"}));
        let mut exact = raw;
        project(&mut exact, &Mode::Raw, None);
        assert_eq!(BASE64.decode(exact["chunks"][0]["bytesBase64"].as_str().unwrap()).unwrap(), b"\0\x01\xff");
    }
}
