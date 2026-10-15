//! Private Windows directory notifications. No Catalog, Storage queue, tree scan or file bodies.
//! The Host owns admitted paths and projects these hints through Documents.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufRead, Write},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_IO_INCOMPLETE, ERROR_NOTIFY_ENUM_DIR, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, ReadDirectoryChangesW, BY_HANDLE_FILE_INFORMATION,
        FILE_ACTION_MODIFIED, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
        FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION,
        FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
        FILE_NOTIFY_CHANGE_SECURITY, FILE_NOTIFY_CHANGE_SIZE, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    },
    System::{
        Threading::{CreateEventW, ResetEvent, SetEvent, WaitForMultipleObjects, INFINITE},
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
    },
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Open { id: String, path: PathBuf },
    Flush { id: String, request: String },
    Close { id: String },
}
type Output = Arc<Mutex<io::Stdout>>;
fn send(out: &Output, value: Value) -> io::Result<()> {
    let mut writer = out
        .lock()
        .map_err(|_| io::Error::other("directory output unavailable"))?;
    serde_json::to_writer(&mut *writer, &value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}
fn event() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}
fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle().cast()
}
fn open_directory(path: &Path, overlapped: bool) -> io::Result<OwnedHandle> {
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | if overlapped { FILE_FLAG_OVERLAPPED } else { 0 },
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.cast()) })
}
fn identity(handle: HANDLE) -> io::Result<(u32, u32, u32)> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

struct Changes {
    handle: OwnedHandle,
    event: OwnedHandle,
    overlapped: Box<OVERLAPPED>,
    buffer: Vec<u32>,
    pending: bool,
    recursive: bool,
    filter: u32,
    content_only: bool,
}
impl Changes {
    fn open(path: &Path, recursive: bool, filter: u32) -> io::Result<Self> {
        let event = event()?;
        let mut overlapped: Box<OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
        overlapped.hEvent = raw(&event);
        let mut watch = Self {
            handle: open_directory(path, true)?,
            event,
            overlapped,
            // ReadDirectoryChangesW requires DWORD alignment and at most 64 KiB on SMB.
            buffer: vec![0; 64 * 1024 / 4],
            pending: false,
            recursive,
            filter,
            content_only: false,
        };
        watch.arm()?;
        Ok(watch)
    }
    fn arm(&mut self) -> io::Result<()> {
        unsafe {
            ResetEvent(raw(&self.event));
        }
        let queued = unsafe {
            ReadDirectoryChangesW(
                raw(&self.handle),
                self.buffer.as_mut_ptr().cast(),
                (self.buffer.len() * 4) as u32,
                i32::from(self.recursive),
                self.filter,
                std::ptr::null_mut(),
                &mut *self.overlapped,
                None,
            )
        };
        if queued == 0 {
            return Err(io::Error::last_os_error());
        }
        self.pending = true;
        Ok(())
    }
    fn drain(&mut self) -> io::Result<Option<Vec<Value>>> {
        let mut length = 0;
        if unsafe { GetOverlappedResult(raw(&self.handle), &*self.overlapped, &mut length, 0) } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
                return Ok(None);
            }
            self.pending = false;
            if error.raw_os_error() != Some(ERROR_NOTIFY_ENUM_DIR as i32) {
                return Err(error);
            }
            length = 0;
        } else {
            self.pending = false;
        }
        let events = if length == 0 {
            vec![json!({"kind":"reset"})]
        } else {
            // Read only the completed bytes. Filenames are UTF-16, including surrogate pairs.
            let bytes = unsafe {
                std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), length as usize)
            };
            decode_changes(bytes, self.content_only)?
        };
        // Windows retains intervening changes in the handle's own buffer. Re-arm
        // before publishing, and report overflow instead of claiming an empty batch.
        self.arm()?;
        Ok(Some(events))
    }
}
impl Drop for Changes {
    fn drop(&mut self) {
        if self.pending {
            // OVERLAPPED and its buffer remain alive until cancellation has completed.
            unsafe {
                CancelIoEx(raw(&self.handle), &*self.overlapped);
                let mut length = 0;
                GetOverlappedResult(raw(&self.handle), &*self.overlapped, &mut length, 1);
            }
        }
    }
}
fn decode_changes(bytes: &[u8], content_only: bool) -> io::Result<Vec<Value>> {
    let malformed = || io::Error::other("invalid Windows directory notification");
    let mut events = Vec::new();
    let mut offset = 0;
    loop {
        let header = bytes.get(offset..offset + 12).ok_or_else(malformed)?;
        let field = |start| u32::from_le_bytes(header[start..start + 4].try_into().unwrap());
        let next = field(0) as usize;
        let action = field(4);
        let length = field(8) as usize;
        if length % 2 != 0 {
            return Err(malformed());
        }
        let name = bytes
            .get(offset + 12..offset + 12 + length)
            .ok_or_else(malformed)?;
        let wide = name
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>();
        let name = String::from_utf16(&wide).map_err(|_| malformed())?;
        let kind = if content_only {
            "content"
        } else if action == FILE_ACTION_MODIFIED {
            "change"
        } else {
            "rename"
        };
        events.push(json!({"kind":kind,"path":name}));
        if next == 0 {
            break;
        }
        if next < 12 + length || next % 4 != 0 {
            return Err(malformed());
        }
        offset += next;
    }
    Ok(events)
}
struct Control {
    stop: OwnedHandle,
    wake: OwnedHandle,
    flushes: Mutex<VecDeque<String>>,
}
impl Control {
    fn new() -> io::Result<Self> {
        Ok(Self {
            stop: event()?,
            wake: event()?,
            flushes: Mutex::new(VecDeque::new()),
        })
    }
    fn close(&self) {
        unsafe {
            SetEvent(raw(&self.stop));
        }
    }
    fn flush(&self, request: String) {
        self.flushes.lock().unwrap().push_back(request);
        unsafe {
            SetEvent(raw(&self.wake));
        }
    }
}
fn observe(path: &Path, id: &str, control: &Control, output: &Output) -> io::Result<()> {
    let path = std::fs::canonicalize(path)?;
    let mut changes = Changes::open(
        &path,
        true,
        FILE_NOTIFY_CHANGE_FILE_NAME
            | FILE_NOTIFY_CHANGE_DIR_NAME
            | FILE_NOTIFY_CHANGE_ATTRIBUTES
            | FILE_NOTIFY_CHANGE_CREATION
            | FILE_NOTIFY_CHANGE_SECURITY,
    )?;
    // NTFS can emit a deferred directory LAST_WRITE notification on the first
    // enumeration, even when its last-write time is unchanged. Keep content
    // notifications separate: Documents can ignore directory timestamps while
    // retaining directory names, attributes and security from the other handle.
    let mut content = Changes::open(
        &path,
        true,
        FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE,
    )?;
    content.content_only = true;
    let original = identity(raw(&changes.handle))?;
    let mut parent = path
        .parent()
        .map(|parent| {
            Changes::open(
                parent,
                false,
                FILE_NOTIFY_CHANGE_DIR_NAME
                    | FILE_NOTIFY_CHANGE_ATTRIBUTES
                    | FILE_NOTIFY_CHANGE_SECURITY
                    | FILE_NOTIFY_CHANGE_CREATION,
            )
        })
        .transpose()?;
    let validate = || -> io::Result<()> {
        if identity(raw(&open_directory(&path, false)?))? != original {
            return Err(io::Error::other("watched directory was replaced"));
        }
        Ok(())
    };
    validate()?;
    send(output, json!({"v":1,"id":id,"kind":"ready"}))?;
    let drain_parent = |parent: &mut Option<Changes>| -> io::Result<()> {
        if let Some(parent) = parent {
            let events = parent.drain()?;
            validate()?;
            if events.is_some_and(|events| {
                events.iter().any(|event| {
                    event["kind"] == "reset"
                        || event["path"].as_str() == path.file_name().and_then(|name| name.to_str())
                })
            }) {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"events","events":[{"kind":"reset"}]}),
                )?;
            }
        }
        Ok(())
    };
    // Flush is a finite observation boundary, not a wait for a quiet filesystem.
    // Stop and flush take priority over a continuously changing directory.
    let mut handles = vec![
        raw(&control.stop),
        raw(&control.wake),
        raw(&changes.event),
        raw(&content.event),
    ];
    if let Some(parent) = &parent {
        handles.push(raw(&parent.event));
    }
    loop {
        let index =
            unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
        if index == WAIT_OBJECT_0 {
            return Ok(());
        }
        if index == WAIT_OBJECT_0 + 2 {
            if let Some(events) = changes.drain()? {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"events","events":events}),
                )?;
            }
        } else if index == WAIT_OBJECT_0 + 3 {
            if let Some(events) = content.drain()? {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"events","events":events}),
                )?;
            }
        } else if parent.is_some() && index == WAIT_OBJECT_0 + 4 {
            drain_parent(&mut parent)?;
        } else if index == WAIT_OBJECT_0 + 1 {
            let requests = {
                let mut requests = control.flushes.lock().unwrap();
                unsafe {
                    ResetEvent(raw(&control.wake));
                }
                std::mem::take(&mut *requests)
            };
            validate()?;
            // Drain again after validating the named root. These events and ACKs
            // share stdout ordering, so Host settle() can join its metadata batch.
            if let Some(events) = changes.drain()? {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"events","events":events}),
                )?;
            }
            if let Some(events) = content.drain()? {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"events","events":events}),
                )?;
            }
            drain_parent(&mut parent)?;
            for request in requests {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"flushed","request":request}),
                )?;
            }
        } else {
            return Err(io::Error::last_os_error());
        }
    }
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let output = Arc::new(Mutex::new(io::stdout()));
    send(&output, json!({"v":1,"kind":"hello"}))?;
    let mut watches: HashMap<String, (Arc<Control>, thread::JoinHandle<()>)> = HashMap::new();
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        for line in io::stdin().lock().lines() {
            match serde_json::from_str::<Command>(&line?)? {
                Command::Open { id, path } => {
                    if watches.contains_key(&id) {
                        return Err(
                            io::Error::other("directory subscription already exists").into()
                        );
                    }
                    let control = Arc::new(Control::new()?);
                    let held = control.clone();
                    let out = output.clone();
                    let key = id.clone();
                    let worker = thread::spawn(move || {
                        let result = observe(&path, &key, &held, &out);
                        if let Err(error) = result {
                            let _ = send(
                                &out,
                                json!({"v":1,"id":key,"kind":"error","message":error.to_string()}),
                            );
                        }
                        let _ = send(&out, json!({"v":1,"id":key,"kind":"closed"}));
                    });
                    watches.insert(id, (control, worker));
                }
                Command::Flush { id, request } => {
                    if let Some((control, _)) = watches.get(&id) {
                        control.flush(request);
                    } else {
                        send(
                            &output,
                            json!({"v":1,"id":id,"kind":"error","message":"directory subscription is closed"}),
                        )?;
                    }
                }
                Command::Close { id } => {
                    if let Some((control, _)) = watches.remove(&id) {
                        control.close();
                    }
                }
            }
        }
        Ok(())
    })();
    for (control, _) in watches.values() {
        control.close();
    }
    for (_, (_, worker)) in watches {
        let _ = worker.join();
    }
    result
}
