//! Text pages use byte cursors too, but start/end on losslessly decoded characters.
//! Sparse seek checkpoints are disposable metadata over the original spool.
use super::*;
use encoding_rs::Encoding;
use std::collections::BTreeSet;

#[derive(Default)]
pub(super) struct Boundaries(HashMap<String, BoundaryIndex>);
#[derive(Default)]
struct BoundaryIndex {
    checkpoints: BTreeSet<u64>,
    recent: u64,
}

fn bytes(value: &Value) -> Option<Vec<u8>> {
    let chunks = value["chunks"].as_array()?;
    // A page crossing channels is still available unchanged. There is no basis
    // for concatenating incomplete stdout characters with stderr characters.
    let channel = chunks.first().map(|chunk| &chunk["channel"]);
    if chunks
        .iter()
        .any(|chunk| Some(&chunk["channel"]) != channel)
    {
        return None;
    }
    chunks.iter().try_fold(Vec::new(), |mut bytes, chunk| {
        bytes.extend(BASE64.decode(chunk["bytesBase64"].as_str()?).ok()?);
        Some(bytes)
    })
}

fn valid(encoding: &'static Encoding, bytes: &[u8], end: usize, automatic: bool) -> bool {
    if !automatic {
        return encoding
            .decode_without_bom_handling_and_without_replacement(&bytes[..end])
            .is_some();
    }
    let mut offset = 0;
    for line in bytes[..end].split_inclusive(|byte| *byte == b'\n') {
        let probe_end = bytes[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |length| offset + length + 1);
        let probe = &bytes[offset..probe_end];
        // Look through the requested edge before choosing this line's encoding.
        // A truncated UTF-8 suffix must not become apparently valid GBK text.
        let utf8 = match std::str::from_utf8(probe) {
            Ok(_) => true,
            Err(error) => error.error_len().is_none() && error.valid_up_to() >= line.len(),
        };
        if if utf8 {
            std::str::from_utf8(line).is_err()
        } else {
            encoding
                .decode_without_bom_handling_and_without_replacement(line)
                .is_none()
        } {
            return false;
        }
        offset += line.len();
    }
    true
}

fn prefix(
    encoding: &'static Encoding,
    bytes: &[u8],
    length: usize,
    automatic: bool,
) -> Option<usize> {
    // All stateless Encoding Standard encodings have at most four bytes per
    // character (including UTF-16 surrogate pairs and GB18030).
    (length.saturating_sub(3)..=length)
        .rev()
        .find(|end| valid(encoding, bytes, *end, automatic))
}

fn aligned(
    live: &OutputHandle,
    cursor: u64,
    limit: usize,
    encoding: &'static Encoding,
    index: &mut BoundaryIndex,
    automatic: bool,
) -> Result<Option<(u64, u64)>, KernelError> {
    // Stateful escape encodings cannot restart a decoder at a byte checkpoint.
    // Their original raw page remains available, without guessing a new state.
    if encoding == encoding_rs::ISO_2022_JP {
        return Ok(None);
    }
    let mut position = index
        .checkpoints
        .range(..=cursor)
        .next_back()
        .copied()
        .unwrap_or(0);
    if index.recent <= cursor {
        position = position.max(index.recent);
    }
    while cursor - position >= CHUNK_BYTES as u64 {
        let page = read_output(live, position, CHUNK_BYTES + 3)?;
        let Some(data) = bytes(&page) else {
            return Ok(None);
        };
        let Some(count) = prefix(encoding, &data, CHUNK_BYTES.min(data.len()), automatic)
            .filter(|count| *count > 0)
        else {
            return Ok(None);
        };
        position += count as u64;
        index.checkpoints.insert(position);
    }
    let length = (cursor - position) as usize + limit + 3;
    let page = read_output(live, position, length)?;
    let Some(data) = bytes(&page) else {
        return Ok(None);
    };
    let offset = (cursor - position) as usize;
    let Some(start) = prefix(encoding, &data, offset, automatic) else {
        return Ok(None);
    };
    let target = (start + limit).min(data.len());
    let Some(mut end) = prefix(encoding, &data, target, automatic) else {
        return Ok(None);
    };
    if end <= start {
        // maxBytes is a page target in text mode: even a one-byte target must
        // return one complete character, rather than a permanently empty page.
        let next = (target + 1..=(target + 3).min(data.len()))
            .find(|end| valid(encoding, &data, *end, automatic));
        match next {
            Some(next) => end = next,
            None if page["outputComplete"] == true => return Ok(None),
            None => end = start,
        }
    }
    index.recent = position + end as u64;
    Ok(Some((position + start as u64, position + end as u64)))
}

pub(super) fn read(
    live: &OutputHandle,
    cursor: u64,
    limit: usize,
    label: Option<&str>,
    record: &Value,
) -> Result<Value, KernelError> {
    super::text::validate_encoding(label).map_err(failure)?;
    let original = read_output(live, cursor, limit)?;
    if original["nextCursor"] == cursor {
        return Ok(original);
    }
    let explicit = label
        .filter(|label| *label != "auto")
        .and_then(|label| Encoding::for_label(label.as_bytes()));
    let first = read_output(live, 0, 4)?;
    let bom =
        bytes(&first).and_then(|bytes| Encoding::for_bom(&bytes).map(|(encoding, _)| encoding));
    let legacy = (record["mode"] != "pty")
        .then(|| record["outputCodePage"].as_u64())
        .flatten()
        .and_then(|page| u32::try_from(page).ok())
        .and_then(super::text::code_page_encoding);
    let automatic = explicit.is_none() && bom.is_none();
    let encoding = explicit.or(bom).or(legacy).unwrap_or(encoding_rs::UTF_8);
    let mut cache = live
        .shared
        .text_pages
        .lock()
        .map_err(|_| failure("text page index poisoned"))?;
    let index = cache
        .0
        .entry(format!("{}:{automatic}", encoding.name()))
        .or_default();
    if let Some((start, end)) = aligned(live, cursor, limit, encoding, index, automatic)? {
        let mut page = read_output(live, start, (end - start) as usize)?;
        page["requestedCursor"] = json!(cursor);
        page["actualCursor"] = json!(start);
        page["characterAligned"] = json!(true);
        // A BOM applies to every page, including pages after its bytes.
        if let Some(bom) = bom {
            page["textEncoding"] = json!(bom.name());
        }
        return Ok(page);
    }
    Ok(original)
}
