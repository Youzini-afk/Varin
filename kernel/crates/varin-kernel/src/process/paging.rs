//! Disposable, channel-local text projections of the one raw spool. A character belongs
//! to the page containing its final raw byte, even if another channel intervened.
use super::*;
use encoding_rs::{Decoder, DecoderResult, Encoding};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Boundaries(HashMap<String, ProjectionIndex>);
#[derive(Default)]
struct ProjectionIndex {
    checkpoints: BTreeMap<u64, [ChannelSnapshot; 2]>,
    recent: Option<Projection>,
}
#[derive(Clone, Default)]
struct ChannelSnapshot {
    started: bool,
    encoding: Option<&'static Encoding>,
    source: &'static str,
    pending: Vec<(u64, u8)>,
    ended: bool,
}
struct Channel {
    state: ChannelSnapshot,
    decoder: Option<Decoder>,
    scratch: String,
}
impl Channel {
    fn restore(state: ChannelSnapshot) -> Self {
        let mut decoder = state.encoding.map(Encoding::new_decoder_without_bom_handling);
        if state.started {
            if let Some(decoder) = &mut decoder {
                let pending = state.pending.iter().map(|(_, byte)| *byte).collect::<Vec<_>>();
                let mut ignored = String::with_capacity(32);
                let _ = decoder.decode_to_string_without_replacement(&pending, &mut ignored, false);
            }
        }
        Self { state, decoder, scratch: String::with_capacity(128) }
    }
    fn select(&mut self, encoding: &'static Encoding, source: &'static str) {
        self.state.encoding = Some(encoding);
        self.state.source = source;
        self.decoder = Some(encoding.new_decoder_without_bom_handling());
    }
}
struct Projection {
    cursor: u64,
    channels: [Channel; 2],
}
impl Projection {
    fn restore(cursor: u64, state: [ChannelSnapshot; 2]) -> Self {
        Self { cursor, channels: state.map(Channel::restore) }
    }
    fn snapshot(&self) -> Option<[ChannelSnapshot; 2]> {
        // Stateful escape codecs keep their actual decoder in the sequential projection.
        // Random access replays from the start, rather than inventing a restart state.
        if self.channels.iter().any(|c| c.state.encoding == Some(encoding_rs::ISO_2022_JP)) { return None; }
        Some(std::array::from_fn(|i| self.channels[i].state.clone()))
    }
}
struct Selection {
    explicit: Option<&'static Encoding>,
    source: &'static str,
    fallback: Option<&'static Encoding>,
}
impl Selection {
    fn automatic(&self, bytes: &[u8]) -> (&'static Encoding, &'static str) {
        let line = bytes.split_inclusive(|byte| *byte == b'\n').next().unwrap_or(bytes);
        let utf8 = std::str::from_utf8(line);
        if utf8.is_ok() || utf8.is_err_and(|error| error.error_len().is_none() && error.valid_up_to() > 0
            && !line[..error.valid_up_to()].is_ascii()) { return (encoding_rs::UTF_8, "utf8"); }
        if let Some(legacy) = self.fallback.filter(|encoding| *encoding != encoding_rs::UTF_8) {
            // A complete GBK prompt may also be an unfinished UTF-8 prefix. Choose now
            // when the source hint explains it; do not wait indefinitely for a newline.
            if legacy.decode_without_bom_handling_and_without_replacement(line).is_some() {
                return (legacy, "system_code_page");
            }
            if std::str::from_utf8(line).is_err_and(|error| error.error_len().is_some()) {
                return (legacy, "system_code_page");
            }
        }
        (encoding_rs::UTF_8, "utf8")
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRange { offset: u64, byte_length: u64 }
struct Piece {
    channel: usize,
    encoding: &'static Encoding,
    source: &'static str,
    text: Option<String>,
    raw: Vec<u8>,
    ranges: Vec<SourceRange>,
}
impl Piece {
    fn value(self) -> Value {
        let mut value = json!({"channel":if self.channel == 0 { "stdout" } else { "stderr" },
            "offset":self.ranges[0].offset,"byteLength":self.raw.len(),"sourceRanges":self.ranges,
            "bytesBase64":BASE64.encode(self.raw),"encoding":self.encoding.name().to_lowercase(),"encodingSource":self.source});
        if let Some(text) = self.text { value["text"] = json!(text); }
        else {
            value["rawAvailable"] = json!(true);
            value["encodingReason"] = json!("This channel contains invalid or incomplete encoded bytes. Original bytes remain available in mode: raw.");
        }
        value
    }
}
fn emit(channel: usize, state: &mut ChannelSnapshot, text: Option<&str>, cursor: u64, chunks: &mut Vec<Piece>) {
    let Some(&(last, _)) = state.pending.last() else { return; };
    if last < cursor { state.pending.clear(); return; }
    let encoding = state.encoding.unwrap_or(encoding_rs::UTF_8);
    let join = chunks.last().is_some_and(|previous| previous.channel == channel
        && previous.encoding == encoding && previous.source == state.source && previous.text.is_some() && text.is_some());
    if !join {
        chunks.push(Piece { channel, encoding, source:state.source, text:text.map(|_|String::new()), raw: Vec::new(), ranges:Vec::new() });
    }
    let piece = chunks.last_mut().unwrap();
    if let (Some(previous), Some(text)) = (piece.text.as_mut(), text) { previous.push_str(text); }
    for (offset, byte) in state.pending.drain(..) {
        piece.raw.push(byte);
        if let Some(range) = piece.ranges.last_mut().filter(|range| range.offset + range.byte_length == offset) { range.byte_length += 1; }
        else { piece.ranges.push(SourceRange { offset, byte_length:1 }); }
    }
}

fn malformed(channel: &mut Channel, which: usize, bad: u8, after: u8, observed_at: u64, cursor: u64, chunks: &mut Vec<Piece>) {
    let tail = channel.state.pending.len().saturating_sub(after as usize);
    let suffix = channel.state.pending.split_off(tail);
    let start = channel.state.pending.len().saturating_sub(bad as usize);
    let invalid = channel.state.pending.split_off(start);
    if !channel.scratch.is_empty() { emit(which, &mut channel.state, Some(&channel.scratch), cursor, chunks); }
    else { channel.state.pending.clear(); }
    channel.state.pending = invalid;
    // Discovery may require a later byte than the invalid unit itself. Report its
    // actual source range even when that range precedes the requested raw cursor.
    if observed_at >= cursor { emit(which, &mut channel.state, None, 0, chunks); }
    else { channel.state.pending.clear(); }
    channel.state.pending = suffix;
}
fn decode_byte(channel: &mut Channel, which: usize, offset: u64, byte: u8, cursor: u64, chunks: &mut Vec<Piece>) {
    let source = [byte];
    let mut consumed_byte = false;
    loop {
        channel.scratch.clear();
        let input = if consumed_byte { &[][..] } else { &source[..] };
        let (result, consumed) = channel.decoder.as_mut().expect("selected channel codec")
            .decode_to_string_without_replacement(input, &mut channel.scratch, false);
        if consumed > 0 { channel.state.pending.push((offset, byte)); consumed_byte = true; }
        match result {
            DecoderResult::Malformed(bad, after) => {
                malformed(channel, which, bad, after, offset, cursor, chunks);
                // Retain the decoder: bytes_after can contain an already consumed
                // valid code unit (e.g. UTF-16 high surrogate followed by 'A').
                // Drain buffered output before submitting another raw byte.
            }
            _ => {
                if !channel.scratch.is_empty() { emit(which, &mut channel.state, Some(&channel.scratch), cursor, chunks); }
                if consumed_byte { break; }
            }
        }
    }
}
fn decode_ascii(channel: &mut Channel, which: usize, offset: u64, bytes: &[u8], cursor: u64, chunks: &mut Vec<Piece>) {
    channel.scratch.clear();
    channel.scratch.reserve(bytes.len() + 32);
    let (result, consumed) = channel.decoder.as_mut().unwrap()
        .decode_to_string_without_replacement(bytes, &mut channel.scratch, false);
    debug_assert_eq!(result, DecoderResult::InputEmpty);
    debug_assert_eq!(consumed, bytes.len());
    // Replay builds decoder state but must not re-emit already consumed characters.
    let skip = usize::try_from(cursor.saturating_sub(offset)).unwrap_or(usize::MAX).min(bytes.len());
    channel.state.pending.extend(bytes[skip..].iter().enumerate().map(|(i, byte)| (offset + (skip + i) as u64, *byte)));
    emit(which, &mut channel.state, Some(&channel.scratch[skip..]), cursor, chunks);
}
fn feed(channel: &mut Channel, which: usize, offset: u64, byte: u8, lookahead: &[u8], automatic: (&'static Encoding, &'static str), selection: &Selection, cursor: u64, chunks: &mut Vec<Piece>) {
    if !channel.state.started {
        channel.state.pending.push((offset, byte));
        let initial = channel.state.pending.iter().map(|(_, byte)| *byte).collect::<Vec<_>>();
        let boms: [&[u8]; 3] = [&[0xef, 0xbb, 0xbf], &[0xff, 0xfe], &[0xfe, 0xff]];
        if boms.iter().any(|bom| bom.starts_with(&initial) && bom.len() > initial.len()) { return; }
        channel.state.started = true;
        if let Some((encoding, _)) = Encoding::for_bom(&initial) {
            let selected = selection.explicit.unwrap_or(encoding);
            channel.select(selected, if selection.explicit.is_some() { selection.source } else { "bom" });
            if selected == encoding { channel.state.pending.clear(); return; }
        }
        let pending = std::mem::take(&mut channel.state.pending);
        let mut sample = initial;
        sample.extend_from_slice(lookahead.get(1..).unwrap_or_default());
        if channel.decoder.is_none() {
            let (encoding, source) = selection.explicit.map(|encoding| (encoding, selection.source)).unwrap_or_else(|| selection.automatic(&sample));
            channel.select(encoding, source);
        }
        for (offset, byte) in pending { decode_byte(channel, which, offset, byte, cursor, chunks); }
        return;
    }
    if channel.state.pending.is_empty() && selection.explicit.is_none() && channel.state.source != "bom"
        && channel.state.encoding != Some(encoding_rs::ISO_2022_JP) {
        let (encoding, source) = automatic;
        if channel.state.encoding != Some(encoding) { channel.select(encoding, source); }
        else { channel.state.source = source; }
    }
    decode_byte(channel, which, offset, byte, cursor, chunks);
}
fn finish(channel: &mut Channel, which: usize, offset: u64, cursor: u64, chunks: &mut Vec<Piece>) {
    if channel.state.ended { return; }
    channel.state.ended = true;
    if channel.decoder.is_some() {
        loop {
            channel.scratch.clear();
            let (result, _) = channel.decoder.as_mut().unwrap().decode_to_string_without_replacement(&[], &mut channel.scratch, true);
            if let DecoderResult::Malformed(bad, after) = result {
                malformed(channel, which, bad, after, offset, cursor, chunks);
                continue;
            }
            if !channel.scratch.is_empty() { emit(which, &mut channel.state, Some(&channel.scratch), cursor, chunks); }
            channel.state.pending.clear();
            break;
        }
    }
    if !channel.state.pending.is_empty() {
        if offset >= cursor { emit(which, &mut channel.state, None, 0, chunks); }
        else { channel.state.pending.clear(); }
    }
}

pub(super) fn read(live: &OutputHandle, cursor: u64, limit: usize, label: Option<&str>, record: &Value) -> Result<Value, KernelError> {
    let label = label.or_else(|| record["outputEncoding"].as_str());
    super::text::validate_encoding(label).map_err(failure)?;
    let pty = record["mode"] == "pty";
    let explicit = label.filter(|label| !label.eq_ignore_ascii_case("auto")).and_then(|label| Encoding::for_label(label.as_bytes()))
        .or_else(|| pty.then_some(encoding_rs::UTF_8));
    let source = if label.is_some_and(|label| !label.eq_ignore_ascii_case("auto")) { "requested" } else { "pty_utf8" };
    let fallback = (!pty).then(|| record["outputCodePage"].as_u64()).flatten()
        .and_then(|page| u32::try_from(page).ok()).and_then(super::text::code_page_encoding);
    let selection = Selection { explicit, source, fallback };
    let mut page = read_output(live, cursor, limit)?;
    let target = page["nextCursor"].as_u64().unwrap();
    let mut cache = live.shared.text_pages.lock().map_err(|_| failure("text projection poisoned"))?;
    let index = cache.0.entry(format!("{}:{}", explicit.map_or("auto", Encoding::name), fallback.map_or("", Encoding::name))).or_default();
    let mut state = if index.recent.as_ref().is_some_and(|state| state.cursor == cursor) {
        index.recent.take().unwrap()
    } else {
        let (offset, channels) = index.checkpoints.range(..=cursor).next_back().map(|(offset, channels)| (*offset, channels.clone()))
            .unwrap_or_else(|| (0, Default::default()));
        Projection::restore(offset, channels)
    };
    let mut chunks = Vec::new();
    while state.cursor < target {
        // Lookahead uses only already-retained bytes, never waits on a producer.
        // It helps Auto preserve UTF-8/legacy line detection across small pages.
        let raw = read_output(live, state.cursor, CHUNK_BYTES + 4)?;
        let mut samples: [Vec<u8>; 2] = Default::default();
        let frames = raw["chunks"].as_array().unwrap().iter().map(|chunk| {
            let which = usize::from(chunk["channel"] == "stderr");
            let bytes = BASE64.decode(chunk["bytesBase64"].as_str().unwrap()).expect("spool base64");
            let sample_offset = samples[which].len();
            samples[which].extend_from_slice(&bytes);
            (which, chunk["offset"].as_u64().unwrap(), bytes, sample_offset)
        }).collect::<Vec<_>>();
        let hints: [Vec<(usize, &'static Encoding, &'static str)>; 2] = std::array::from_fn(|which| {
            if let Some(encoding) = selection.explicit { return vec![(samples[which].len(), encoding, selection.source)]; }
            let mut offset = 0;
            samples[which].split_inclusive(|byte| *byte == b'\n').map(|line| {
                offset += line.len();
                let pending = &state.channels[which].state.pending;
                let first = offset == line.len();
                let (encoding, source) = if first && !pending.is_empty() {
                    let mut joined = pending.iter().map(|(_, byte)| *byte).collect::<Vec<_>>();
                    joined.extend_from_slice(line);
                    selection.automatic(&joined)
                } else { selection.automatic(line) };
                (offset, encoding, source)
            }).collect()
        });
        let mut hint_indices = [0usize; 2];
        for (which, offset, bytes, sample_offset) in frames {
            let length = bytes.len().min(target.saturating_sub(offset) as usize);
            let mut i = 0;
            while i < length {
                while hints[which][hint_indices[which]].0 <= sample_offset + i { hint_indices[which] += 1; }
                let (hint_end, encoding, source) = hints[which][hint_indices[which]];
                let channel = &mut state.channels[which];
                if channel.state.started && channel.state.pending.is_empty() && selection.explicit.is_none()
                    && channel.state.source != "bom" && channel.state.encoding != Some(encoding_rs::ISO_2022_JP) {
                    if channel.state.encoding != Some(encoding) { channel.select(encoding, source); }
                    else { channel.state.source = source; }
                }
                let ascii_codec = channel.state.encoding.is_some_and(|encoding| encoding.is_ascii_compatible() && encoding != encoding_rs::ISO_2022_JP);
                if channel.state.started && channel.state.pending.is_empty() && ascii_codec && bytes[i].is_ascii() {
                    let checkpoint_distance = CHUNK_BYTES - (offset as usize + i) % CHUNK_BYTES;
                    let max = (length - i).min(checkpoint_distance).min(hint_end - sample_offset - i);
                    let count = bytes[i..i + max].iter().position(|byte| !byte.is_ascii()).unwrap_or(max);
                    decode_ascii(channel, which, offset + i as u64, &bytes[i..i + count], cursor, &mut chunks);
                    i += count;
                } else {
                    feed(channel, which, offset + i as u64, bytes[i], &samples[which][sample_offset + i..], (encoding, source), &selection, cursor, &mut chunks);
                    i += 1;
                }
                state.cursor = offset + i as u64;
                if state.cursor % CHUNK_BYTES as u64 == 0 {
                    if let Some(snapshot) = state.snapshot() { index.checkpoints.insert(state.cursor, snapshot); }
                }
            }
        }
    }
    for which in 0..2 {
        let channel = if which == 0 { "stdout" } else { "stderr" };
        let ended = page["channelEnds"].as_array().and_then(|ends| ends.iter().find(|end| end["channel"] == channel))
            .and_then(|end| end["offset"].as_u64()).filter(|offset| *offset <= target)
            .or_else(|| (page["outputComplete"] == true && target == page["endCursor"].as_u64().unwrap()).then_some(target));
        if let Some(offset) = ended { finish(&mut state.channels[which], which, offset, cursor, &mut chunks); }
    }
    // A zero-byte EOF can diagnose a previously consumed partial unit. Keep that
    // observation repeatable at the same raw cursor by rebuilding its failed tail.
    index.recent = if chunks.iter().any(|piece| piece.text.is_none()) { None } else { Some(state) };
    page["chunks"] = json!(chunks.into_iter().map(Piece::value).collect::<Vec<_>>());
    page["textProjected"] = json!(true);
    page["requestedCursor"] = json!(cursor);
    page["actualCursor"] = json!(cursor);
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spool() -> OutputHandle {
        let output_path = std::env::temp_dir().join(format!("varin-text-stream-{}", uuid::Uuid::new_v4()));
        File::create(&output_path).unwrap();
        OutputHandle { shared: Arc::new(Shared::new()), output_path }
    }
    fn append(handle: &OutputHandle, channel: u8, bytes: &[u8]) {
        let mut file = OpenOptions::new().append(true).open(&handle.output_path).unwrap();
        file.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
        file.write_all(&[channel]).unwrap();
        file.write_all(bytes).unwrap();
        let mut buffer = handle.shared.lock();
        buffer.file_end = file.metadata().unwrap().len();
        buffer.end += bytes.len() as u64;
        if bytes.is_empty() { let offset = buffer.end; buffer.channel_ends.push(channel_end(channel, offset)); }
    }
    fn read_page(handle: &OutputHandle, cursor: u64, count: usize, encoding: &str) -> Value {
        read(handle, cursor, count, Some(encoding), &json!({"mode":"pipe","outputCodePage":936})).unwrap()
    }
    fn text(page: &Value) -> String {
        page["chunks"].as_array().unwrap().iter().filter_map(|chunk|chunk["text"].as_str()).collect()
    }
    #[test]
    fn one_byte_pages_keep_channel_decoder_state_and_exact_cross_fragment_sources() {
        for (encoding, bytes, expected) in [("utf-8", "中🙂".as_bytes().to_vec(), "中🙂"),
            ("gbk", vec![0xd6, 0xd0, 0xce, 0xc4], "中文"),
            ("utf-16le", "中🙂".encode_utf16().flat_map(u16::to_le_bytes).collect(), "中🙂")] {
            let handle = spool();
            let mut cursor = 0;
            let mut stdout = String::new();
            for (i, byte) in bytes.iter().enumerate() {
                append(&handle, 1, &[*byte]);
                let page = read_page(&handle, cursor, 1, encoding);
                assert_eq!(page["nextCursor"], cursor + 1);
                stdout.push_str(&text(&page));
                cursor += 1;
                if i == 0 {
                    // Use the same selected codec for both channels, but separate byte state.
                    let stderr = if encoding == "utf-16le" { vec![b'!', 0] } else { vec![b'!'] };
                    append(&handle, 2, &stderr);
                    let page = read_page(&handle, cursor, stderr.len(), encoding);
                    assert_eq!(text(&page), "!");
                    assert_eq!(page["chunks"][0]["channel"], "stderr");
                    cursor += stderr.len() as u64;
                }
            }
            assert_eq!(stdout, expected);
            let reread = read_page(&handle, 0, cursor as usize, encoding);
            let mut channels = [String::new(), String::new()];
            for chunk in reread["chunks"].as_array().unwrap() {
                channels[usize::from(chunk["channel"] == "stderr")].push_str(chunk["text"].as_str().unwrap());
            }
            assert_eq!(channels, [expected.to_owned(), "!".into()]);
            let source = reread["chunks"].as_array().unwrap().iter().find(|chunk|chunk["channel"] == "stdout").unwrap();
            assert!(source["sourceRanges"].as_array().unwrap().len() >= 2);
            // A mid-character reconnect uses raw cursor, not UTF-8 string length.
            let suffix = read_page(&handle, cursor - 1, 1, encoding);
            assert!(!text(&suffix).is_empty());
            let original = read_output(&handle, 0, cursor as usize).unwrap();
            assert_eq!(original["nextCursor"], cursor);
            std::fs::remove_file(handle.output_path).unwrap();
        }
    }
    #[test]
    fn malformed_utf16_keeps_already_consumed_valid_suffix_across_channels_and_pages() {
        let handle = spool();
        let mut stdout = String::new();
        let mut cursor = 0;
        for (i, byte) in [0x00, 0xd8, 0x41, 0x00, 0x42, 0x00].into_iter().enumerate() {
            append(&handle, 1, &[byte]);
            let page = read_page(&handle, cursor, 1, "utf-16le");
            stdout.push_str(&text(&page));
            cursor += 1;
            if i == 2 {
                append(&handle, 2, &[0x21, 0]);
                assert_eq!(text(&read_page(&handle, cursor, 2, "utf-16le")), "!");
                cursor += 2;
            }
        }
        assert_eq!(stdout, "AB");
        let replay = read_page(&handle, 0, cursor as usize, "utf-16le");
        assert_eq!(text(&replay), "!AB");
        let invalid = replay["chunks"].as_array().unwrap().iter().find(|chunk| chunk["rawAvailable"] == true).unwrap();
        assert_eq!(invalid["sourceRanges"], json!([{"offset":0,"byteLength":2}]));
        let valid = replay["chunks"].as_array().unwrap().iter().find(|chunk| chunk["text"] == "AB").unwrap();
        assert_eq!(valid["sourceRanges"], json!([{"offset":2,"byteLength":1},{"offset":5,"byteLength":3}]));
        std::fs::remove_file(handle.output_path).unwrap();
    }
    #[test]
    fn bom_is_channel_local_and_body_feff_is_not_stripped() {
        let handle = spool();
        append(&handle, 2, b"err");
        for byte in "\u{feff}中\u{feff}文".as_bytes() { append(&handle, 1, &[*byte]); }
        let mut actual = String::new();
        let end = handle.shared.lock().end;
        for cursor in 0..end {
            actual.push_str(&text(&read_page(&handle, cursor, 1, "utf-8")));
        }
        assert_eq!(actual, "err中\u{feff}文");
        std::fs::remove_file(handle.output_path).unwrap();
    }
    #[test]
    fn exit_does_not_flush_a_channel_and_ordered_eof_does() {
        let handle = spool();
        append(&handle, 1, &[0xe4]);
        handle.shared.lock().receipt = Some(json!({"status":"exited"}));
        let page = read_page(&handle, 0, 1, "utf-8");
        assert!(page["chunks"].as_array().unwrap().is_empty());
        append(&handle, 2, b"!");
        assert_eq!(text(&read_page(&handle, 1, 1, "utf-8")), "!");
        append(&handle, 0x81, &[]);
        let ended = read_page(&handle, 2, 1, "utf-8");
        assert_eq!(ended["nextCursor"], 2);
        assert_eq!(ended["channelEnds"][0]["offset"], 2);
        assert_eq!(ended["chunks"][0]["rawAvailable"], true);
        assert!(ended["chunks"][0].get("text").is_none());
        assert_eq!(read_page(&handle, 2, 1, "utf-8"), ended);
        append(&handle, 2, b"later");
        assert_eq!(text(&read_page(&handle, 2, 5, "utf-8")), "later");
        assert_eq!(read_output(&handle, 0, 32).unwrap()["nextCursor"], 7);
        std::fs::remove_file(handle.output_path).unwrap();
    }
    #[test]
    fn auto_returns_an_ambiguous_complete_gbk_prompt_without_waiting_for_newline() {
        let handle = spool();
        append(&handle, 1, &[0xe4, 0xb8]);
        let page = read_page(&handle, 0, 2, "auto");
        assert_eq!(page["nextCursor"], 2);
        assert_eq!(text(&page), encoding_rs::GBK.decode(&[0xe4, 0xb8]).0);
        assert_eq!(page["chunks"][0]["encodingSource"], "system_code_page");
        assert_eq!(page["outputComplete"], false);
        std::fs::remove_file(handle.output_path).unwrap();
    }
    #[test]
    fn legacy_terminal_subscription_keeps_raw_bytes_and_native_ansi_text_together() {
        let handle = spool();
        let (send, receive) = mpsc::sync_channel(16);
        let subscriptions = subscriptions::ProcessSubscriptions::new(send);
        subscriptions.subscribe("view", "process", "grant", "epoch", 0,
            json!({"mode":"pty","outputEncoding":"gbk","writerActive":true}), "grant".into(), handle.clone(), false).unwrap();
        let raw = [b"\x1b[31m".as_slice(), &[0xd6, 0xd0, 0xce, 0xc4], b"\x1b[0m".as_slice()].concat();
        let mut projected = String::new();
        let mut retained = Vec::new();
        for (offset, byte) in raw.iter().enumerate() {
            append(&handle, 1, &[*byte]);
            { let _guard = handle.shared.lock(); handle.shared.notify(); }
            loop {
                let frame = receive.recv_timeout(Duration::from_secs(2)).unwrap();
                let stream = frame["stream"].as_str().unwrap();
                if stream == "data" {
                    assert_eq!(frame["result"]["nextCursor"], offset + 1);
                    for chunk in frame["result"]["chunks"].as_array().unwrap() {
                        retained.extend(BASE64.decode(chunk["bytesBase64"].as_str().unwrap()).unwrap());
                    }
                    for chunk in frame["result"]["textChunks"].as_array().unwrap() {
                        projected.push_str(chunk["text"].as_str().unwrap());
                    }
                }
                subscriptions.ack("view", "grant", "epoch", stream, frame["sequence"].as_u64().unwrap()).unwrap();
                if stream == "data" { break; }
            }
        }
        subscriptions.unsubscribe("view", "grant", "epoch").unwrap();
        assert_eq!(retained, raw);
        assert_eq!(projected, "\x1b[31m中文\x1b[0m");
        std::fs::remove_file(handle.output_path).unwrap();
    }
    #[test]
    #[ignore = "sequential spool projection performance probe"]
    fn sequential_projection_throughput() {
        for (encoding, block) in [("utf-8", b"ordinary ASCII process output\n".to_vec()),
            ("utf-8", "中文 process output 🙂\n".as_bytes().to_vec()),
            ("gbk", encoding_rs::GBK.encode("中文 process output\n").0.into_owned())] {
            let handle = spool();
            let raw = block.repeat((10 * 1024 * 1024) / block.len());
            for bytes in raw.chunks(CHUNK_BYTES) { append(&handle, 1, bytes); }
            handle.shared.lock().output_closed = true;
            let started = Instant::now();
            let mut cursor = 0;
            let mut length = 0;
            while cursor < raw.len() as u64 {
                let page = read_page(&handle, cursor, CHUNK_BYTES, encoding);
                cursor = page["nextCursor"].as_u64().unwrap();
                length += text(&page).len();
            }
            assert!(length > 0);
            eprintln!("sequential projection {encoding} {} raw bytes, {} text bytes: {:?}", raw.len(), length, started.elapsed());
            std::fs::remove_file(handle.output_path).unwrap();
        }
    }

}
