//! GDI capture with WIC encoding. COM initialization belongs to the calling
//! capture worker; this module never constructs UI Automation objects.
use crate::protocol::{Failure, Rect, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    ffi::c_void,
    mem::{size_of, ManuallyDrop},
    ptr,
};
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{HGLOBAL, HWND},
        Graphics::{Gdi::*, Imaging::*},
        Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS},
        System::{
            Com::{
                CoCreateInstance,
                StructuredStorage::{CreateStreamOnHGlobal, PROPBAG2},
                CLSCTX_INPROC_SERVER, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
            },
            SystemInformation::GetSystemTime,
            Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_R4},
        },
        UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
            SM_YVIRTUALSCREEN,
        },
    },
};

struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(None, self.0);
        }
    }
}

/// Owns a top-down 32-bit DIB, its memory DC, and the object it replaced.
/// Deselect the bitmap before deletion, including on every error path.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut c_void,
    width: u32,
    height: u32,
    len: usize,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.0.is_null() {
                SelectObject(self.dc, self.previous);
            }
            if !self.bitmap.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            }
            if !self.dc.0.is_null() {
                let _ = DeleteDC(self.dc);
            }
        }
    }
}
impl Surface {
    fn new(bounds: Rect) -> Result<Self> {
        if !bounds.valid()
            || bounds.width.round() > i32::MAX as f64
            || bounds.height.round() > i32::MAX as f64
            || bounds.x.round() < i32::MIN as f64
            || bounds.x.round() > i32::MAX as f64
            || bounds.y.round() < i32::MIN as f64
            || bounds.y.round() > i32::MAX as f64
        {
            return Err(Failure::new(
                "capture-failed",
                "Capture bounds cannot be represented by Windows GDI",
            ));
        }
        let width = bounds.width.round() as u32;
        let height = bounds.height.round() as u32;
        // WIC's buffer length and stride are u32. Reject arithmetic overflow,
        // rather than imposing an arbitrary desktop-size limit.
        let len = width
            .checked_mul(4)
            .and_then(|stride| stride.checked_mul(height))
            .filter(|len| *len > 0)
            .ok_or_else(|| {
                Failure::new(
                    "capture-failed",
                    "Capture dimensions exceed the native image buffer format",
                )
            })? as usize;
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.0.is_null() {
                return Err(windows::core::Error::from_thread().into());
            }
            let mut surface = Self {
                dc,
                bitmap: HBITMAP::default(),
                previous: HGDIOBJ::default(),
                bits: ptr::null_mut(),
                width,
                height,
                len,
            };
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            surface.bitmap =
                CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut surface.bits, None, 0)?;
            if surface.bits.is_null() {
                return Err(Failure::new(
                    "capture-failed",
                    "Windows did not allocate a capture bitmap",
                ));
            }
            surface.previous = SelectObject(dc, HGDIOBJ(surface.bitmap.0));
            if surface.previous.0.is_null() || surface.previous.0 as isize == -1 {
                surface.previous = HGDIOBJ::default();
                return Err(windows::core::Error::from_thread().into());
            }
            ptr::write_bytes(surface.bits, 0, len);
            Ok(surface)
        }
    }
    fn pixels(&self) -> &[u8] {
        // GDI must finish writing the DIB before the CPU or WIC reads it.
        unsafe {
            let _ = GdiFlush();
            std::slice::from_raw_parts(self.bits.cast(), self.len)
        }
    }
    fn screen_copy(&self, bounds: Rect) -> Result<()> {
        unsafe {
            let screen = ScreenDc(GetDC(None));
            if screen.0 .0.is_null() {
                return Err(windows::core::Error::from_thread().into());
            }
            BitBlt(
                self.dc,
                0,
                0,
                self.width as i32,
                self.height as i32,
                Some(screen.0),
                bounds.x.round() as i32,
                bounds.y.round() as i32,
                SRCCOPY | CAPTUREBLT,
            )?;
        }
        Ok(())
    }
    fn encode(&self, jpeg_quality: Option<f64>) -> Result<Vec<u8>> {
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let source = factory.CreateBitmapFromMemory(
                self.width,
                self.height,
                &GUID_WICPixelFormat32bppBGR,
                self.width * 4,
                self.pixels(),
            )?;
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
            let container = if jpeg_quality.is_some() {
                GUID_ContainerFormatJpeg
            } else {
                GUID_ContainerFormatPng
            };
            let encoder = factory.CreateEncoder(&container, ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            let mut frame = None;
            let mut options = None;
            encoder.CreateNewFrame(&mut frame, &mut options)?;
            if let (Some(quality), Some(options)) = (jpeg_quality, options.as_ref()) {
                let mut name: Vec<u16> = "ImageQuality\0".encode_utf16().collect();
                let property = PROPBAG2 {
                    pstrName: PWSTR(name.as_mut_ptr()),
                    ..Default::default()
                };
                let value = VARIANT {
                    Anonymous: VARIANT_0 {
                        Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                            vt: VT_R4,
                            Anonymous: VARIANT_0_0_0 {
                                fltVal: (quality.clamp(0.0, 100.0) / 100.0) as f32,
                            },
                            ..Default::default()
                        }),
                    },
                };
                options.Write(1, &property, &value)?;
            }
            let frame = frame.ok_or_else(|| {
                Failure::new("capture-failed", "WIC returned no image encoder frame")
            })?;
            frame.Initialize(options.as_ref())?;
            frame.SetSize(self.width, self.height)?;
            let mut format = GUID_WICPixelFormat24bppBGR;
            frame.SetPixelFormat(&mut format)?;
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &source,
                &format,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            frame.WriteSource(&converter, ptr::null())?;
            frame.Commit()?;
            encoder.Commit()?;
            let mut stat = STATSTG::default();
            stream.Stat(&mut stat, STATFLAG_NONAME)?;
            let size = u32::try_from(stat.cbSize).map_err(|_| {
                Failure::new(
                    "capture-failed",
                    "Encoded image exceeds the native stream format",
                )
            })?;
            let mut bytes = vec![0; size as usize];
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut read = 0;
            stream
                .Read(bytes.as_mut_ptr().cast(), size, Some(&mut read))
                .ok()?;
            if read != size {
                return Err(Failure::new(
                    "capture-failed",
                    "WIC image stream ended before the complete image",
                ));
            }
            Ok(bytes)
        }
    }
}

fn blank(pixels: &[u8], width: u32, height: u32) -> bool {
    [
        (0, 0),
        (5.min(width - 1), 5.min(height - 1)),
        (width.saturating_sub(6), height.saturating_sub(6)),
    ]
    .iter()
    .all(|&(x, y)| {
        let at = (y as usize * width as usize + x as usize) * 4;
        pixels[at..at + 3].iter().all(|value| *value <= 12)
    })
}

pub fn window(hwnd: HWND, bounds: Rect) -> Result<Value> {
    let surface = Surface::new(bounds)?;
    let rendered = !hwnd.0.is_null()
        && unsafe { PrintWindow(hwnd, surface.dc, PRINT_WINDOW_FLAGS(2)).as_bool() };
    let source = if rendered && !blank(surface.pixels(), surface.width, surface.height) {
        "window"
    } else {
        surface.screen_copy(bounds)?;
        "screen"
    };
    Ok(
        json!({"screenshotPngBase64":STANDARD.encode(surface.encode(None)?), "screenshotSource":source}),
    )
}

pub fn desktop(quality: f64) -> Result<Value> {
    if !quality.is_finite() {
        return Err(Failure::new(
            "invalid-request",
            "JPEG quality must be finite",
        ));
    }
    let bounds = unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN) as f64,
            y: GetSystemMetrics(SM_YVIRTUALSCREEN) as f64,
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN) as f64,
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN) as f64,
        }
    };
    let surface = Surface::new(bounds)?;
    surface.screen_copy(bounds)?;
    // Retain the prior PNG fallback if the system's JPEG codec is unavailable.
    let (bytes, mime) = match surface.encode(Some(quality)) {
        Ok(bytes) => (bytes, "image/jpeg"),
        Err(_) => (surface.encode(None)?, "image/png"),
    };
    let time = unsafe { GetSystemTime() };
    let captured_at = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.wYear,
        time.wMonth,
        time.wDay,
        time.wHour,
        time.wMinute,
        time.wSecond,
        time.wMilliseconds
    );
    Ok(
        json!({"mime":mime,"base64":STANDARD.encode(bytes),"bounds":bounds,"capturedAt":captured_at}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    struct Apartment;
    impl Apartment {
        fn mta() -> Self {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap() };
            Self
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    fn patterned_surface() -> Surface {
        let surface = Surface::new(Rect {
            x: 0.0,
            y: 0.0,
            width: 7.0,
            height: 5.0,
        })
        .unwrap();
        // This is an allocated memory bitmap, not a screen or window read.
        // An asymmetric pattern detects channel swaps, row flips and padding.
        let pixels =
            unsafe { std::slice::from_raw_parts_mut(surface.bits.cast::<u8>(), surface.len) };
        for y in 0..surface.height as usize {
            for x in 0..surface.width as usize {
                let at = (y * surface.width as usize + x) * 4;
                pixels[at..at + 4].copy_from_slice(&[
                    (x * 31 + y * 7) as u8,
                    (x * 13 + y * 29) as u8,
                    (x * 3 + y * 47) as u8,
                    0,
                ]);
            }
        }
        surface
    }

    fn decode_bgr(bytes: &[u8], expected_container: windows::core::GUID) -> (u32, u32, Vec<u8>) {
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).unwrap();
            let mut written = 0;
            stream
                .Write(
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    Some(&mut written),
                )
                .ok()
                .unwrap();
            assert_eq!(written as usize, bytes.len());
            stream.Seek(0, STREAM_SEEK_SET, None).unwrap();
            let decoder = factory
                .CreateDecoderFromStream(&stream, ptr::null(), WICDecodeMetadataCacheOnLoad)
                .unwrap();
            assert_eq!(decoder.GetContainerFormat().unwrap(), expected_container);
            assert_eq!(decoder.GetFrameCount().unwrap(), 1);
            let frame = decoder.GetFrame(0).unwrap();
            let (mut width, mut height) = (0, 0);
            frame.GetSize(&mut width, &mut height).unwrap();
            let converter = factory.CreateFormatConverter().unwrap();
            converter
                .Initialize(
                    &frame,
                    &GUID_WICPixelFormat24bppBGR,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .unwrap();
            let mut pixels = vec![0; (width * height * 3) as usize];
            converter
                .CopyPixels(ptr::null(), width * 3, &mut pixels)
                .unwrap();
            (width, height, pixels)
        }
    }

    #[test]
    fn wic_png_round_trip_preserves_in_memory_bgr_pixels() {
        // Declare the apartment first so all native objects are dropped before
        // CoUninitialize, even when an assertion unwinds this test.
        let _apartment = Apartment::mta();
        let surface = patterned_surface();
        let encoded = surface.encode(None).unwrap();
        let (width, height, decoded) = decode_bgr(&encoded, GUID_ContainerFormatPng);
        assert_eq!((width, height), (surface.width, surface.height));
        let expected: Vec<u8> = surface
            .pixels()
            .chunks_exact(4)
            .flat_map(|pixel| pixel[..3].iter().copied())
            .collect();
        assert_eq!(decoded, expected);
    }

    #[test]
    fn wic_jpeg_round_trip_decodes_in_memory_pixels_at_requested_dimensions() {
        let _apartment = Apartment::mta();
        let surface = patterned_surface();
        let encoded = surface.encode(Some(65.0)).unwrap();
        let (width, height, decoded) = decode_bgr(&encoded, GUID_ContainerFormatJpeg);
        assert_eq!((width, height), (surface.width, surface.height));
        assert_eq!(decoded.len(), (surface.width * surface.height * 3) as usize);
        assert!(decoded.iter().any(|channel| *channel > 12));
        // JPEG is intentionally lossy; exact byte equality belongs to PNG.
    }

    #[test]
    fn black_capture_heuristic_preserves_the_original_three_samples() {
        let mut pixels = vec![0u8; 10 * 10 * 4];
        assert!(blank(&pixels, 10, 10));
        pixels[(5 * 10 + 5) * 4 + 1] = 13;
        assert!(!blank(&pixels, 10, 10));
        assert!(blank(&[12, 12, 12, 255], 1, 1));
        assert!(!blank(&[0, 13, 0, 0], 1, 1));
    }
}
