//! Derived PTY viewport. The original spool remains the output authority.
use serde_json::{json, Value};
use std::num::NonZeroU16;

pub(super) enum Screen {
    Live(vt100::Parser),
    Retained(Value),
}
impl Screen {
    pub(super) fn new(rows: u16, cols: u16) -> Option<Self> {
        Some(Self::Live(vt100::Parser::new(NonZeroU16::new(rows)?, NonZeroU16::new(cols)?, 0)))
    }
    pub(super) fn process(&mut self, bytes: &[u8]) {
        if let Self::Live(parser) = self { parser.process(bytes); }
    }
    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        if let (Self::Live(parser), Some(rows), Some(cols)) = (self, NonZeroU16::new(rows), NonZeroU16::new(cols)) {
            parser.set_size(rows, cols);
        }
    }
    pub(super) fn snapshot(&self) -> Value {
        match self {
            Self::Retained(value) => value.clone(),
            Self::Live(parser) => {
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
}
