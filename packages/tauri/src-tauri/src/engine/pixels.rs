//! CEF paints premultiplied BGRA. Preserve alpha through every composition step.
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u32>,
}

impl Frame {
    pub fn from_bgra(width: usize, height: usize, bytes: &[u8]) -> Option<Self> {
        let size = width.checked_mul(height)?.checked_mul(4)?;
        if bytes.len() != size || width == 0 || height == 0 {
            return None;
        }
        Some(Self {
            width,
            height,
            pixels: bytes
                .chunks_exact(4)
                .map(|p| u32::from_le_bytes([p[0], p[1], p[2], p[3]]))
                .collect(),
        })
    }
}

pub fn blend(
    buffer: &mut [u32],
    width: usize,
    height: usize,
    frame: &Frame,
    origin: (isize, isize),
) {
    for row in 0..frame.height {
        let y = origin.1 + row as isize;
        if y < 0 || y as usize >= height {
            continue;
        }
        for column in 0..frame.width {
            let x = origin.0 + column as isize;
            if x < 0 || x as usize >= width {
                continue;
            }
            let source = frame.pixels[row * frame.width + column];
            let target = &mut buffer[y as usize * width + x as usize];
            let alpha = source >> 24;
            if alpha == 0 {
                continue;
            }
            if alpha == 255 {
                *target = source;
                continue;
            }
            let channel = |shift: u32| {
                let s = (source >> shift) & 255;
                let d = (*target >> shift) & 255;
                (s + (d * (255 - alpha) + 127) / 255).min(255) << shift
            };
            *target = channel(24) | channel(16) | channel(8) | channel(0);
        }
    }
}

pub fn utf16_offset(text: &str, bytes: usize) -> u32 {
    text.char_indices()
        .take_while(|(offset, _)| *offset < bytes)
        .map(|(_, c)| c.len_utf16() as u32)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transparent_background_stays_transparent() {
        let frame = Frame::from_bgra(1, 1, &[10, 20, 30, 128]).unwrap();
        let mut target = [0];
        blend(&mut target, 1, 1, &frame, (0, 0));
        assert_eq!(target[0].to_le_bytes(), [10, 20, 30, 128]);
    }
    #[test]
    fn popup_composition_preserves_resulting_alpha() {
        let frame = Frame::from_bgra(1, 1, &[0, 0, 128, 128]).unwrap();
        let mut target = [u32::from_le_bytes([128, 0, 0, 128])];
        blend(&mut target, 1, 1, &frame, (0, 0));
        assert_eq!(target[0].to_le_bytes(), [64, 0, 128, 192]);
    }
    #[test]
    fn offscreen_popup_is_clipped_not_repositioned() {
        let frame = Frame::from_bgra(2, 1, &[0, 0, 255, 255, 0, 255, 0, 255]).unwrap();
        let mut target = [0];
        blend(&mut target, 1, 1, &frame, (-1, 0));
        assert_eq!(target[0].to_le_bytes(), [0, 255, 0, 255]);
    }
    #[test]
    fn rejects_truncated_and_overflowing_native_frames() {
        assert!(Frame::from_bgra(2, 2, &[0; 4]).is_none());
        assert!(Frame::from_bgra(usize::MAX, 2, &[]).is_none());
    }
    #[test]
    fn ime_offsets_are_utf16_not_utf8() {
        assert_eq!(utf16_offset("a中😀b", 8), 4);
        assert_eq!(utf16_offset("a中😀b", 4), 2);
    }
}
