//! Instance-scoped local pipe. Its reader and input gate are independent of UIA.
use super::input::InputOwner;
use crate::protocol::{Failure, Result};
use serde::Deserialize;
use serde_json::json;
use std::{
    fs::File,
    io::{BufRead, BufReader, Write},
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Arc,
    thread,
};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{GetLastError, LocalFree, ERROR_PIPE_CONNECTED, HANDLE, HLOCAL},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
            TOKEN_USER,
        },
        Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
                PIPE_WAIT,
            },
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    id: String,
    command: String,
    request_id: Option<String>,
    restore_focus: Option<bool>,
}

pub fn start(name: &str, owner: Arc<InputOwner>) -> Result<()> {
    if !name.starts_with(r"\\.\pipe\varin-computer-")
        || name[r"\\.\pipe\varin-computer-".len()..].is_empty()
        || name[r"\\.\pipe\varin-computer-".len()..].contains(['\\', '/'])
    {
        return Err(Failure::new(
            "driver-error",
            "Invalid local Computer control pipe name",
        ));
    }
    let pipe = create_pipe(name)?;
    thread::Builder::new().name("computer-control".into()).spawn(move || {
        let raw = HANDLE(pipe.as_raw_handle());
        unsafe { if ConnectNamedPipe(raw, None).is_err() && GetLastError() != ERROR_PIPE_CONNECTED { owner.interrupt(false); return; } }
        let mut reader = BufReader::new(pipe);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) { Ok(0)|Err(_) => break, Ok(_) => {} }
            let command: Command = match serde_json::from_str(&line) { Ok(value)=>value, Err(_)=>continue };
            let response = match command.command.as_str() {
                "cancel" => match command.request_id.as_deref() {
                    Some(request) => json!({"id":command.id,"ok":true,"released":owner.cancel(request)}),
                    None => json!({"id":command.id,"ok":false,"released":false}),
                },
                "interrupt" => json!({"id":command.id,"ok":true,"released":owner.interrupt(command.restore_focus.unwrap_or(true))}),
                _ => json!({"id":command.id,"ok":false,"released":false}),
            };
            if writeln!(reader.get_mut(), "{response}").and_then(|_| reader.get_mut().flush()).is_err() { break; }
        }
        // Losing the sole control connection must not leave an unfenced writer.
        // stdin EOF independently terminates even when a COM provider is blocked.
        owner.interrupt(false);
    }).map_err(|_| Failure::new("driver-error", "Could not start Computer control listener"))?;
    Ok(())
}
fn create_pipe(name: &str) -> Result<File> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let token = OwnedHandle::from_raw_handle(token.0);
        let mut length = 0;
        let _ = GetTokenInformation(
            HANDLE(token.as_raw_handle()),
            TokenUser,
            None,
            0,
            &mut length,
        );
        // Native structures require pointer alignment, not a Vec<u8> cast.
        let mut storage = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        GetTokenInformation(
            HANDLE(token.as_raw_handle()),
            TokenUser,
            Some(storage.as_mut_ptr().cast()),
            length,
            &mut length,
        )?;
        let user = &*storage.as_ptr().cast::<TOKEN_USER>();
        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid)?;
        let sid_string = sid
            .to_string()
            .map_err(|_| Failure::new("driver-error", "Could not read the desktop user's SID"));
        LocalFree(Some(HLOCAL(sid.0.cast())));
        let sid_string = sid_string?;
        let descriptor: Vec<u16> = format!("D:P(A;;GA;;;{sid_string})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut security = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(descriptor.as_ptr()),
            SDDL_REVISION_1,
            &mut security,
            None,
        )?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security.0,
            bInheritHandle: false.into(),
        };
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            4096,
            4096,
            0,
            Some(&attributes),
        );
        let error = GetLastError();
        LocalFree(Some(HLOCAL(security.0)));
        if handle.is_invalid() {
            return Err(Failure::new(
                "driver-error",
                format!(
                    "Could not create the local Computer control pipe (error {})",
                    error.0
                ),
            ));
        }
        Ok(File::from_raw_handle(handle.0))
    }
}
