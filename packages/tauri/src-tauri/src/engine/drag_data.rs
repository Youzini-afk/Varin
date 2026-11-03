//! Decoder for Chromium's native custom-drag Pickle transport, not a new data
//! authority. Layout reference: chromium/ui/base/clipboard/custom_data_helper.cc
//! and base/pickle.cc. Only consumers choose which untrusted fields they accept.
pub fn custom_data(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Native drag metadata exceeds its memory budget".into());
    }
    let size = bytes
        .get(..4)
        .and_then(|b| b.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or("Truncated native drag metadata")? as usize;
    if size != bytes.len() - 4 {
        return Err("Native drag metadata length is invalid".into());
    }
    let mut input = &bytes[4..];
    fn integer(input: &mut &[u8]) -> Option<u32> {
        let (n, rest) = input.split_at_checked(4)?;
        *input = rest;
        Some(u32::from_le_bytes(n.try_into().ok()?))
    }
    fn string(input: &mut &[u8]) -> Option<String> {
        let units = integer(input)? as usize;
        let size = units.checked_mul(2)?;
        let padded = size.checked_add(3)? & !3;
        let (data, rest) = input.split_at_checked(padded)?;
        let value = String::from_utf16(
            &data[..size]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .ok()?;
        *input = rest;
        Some(value)
    }
    let count = integer(&mut input).ok_or("Missing native drag entry count")? as usize;
    // Each entry has two length words even when both strings are empty.
    if count > input.len() / 8 {
        return Err("Invalid native drag entry count".into());
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        let key = string(&mut input).ok_or("Invalid native drag type")?;
        let value = string(&mut input).ok_or("Invalid native drag value")?;
        entries.push((key, value));
    }
    if !input.is_empty() {
        return Err("Unexpected native drag metadata trailer".into());
    }
    Ok(entries)
}
#[cfg(test)]
mod tests {
    use super::*;
    // Chromium Pickle: 4-byte payload size, entry count, then length-prefixed
    // UTF-16LE strings, each padded to a 4-byte boundary.
    const ONE: &[u8] = &[
        24, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 120, 0, 0, 0, 4, 0, 0, 0, 47, 0, 116, 0, 109, 0, 112,
        0,
    ];
    #[test]
    fn decodes_native_wire() {
        assert_eq!(custom_data(ONE).unwrap(), vec![("x".into(), "/tmp".into())]);
    }
    #[test]
    fn rejects_every_truncation() {
        for n in 0..ONE.len() {
            assert!(custom_data(&ONE[..n]).is_err(), "accepted {n}")
        }
    }
    #[test]
    fn rejects_count_and_length_overflow() {
        let mut bad = ONE.to_vec();
        bad[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(custom_data(&bad).is_err());
        bad = ONE.to_vec();
        bad[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(custom_data(&bad).is_err());
    }
    #[test]
    fn empty_map_and_trailing_data_are_distinct() {
        assert!(custom_data(&[4, 0, 0, 0, 0, 0, 0, 0]).unwrap().is_empty());
        assert!(custom_data(&[8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
    }
}
