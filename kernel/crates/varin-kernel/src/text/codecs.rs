//! File codec catalog. Library aliases and explicit strict profiles have one owner.
use super::*;
use encoding_rs::*;
use std::collections::HashMap;
use std::sync::OnceLock;

const ENCODINGS: &[&Encoding] = &[
    UTF_8,
    UTF_16LE,
    UTF_16BE,
    GBK,
    GB18030,
    BIG5,
    SHIFT_JIS,
    EUC_JP,
    EUC_KR,
    ISO_2022_JP,
    WINDOWS_1252,
    WINDOWS_1250,
    WINDOWS_1251,
    WINDOWS_1253,
    WINDOWS_1254,
    WINDOWS_1255,
    WINDOWS_1256,
    WINDOWS_1257,
    WINDOWS_1258,
    WINDOWS_874,
    IBM866,
    KOI8_R,
    KOI8_U,
    ISO_8859_2,
    ISO_8859_3,
    ISO_8859_4,
    ISO_8859_5,
    ISO_8859_6,
    ISO_8859_7,
    ISO_8859_8,
    ISO_8859_8_I,
    ISO_8859_10,
    ISO_8859_13,
    ISO_8859_14,
    ISO_8859_15,
    ISO_8859_16,
    MACINTOSH,
    X_MAC_CYRILLIC,
    X_USER_DEFINED,
];

pub(crate) fn codec(label: &str) -> Result<&'static Encoding, Failure> {
    let label = label.trim().to_ascii_lowercase();
    let label = match label.as_str() {
        "gb2312-strict" => "gbk",
        "cp936" | "windows-936" => "gbk",
        "cp932" | "windows-932" => "shift_jis",
        "cp949" | "windows-949" => "euc-kr",
        "cp950" | "windows-950" => "big5",
        "cp54936" => "gb18030",
        "cp65001" => "utf-8",
        "cp1200" => "utf-16le",
        "cp1201" => "utf-16be",
        "utf8" => "utf-8",
        "utf_16le" => "utf-16le",
        "utf_16be" => "utf-16be",
        other => other,
    };
    Encoding::for_label_no_replacement(label.as_bytes())
        .filter(|encoding| ENCODINGS.contains(encoding))
        .ok_or_else(|| Failure::invalid(format!("Unsupported file encoding: {label}")))
}

pub(crate) fn canonical(label: &str) -> Result<String, Failure> {
    if label.trim().eq_ignore_ascii_case("gb2312-strict") {
        return Ok("gb2312-strict".into());
    }
    Ok(name(codec(label)?))
}

pub(super) fn registry() -> Value {
    let mut entries: Vec<Value> = ENCODINGS.iter().map(|enc| json!({
        "encoding": name(enc), "label": enc.name(), "read": true, "write": true,
        "bom": !marker(enc).is_empty(), "defaultBom": **enc == *UTF_16LE || **enc == *UTF_16BE,
        "stateful": **enc == *ISO_2022_JP
    })).collect();
    entries.insert(
        5,
        json!({"encoding":"gb2312-strict","label":"GB2312 (strict)",
        "read":true,"write":true,"bom":false,"defaultBom":false,"stateful":false}),
    );
    json!(entries)
}

// Unicode's complete GB2312-80 mapping, not a GBK byte-range approximation.
// Provenance and redistribution notice are kept beside this binary table.
const GB2312: &[u8; 17672] = include_bytes!("gb2312.bin");
fn gb2312(lead: u8, trail: u8) -> Option<char> {
    if !(0xa1..=0xfe).contains(&lead) || !(0xa1..=0xfe).contains(&trail) {
        return None;
    }
    let index = ((lead as usize - 0xa1) * 94 + trail as usize - 0xa1) * 2;
    let code = u16::from_le_bytes([GB2312[index], GB2312[index + 1]]);
    (code != 0).then(|| char::from_u32(code.into()).unwrap())
}
pub(super) fn encode_gb2312(text: &str, format: &Format) -> Result<Vec<u8>, Failure> {
    static REVERSE: OnceLock<HashMap<char, [u8; 2]>> = OnceLock::new();
    let index = REVERSE.get_or_init(|| {
        let mut index = HashMap::new();
        for lead in 0xa1..=0xfe {
            for trail in 0xa1..=0xfe {
                if let Some(c) = gb2312(lead, trail) {
                    index.insert(c, [lead, trail]);
                }
            }
        }
        index
    });
    let mut result = Vec::with_capacity(text.len());
    let mut position = 0;
    for c in text.chars() {
        if c.is_ascii() {
            result.push(c as u8);
        } else if let Some(bytes) = index.get(&c) {
            result.extend_from_slice(bytes);
        } else {
            return Err(Failure {
                kind: "unrepresentable",
                message: format!(
                    "Character U+{:04X} at UTF-16 position {position} cannot be saved as {}",
                    c as u32, format.encoding
                ),
                encoding: Some(format.encoding.clone()),
                position: Some(position),
                character: Some(c.to_string()),
            });
        }
        position += c.len_utf16();
    }
    Ok(result)
}

/// GBK's library decoder deliberately accepts GB18030 sequences. Keep the
/// declared file profile honest, including while input is split across chunks.
#[derive(Default)]
pub(super) struct ByteProfile {
    strict: bool,
    gbk: bool,
    lead: Option<u8>,
    pub valid: bool,
}
impl ByteProfile {
    pub(super) fn new(label: &str) -> Self {
        Self {
            strict: label == "gb2312-strict",
            gbk: label == "gbk",
            valid: true,
            ..Self::default()
        }
    }
    pub(super) fn push(&mut self, bytes: &[u8]) {
        if !self.gbk && !self.strict {
            return;
        }
        for &b in bytes {
            if let Some(lead) = self.lead.take() {
                self.valid &= if self.strict {
                    gb2312(lead, b).is_some()
                } else {
                    (0x40..=0xfe).contains(&b) && b != 0x7f
                };
            } else if (0x81..=0xfe).contains(&b) {
                self.lead = Some(b);
            } else if b >= 0x80 && (self.strict || b != 0x80) {
                self.valid = false;
            }
        }
    }
    pub(super) fn finish(&self) -> bool {
        self.valid && self.lead.is_none()
    }
}

pub(super) fn decode_payload<'a>(bytes: &'a [u8], label: &str) -> Result<Cow<'a, str>, Failure> {
    let encoding = codec(label)?;
    let mut profile = ByteProfile::new(label);
    profile.push(bytes);
    if !profile.finish() {
        return Err(Failure::invalid(format!("File is not valid {label} text")));
    }
    if label == "gb2312-strict" {
        let mut text = String::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] < 0x80 {
                text.push(bytes[i] as char);
                i += 1;
            } else {
                text.push(gb2312(bytes[i], bytes[i + 1]).unwrap());
                i += 2;
            }
        }
        return Ok(Cow::Owned(text));
    }
    encoding
        .decode_without_bom_handling_and_without_replacement(bytes)
        .ok_or_else(|| Failure::invalid(format!("File is not valid {label} text")))
}

pub(super) fn profile_text<'a>(text: &'a str, label: &str) -> Cow<'a, str> {
    // These are the only differing assigned mappings, checked against all 7,445
    // cells in the profile test. A strict profile never admits GBK extensions.
    if label == "gb2312-strict" && text.contains(['\u{00b7}', '\u{2014}']) {
        Cow::Owned(
            text.replace('\u{00b7}', "\u{30fb}")
                .replace('\u{2014}', "\u{2015}"),
        )
    } else {
        Cow::Borrowed(text)
    }
}

/// Some legacy encoders map accepted input to different Unicode (notably
/// ISO-2022-JP half-width katakana). A successful library call must still save
/// the requested text. Compare incrementally without allocating a second body.
pub(super) fn verify_encoded_text(text: &str, bytes: &[u8], label: &str) -> Result<(), Failure> {
    let mut decoder = codec(label)?.new_decoder_without_bom_handling();
    let mut input = bytes;
    let mut position = 0;
    let mut output = [0u8; 8192];
    loop {
        let (result, read, written) =
            decoder.decode_to_utf8_without_replacement(input, &mut output, true);
        let expected = &text.as_bytes()[position..];
        if written > expected.len() || output[..written] != expected[..written] {
            let different = output[..written]
                .iter()
                .zip(expected)
                .position(|(a, b)| a != b)
                .unwrap_or(expected.len());
            let mut at = (position + different).min(text.len());
            while !text.is_char_boundary(at) {
                at -= 1;
            }
            let character = text[at..].chars().next();
            let position = text[..at].encode_utf16().count();
            return Err(Failure {
                kind: "unrepresentable",
                message: format!(
                    "Text at UTF-16 position {position} does not round-trip through {label}"
                ),
                encoding: Some(label.into()),
                position: Some(position),
                character: character.map(|c| c.to_string()),
            });
        }
        position += written;
        input = &input[read..];
        match result {
            DecoderResult::InputEmpty if position == text.len() => return Ok(()),
            DecoderResult::OutputFull => {}
            _ => {
                return Err(Failure::invalid(format!(
                    "Encoded {label} text does not match the requested content"
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_format(encoding: &str) -> Format {
        Format {
            encoding: encoding.into(),
            bom: false,
            line_ending: "lf".into(),
            default_line_ending: "lf".into(),
            source: "explicit".into(),
        }
    }
    #[test]
    fn catalog_codecs_really_read_write_and_pages_resume_at_decoder_boundaries() {
        for item in registry().as_array().unwrap() {
            let label = item["encoding"].as_str().unwrap();
            let content = match label {
                "gbk" | "gb2312-strict" => "中文\r\n工作\n",
                "gb18030" => "中文🙂𠀀\r\n工作\n",
                "big5" => "繁體中文測試\r\n工作\n",
                "shift_jis" | "euc-jp" | "iso-2022-jp" => "日本語の文章です\r\n仕事\n",
                "euc-kr" => "한국어 문서입니다\r\n작업\n",
                _ => "first\r\nsecond\n",
            };
            let bytes = encode(content, &fixture_format(label)).unwrap();
            let (text, resolved) = decode(&bytes, Some(label), None).unwrap();
            assert_eq!(text, content, "{label}");
            assert_eq!(
                serialize(content, Some(&bytes), Some(&resolved), None, false, None)
                    .unwrap()
                    .0,
                bytes,
                "{label}"
            );
            let mut reader = std::io::Cursor::new(&bytes);
            let mut offset = 0;
            let mut output = String::new();
            while offset < bytes.len() {
                let page = stream::page(
                    &mut reader,
                    bytes.len() as u64,
                    &json!({"offset":offset,"length":1}),
                    Ok(resolved.clone()),
                    &|| Ok(()),
                )
                .unwrap();
                assert!(
                    page["nextOffset"].as_u64().unwrap() > offset as u64,
                    "{label}: {page}"
                );
                output.push_str(page["text"].as_str().unwrap());
                offset = page["nextOffset"].as_u64().unwrap() as usize;
            }
            assert_eq!(output, content, "{label}");
            let lines = stream::page(
                &mut reader,
                bytes.len() as u64,
                &json!({"startLine":2,"endLine":2}),
                Ok(resolved.clone()),
                &|| Ok(()),
            )
            .unwrap();
            assert_eq!(
                lines["text"],
                content.split_once("\r\n").unwrap().1,
                "{label}"
            );
        }
    }
    #[test]
    fn strict_gb2312_and_gbk_do_not_silently_widen_to_gb18030() {
        assert_eq!(
            decode(b"\xa1\xa4\xa1\xaa", Some("gb2312-strict"), None)
                .unwrap()
                .0,
            "・―"
        );
        assert_eq!(
            decode(b"\xa1\xa4\xa1\xaa", Some("gb2312"), None).unwrap().0,
            "·—"
        );
        assert!(encode("丂", &fixture_format("gb2312-strict")).is_err());
        assert!(encode("丂", &fixture_format("gbk")).is_ok());
        let bytes = encode("𠀀", &fixture_format("gb18030")).unwrap();
        assert!(decode(&bytes, Some("gbk"), None).is_err());
        assert_eq!(decode(&bytes, Some("GB18030"), None).unwrap().0, "𠀀");
        assert_eq!(
            encode("a🙂", &fixture_format("gbk")).unwrap_err().position,
            Some(1)
        );
    }
    #[test]
    fn partial_big5_pair_edit_preserves_unrelated_nonbijective_bytes() {
        // 88 62 decodes to Ê + combining macron. A2 CC is an alternate 十 mapping.
        let bytes = b"\xa2\xcc\r\n\x88\x62\nend\r";
        let (text, format) = decode(bytes, Some("big5"), None).unwrap();
        let normalized = normalize(&text);
        let changed = normalized.replace('\u{304}', "x");
        let start = normalized.find('\u{304}').unwrap();
        let position = normalized[..start].encode_utf16().count();
        let partial = serialize(
            &changed,
            Some(bytes),
            Some(&format),
            None,
            true,
            Some(&[Edit {
                start: position,
                end: position + 1,
                text: "x".into(),
            }]),
        )
        .unwrap_err();
        assert_eq!(partial.kind, "unrepresentable");
        // Two adjacent edits inside one decoder emission form one replacement.
        let changed = normalized.replace("Ê\u{304}", "ab");
        let result = serialize(
            &changed,
            Some(bytes),
            Some(&format),
            None,
            true,
            Some(&[
                Edit {
                    start: position - 1,
                    end: position,
                    text: "a".into(),
                },
                Edit {
                    start: position,
                    end: position + 1,
                    text: "b".into(),
                },
            ]),
        )
        .unwrap()
        .0;
        assert!(result.starts_with(b"\xa2\xcc\r\n"));
        assert!(result.ends_with(b"\nend\r"));
        assert_eq!(
            normalize(&decode(&result, Some("big5"), None).unwrap().0),
            changed
        );
    }
    #[test]
    fn stateful_edits_keep_original_mixed_newlines_and_strict_encoding() {
        let bytes = encode("日本\r\n語\n最後\r", &fixture_format("iso-2022-jp")).unwrap();
        let (text, format) = decode(&bytes, Some("iso-2022-jp"), None).unwrap();
        let updated = normalize(&text).replace('語', "文");
        let bytes = serialize(&updated, Some(&bytes), Some(&format), None, true, None)
            .unwrap()
            .0;
        assert_eq!(
            decode(&bytes, Some("iso-2022-jp"), None).unwrap().0,
            "日本\r\n文\n最後\r"
        );
        assert_eq!(
            encode("ｱ", &fixture_format("iso-2022-jp"))
                .unwrap_err()
                .kind,
            "unrepresentable"
        );
    }
    #[test]
    fn detection_is_not_tied_to_chinese_and_declarations_override_guesses() {
        for (encoding,text) in [("shift_jis","これは日本語の文章です。日本語の文字コードを自動的に認識して正しく読み込みます。"),("windows-1251","Это русский текст. Проверяем правильное определение кодировки документа и сохранение исходного текста.")] {
            let bytes=encode(text,&fixture_format(encoding)).unwrap();assert_eq!(decode(&bytes,None,None).unwrap().0,text,"{encoding}");
        }
        let bytes = encode(
            "# coding: windows-1252\nCafé déjà vu",
            &fixture_format("windows-1252"),
        )
        .unwrap();
        let (_, resolved) = decode(&bytes, None, Some("gbk")).unwrap();
        assert_eq!(resolved.encoding, "windows-1252");
        assert_eq!(resolved.source, "declaration");
        assert_eq!(decode(b"\xff\xfea\0", None, Some("gbk")).unwrap().0, "a");
        assert_eq!(decode(b"\xc2\xa9", Some("CP936"), None).unwrap().0, "漏");
    }
    #[test]
    fn strict_profile_matches_every_assigned_cell_and_its_reverse() {
        let format = Format {
            encoding: "gb2312-strict".into(),
            bom: false,
            line_ending: "lf".into(),
            default_line_ending: "lf".into(),
            source: "explicit".into(),
        };
        let mut count = 0;
        for lead in 0xa1..=0xfe {
            for trail in 0xa1..=0xfe {
                if let Some(c) = gb2312(lead, trail) {
                    let bytes = [lead, trail];
                    let decoded = GBK
                        .decode_without_bom_handling_and_without_replacement(&bytes)
                        .unwrap();
                    assert_eq!(profile_text(&decoded, "gb2312-strict"), c.to_string());
                    assert_eq!(encode_gb2312(&c.to_string(), &format).unwrap(), bytes);
                    count += 1;
                }
            }
        }
        assert_eq!(count, 7445);
    }
}
