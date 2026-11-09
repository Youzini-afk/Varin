// Keep the process and stderr alive after closing stdout's only writer. Node
// and PowerShell retain extra standard handles, so they cannot provide this
// Windows pipe-lifetime fixture. This helper uses no dependencies or console IO.
use std::{ffi::c_void, io, ptr};

type Handle = *mut c_void;

#[link(name = "kernel32")]
extern "system" {
    fn GetStdHandle(id: u32) -> Handle;
    fn WriteFile(
        handle: Handle,
        bytes: *const u8,
        count: u32,
        written: *mut u32,
        overlapped: Handle,
    ) -> i32;
    fn ReadFile(
        handle: Handle,
        bytes: *mut u8,
        count: u32,
        read: *mut u32,
        overlapped: Handle,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

unsafe fn write(handle: Handle, bytes: &[u8]) -> io::Result<()> {
    let mut written = 0;
    if WriteFile(
        handle,
        bytes.as_ptr(),
        bytes.len() as u32,
        &mut written,
        ptr::null_mut(),
    ) == 0
    {
        return Err(io::Error::last_os_error());
    }
    assert_eq!(written as usize, bytes.len(), "Incomplete fixture write");
    Ok(())
}

fn main() -> io::Result<()> {
    unsafe {
        let stdout = GetStdHandle((-11i32) as u32);
        write(stdout, b"stdout")?;
        if CloseHandle(stdout) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut input = 0u8;
        let mut read = 0;
        if ReadFile(
            GetStdHandle((-10i32) as u32),
            &mut input,
            1,
            &mut read,
            ptr::null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        assert_eq!(read, 1, "Missing stdin handshake");
        write(GetStdHandle((-12i32) as u32), b"after stdout EOF")?;
    }
    Ok(())
}
