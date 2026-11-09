//! Derived PTY viewport. The original spool remains the output authority.
use serde_json::{json, Value};
use std::num::NonZeroU16;

pub(super) enum Screen {
    Live { parser: vt100::Parser, decoder: Option<encoding_rs::Decoder> },
    Retained(Value),
}
impl Screen {
    pub(super) fn new(rows: u16, cols: u16) -> Option<Self> {
        Self::with_encoding(rows, cols, None)
    }
    pub(super) fn with_encoding(rows: u16, cols: u16, encoding: Option<&str>) -> Option<Self> {
        let decoder = encoding.and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
            .filter(|encoding| *encoding != encoding_rs::UTF_8).map(encoding_rs::Encoding::new_decoder_with_bom_removal);
        Some(Self::Live { parser: vt100::Parser::new(NonZeroU16::new(rows)?, NonZeroU16::new(cols)?, 0), decoder })
    }
    pub(super) fn process(&mut self, bytes: &[u8]) { self.decode(bytes, false); }
    pub(super) fn finish(&mut self) { self.decode(&[], true); }
    fn decode(&mut self, bytes: &[u8], last: bool) {
        if let Self::Live { parser, decoder } = self {
            if let Some(decoder) = decoder {
                let mut text = String::with_capacity(decoder.max_utf8_buffer_length(bytes.len()).unwrap_or(bytes.len().saturating_mul(4) + 32));
                let mut offset = 0;
                loop {
                    let (result, read, _) = decoder.decode_to_string(&bytes[offset..], &mut text, last);
                    parser.process(text.as_bytes());
                    text.clear(); offset += read;
                    if result == encoding_rs::CoderResult::InputEmpty { break; }
                    text.reserve(32);
                }
            } else { parser.process(bytes); }
        }
    }
    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        if let (Self::Live { parser, .. }, Some(rows), Some(cols)) = (self, NonZeroU16::new(rows), NonZeroU16::new(cols)) {
            parser.set_size(rows, cols);
        }
    }
    pub(super) fn snapshot(&self) -> Value {
        match self {
            Self::Retained(value) => value.clone(),
            Self::Live { parser, .. } => {
                let screen = parser.screen();
                let (rows, cols) = screen.size();
                let (row, column) = screen.cursor_position();
                json!({"rows":rows.get(),"cols":cols.get(),"text":screen.contents(),
                    "cursor":{"row":row,"column":column},"alternateScreen":screen.alternate_screen()})
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redraw_resize_unicode_and_alternate_screen_keep_one_viewport() {
        let mut screen = Screen::new(8, 40).unwrap();
        screen.process(b"progress 10%\rprogress 90%\x1b[K");
        assert_eq!(screen.snapshot()["text"], "progress 90%");
        screen.process(b"\x1b[?1049h\x1b[2J\x1b[H");
        screen.process("中文 ✓".as_bytes());
        assert_eq!(screen.snapshot()["text"], "中文 ✓");
        assert_eq!(screen.snapshot()["alternateScreen"], true);
        screen.resize(5, 20);
        screen.process(b"\x1b[2J\x1b[Hnew layout");
        assert_eq!(screen.snapshot()["rows"], 5);
        assert_eq!(screen.snapshot()["cols"], 20);
        assert_eq!(screen.snapshot()["text"], "new layout");
        let retained = Screen::Retained(screen.snapshot());
        assert_eq!(retained.snapshot(), screen.snapshot());
        screen.process(b"\x1b[?1049l");
        assert_eq!(screen.snapshot()["alternateScreen"], false);
        assert!(screen.snapshot()["text"].as_str().unwrap().contains("progress 90%"));
    }
    #[test]
    fn legacy_viewport_uses_native_incremental_codec_without_changing_utf8_wire() {
        let mut screen = Screen::with_encoding(8, 40, Some("gbk")).unwrap();
        for byte in [0x1b, b'[', b'3', b'1', b'm', 0xd6, 0xd0, 0xce, 0xc4] { screen.process(&[byte]); }
        screen.finish();
        assert_eq!(screen.snapshot()["text"], "中文");
    }

}
