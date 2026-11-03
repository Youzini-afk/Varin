//! Narrow platform primitives called only by the private Node desktop owner.
//! Installed-application discovery and launch policy remain in that owner.
use serde_json::{Value, json};

pub async fn launch_app(params: Value) -> Result<Value, String> {
    let program = params["program"]
        .as_str()
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .ok_or("Application executable is missing")?;
    let args: Vec<String> = serde_json::from_value(params["args"].clone())
        .map_err(|_| "Application arguments are invalid")?;
    if args.len() > 1024
        || args.iter().map(String::len).sum::<usize>() > 1024 * 1024
        || args.iter().any(|s| s.contains('\0'))
    {
        return Err("Application arguments exceed the launch budget".into());
    }
    let mut command = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if params["windowsVerbatimArguments"] == true {
            for arg in &args {
                command.as_std_mut().raw_arg(arg);
            }
        } else {
            command.args(&args);
        }
    }
    #[cfg(not(windows))]
    command.args(&args);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Spawned by the shell, outside its managed Node service process scope.
    // The user's IDE/terminal must survive a Host restart or application quit.
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Installed application could not be started")?;
    if params["waitForExit"] == true {
        let status = child
            .wait()
            .await
            .map_err(|_| "Application launcher completion is unknown")?;
        if !status.success() {
            return Err("Application launcher reported failure".into());
        }
    } else {
        tauri::async_runtime::spawn(async move {
            let _ = child.wait().await;
        });
    }
    Ok(json!({"launched":true}))
}

pub async fn file_icon(params: Value) -> Result<Value, String> {
    let path = params["path"]
        .as_str()
        .ok_or("Icon path is required")?
        .to_owned();
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(move || windows_icon(&path))
            .await
            .map_err(|_| "File icon task ended")?
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(Value::Null)
    }
}

#[cfg(windows)]
fn windows_icon(path: &str) -> Result<Value, String> {
    use base64::Engine;
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
            DIB_RGB_COLORS, DeleteDC, DeleteObject, SelectObject,
        },
        UI::{
            Shell::{SHFILEINFOW, SHGFI_ICON, SHGetFileInfoW},
            WindowsAndMessaging::{DI_NORMAL, DestroyIcon, DrawIconEx},
        },
    };
    if path.contains('\0') {
        return Err("Icon path is invalid".into());
    }
    let path: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut info: SHFILEINFOW = std::mem::zeroed();
        if SHGetFileInfoW(
            path.as_ptr(),
            0,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON,
        ) == 0
            || info.hIcon.is_null()
        {
            return Ok(Value::Null);
        }
        let draw = |background: u8| -> Result<Vec<u8>, String> {
            let dc = CreateCompatibleDC(ptr::null_mut());
            if dc.is_null() {
                return Err("File icon device unavailable".into());
            }
            let mut bitmap: BITMAPINFO = std::mem::zeroed();
            bitmap.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: 32,
                biHeight: -32,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut pixels = ptr::null_mut();
            let dib =
                CreateDIBSection(dc, &bitmap, DIB_RGB_COLORS, &mut pixels, ptr::null_mut(), 0);
            if dib.is_null() {
                DeleteDC(dc);
                return Err("File icon bitmap unavailable".into());
            }
            let old = SelectObject(dc, dib);
            let bytes = std::slice::from_raw_parts_mut(pixels.cast::<u8>(), 32 * 32 * 4);
            bytes.fill(background);
            let ok = DrawIconEx(dc, 0, 0, info.hIcon, 32, 32, 0, ptr::null_mut(), DI_NORMAL) != 0;
            let result = bytes.to_vec();
            SelectObject(dc, old);
            DeleteObject(dib);
            DeleteDC(dc);
            if ok {
                Ok(result)
            } else {
                Err("File icon could not be drawn".into())
            }
        };
        let black = draw(0);
        let white = draw(255);
        DestroyIcon(info.hIcon);
        let black = black?;
        let white = white?;
        let mut rgba = Vec::with_capacity(black.len());
        // Two backgrounds also preserve legacy AND-mask icons without an alpha channel.
        for (black, white) in black.chunks_exact(4).zip(white.chunks_exact(4)) {
            let alpha = 255
                - white[0]
                    .saturating_sub(black[0])
                    .max(white[1].saturating_sub(black[1]))
                    .max(white[2].saturating_sub(black[2]));
            for channel in [2, 1, 0] {
                rgba.push(if alpha == 0 {
                    0
                } else {
                    ((black[channel] as u32 * 255 + alpha as u32 / 2) / alpha as u32).min(255) as u8
                });
            }
            rgba.push(alpha);
        }
        let mut png_bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, 32, 32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .map_err(|_| "File icon encoding failed")?
                .write_image_data(&rgba)
                .map_err(|_| "File icon encoding failed")?;
        }
        Ok(json!(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png_bytes)
        )))
    }
}
