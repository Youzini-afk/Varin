//! Validate the owned self-relative descriptor before any platform API can follow
//! its offsets. The same wire bytes may be stored on a different Host platform.
use crate::error::KernelError;

pub(crate) fn validate(bytes: &[u8]) -> Result<(), KernelError> {
    fn invalid() -> KernelError {
        KernelError::Operation("Invalid self-relative security descriptor".into())
    }
    fn sid(bytes: &[u8], start: usize) -> Result<(), KernelError> {
        let header = bytes
            .get(start..start.checked_add(8).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        if header[0] != 1 || header[1] > 15 {
            return Err(invalid());
        }
        bytes
            .get(start..start + 8 + usize::from(header[1]) * 4)
            .ok_or_else(invalid)?;
        Ok(())
    }
    if bytes.len() < 20 || bytes[0] != 1 || u16::from_le_bytes([bytes[2], bytes[3]]) & 0x8000 == 0 {
        return Err(invalid());
    }
    for field in [4, 8, 12, 16] {
        let start = u32::from_le_bytes(bytes[field..field + 4].try_into().unwrap()) as usize;
        if start == 0 {
            continue;
        }
        if start < 20 || start % 4 != 0 {
            return Err(invalid());
        }
        if field <= 8 {
            sid(bytes, start)?;
            continue;
        }
        let header = bytes
            .get(start..start.checked_add(8).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        if !matches!(header[0], 2 | 4) {
            return Err(invalid());
        }
        let size = usize::from(u16::from_le_bytes([header[2], header[3]]));
        if size < 8 {
            return Err(invalid());
        }
        let acl = bytes
            .get(start..start.checked_add(size).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        let count = u16::from_le_bytes([header[4], header[5]]);
        let mut cursor = 8;
        for _ in 0..count {
            let ace = acl.get(cursor..cursor + 4).ok_or_else(invalid)?;
            let size = usize::from(u16::from_le_bytes([ace[2], ace[3]]));
            if size < 4 || size % 4 != 0 {
                return Err(invalid());
            }
            let ace = acl.get(cursor..cursor + size).ok_or_else(invalid)?;
            let offset = match ace[0] {
                0..=3 | 9 | 10 | 13 | 14 | 17..=21 => Some(8),
                4 => Some(12),
                5..=8 | 11 | 12 | 15 | 16 => {
                    let flags = ace.get(8..12).ok_or_else(invalid)?;
                    let flags = u32::from_le_bytes(flags.try_into().unwrap());
                    Some(12 + usize::from(flags & 1 != 0) * 16 + usize::from(flags & 2 != 0) * 16)
                }
                _ => None,
            };
            if let Some(offset) = offset {
                sid(ace, offset)?;
            }
            cursor += size;
        }
    }
    #[cfg(windows)]
    if unsafe {
        windows_sys::Win32::Security::IsValidSecurityDescriptor(bytes.as_ptr().cast_mut().cast())
    } == 0
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descriptor_offsets_and_embedded_acl_lengths_are_bounded() {
        let mut bytes = vec![0; 20];
        bytes[0] = 1;
        bytes[3] = 0x80;
        assert!(validate(&bytes).is_ok());
        bytes[4..8].copy_from_slice(&20u32.to_le_bytes());
        assert!(validate(&bytes).is_err());
        bytes.extend_from_slice(&[1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]);
        assert!(validate(&bytes).is_ok());
        bytes[16..20].copy_from_slice(&32u32.to_le_bytes());
        bytes[2] = 4;
        bytes.extend_from_slice(&[2, 0, 12, 0, 1, 0, 0, 0, 0, 0, 40, 0]);
        assert!(validate(&bytes).is_err());
        bytes[36..38].copy_from_slice(&0u16.to_le_bytes());
        assert!(validate(&bytes).is_ok());
    }
}
