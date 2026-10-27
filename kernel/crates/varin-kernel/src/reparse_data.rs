//! Windows' REPARSE_DATA_BUFFER ABI. Keep original bytes for native round trips;
//! the decoded target supplies the same symlink namespace to the shared engine.
//! https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_reparse_data_buffer
use crate::error::KernelError;
pub(crate) const SYMLINK: u32 = 0xa000000c;
pub(crate) const MOUNT_POINT: u32 = 0xa0000003;
pub(crate) const MAXIMUM_SIZE: usize = 16 * 1024; // Windows MAXIMUM_REPARSE_DATA_BUFFER_SIZE.
pub(crate) struct Reparse {
    pub tag: u32,
    pub target: String,
}
fn invalid(message: &str) -> KernelError {
    KernelError::Operation(format!("Invalid native reparse data: {message}"))
}
fn word(bytes: &[u8], offset: usize) -> Result<u16, KernelError> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| invalid("truncated field"))?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}
fn text(bytes: &[u8], base: usize, offset: usize, length: usize) -> Result<String, KernelError> {
    if offset % 2 != 0 || length % 2 != 0 {
        return Err(invalid("unaligned UTF-16 name"));
    }
    let end = base
        .checked_add(offset)
        .and_then(|start| start.checked_add(length))
        .ok_or_else(|| invalid("name range overflow"))?;
    let bytes = bytes
        .get(base + offset..end)
        .ok_or_else(|| invalid("name extends beyond the payload"))?;
    let utf16 = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let value = String::from_utf16(&utf16)
        .map_err(|_| invalid("target is outside the current native name contract"))?;
    if value.contains('\0') {
        return Err(invalid("NUL inside the target name"));
    }
    Ok(value)
}
pub(crate) fn parse(bytes: &[u8]) -> Result<Reparse, KernelError> {
    if bytes.len() < 8 || bytes.len() > MAXIMUM_SIZE {
        return Err(invalid("payload size is outside the Windows ABI"));
    }
    let tag = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    if word(bytes, 4)? as usize + 8 != bytes.len() {
        return Err(invalid("payload length differs from its header"));
    }
    let base = match tag {
        SYMLINK => 20,
        MOUNT_POINT => 16,
        _ => {
            return Err(KernelError::Execution(
                varin_runtime::execution::ExecutionError::new(
                    "workspace_reparse_tag_unsupported",
                    format!("Native reparse tag {tag:#x} has no shared filesystem representation"),
                ),
            ))
        }
    };
    if bytes.len() < base {
        return Err(invalid("truncated reparse header"));
    }
    // Both names are ranges in PathBuffer. PrintName is descriptive; the
    // substitute name is what the native filesystem actually resolves.
    let mut target = text(
        bytes,
        base,
        word(bytes, 8)? as usize,
        word(bytes, 10)? as usize,
    )?;
    text(
        bytes,
        base,
        word(bytes, 12)? as usize,
        word(bytes, 14)? as usize,
    )?;
    if target.is_empty() {
        return Err(invalid("empty substitute name"));
    }
    if let Some(unc) = target.strip_prefix("\\??\\UNC\\") {
        target = format!("\\\\{unc}");
    } else if let Some(disk) = target.strip_prefix("\\??\\") {
        target = disk.into();
    }
    Ok(Reparse { tag, target })
}
pub(crate) fn symlink(target: &str) -> Result<Vec<u8>, KernelError> {
    if target.is_empty() || target.contains('\0') {
        return Err(invalid("invalid symbolic-link target"));
    }
    let target = target.replace('/', "\\");
    let relative =
        !target.starts_with('\\') && !target.as_bytes().get(1).is_some_and(|byte| *byte == b':');
    let substitute = if relative {
        target.clone()
    } else if target.starts_with("\\??\\") {
        target.clone()
    } else if let Some(disk) = target.strip_prefix("\\\\?\\") {
        format!("\\??\\{disk}")
    } else if let Some(unc) = target.strip_prefix("\\\\") {
        format!("\\??\\UNC\\{unc}")
    } else {
        format!("\\??\\{target}")
    };
    let substitute = substitute.encode_utf16().collect::<Vec<_>>();
    let printed = target.encode_utf16().collect::<Vec<_>>();
    let size = 20 + (substitute.len() + printed.len() + 2) * 2;
    if size > MAXIMUM_SIZE {
        return Err(invalid("symbolic-link target exceeds the Windows ABI"));
    }
    let mut bytes = Vec::with_capacity(size);
    bytes.extend(SYMLINK.to_le_bytes());
    bytes.extend(((size - 8) as u16).to_le_bytes());
    bytes.extend([0u8; 2]);
    for value in [
        0,
        (substitute.len() * 2) as u16,
        ((substitute.len() + 1) * 2) as u16,
        (printed.len() * 2) as u16,
    ] {
        bytes.extend(value.to_le_bytes());
    }
    bytes.extend((if relative { 1u32 } else { 0 }).to_le_bytes());
    for value in substitute
        .into_iter()
        .chain(Some(0))
        .chain(printed)
        .chain(Some(0))
    {
        bytes.extend(value.to_le_bytes());
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_reparse_targets_roundtrip_relative_absolute_unc_and_reject_invalid_ranges() {
        for target in ["../目录/文件", "D:\\项目\\file", "\\\\server\\share\\file"] {
            let bytes = symlink(target).unwrap();
            let decoded = parse(&bytes).unwrap();
            assert_eq!(decoded.tag, SYMLINK);
            assert_eq!(decoded.target, target.replace('/', "\\"));
        }
        let extended = symlink("\\\\?\\D:\\项目\\file").unwrap();
        assert_eq!(parse(&extended).unwrap().target, "D:\\项目\\file");
        let mut junction = symlink("D:\\target").unwrap();
        junction.splice(16..20, []);
        let size = (junction.len() - 8) as u16;
        junction[..4].copy_from_slice(&MOUNT_POINT.to_le_bytes());
        junction[4..6].copy_from_slice(&size.to_le_bytes());
        assert_eq!(parse(&junction).unwrap().target, "D:\\target");
        junction[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        assert!(parse(&junction).is_err());
    }
}
