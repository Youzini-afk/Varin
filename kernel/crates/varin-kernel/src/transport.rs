//! Private, authenticated local control and content connections. Stdio is bootstrap only.
//! Body credits belong to streams; blocked content never owns the control writer.
use crate::protocol::{read_frame, write_frame, MAX_FRAME_BYTES, PROTOCOL_VERSION};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
};
use uuid::Uuid;

const DATA_HEADER_BYTES: usize = 24; // stream UUID + monotonically increasing u64 sequence

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Lane {
    Control,
    Data,
}
pub(crate) enum Incoming {
    Open(Value),
    Frame(Value, Lane),
    Abort(Value),
    Disconnected,
}

/// Only bounded identity/status contracts use direct control JSON. All other params/results
/// use content streams, even when their current value happens to be small.
pub(crate) fn control_method(method: &str) -> bool {
    crate::protocol_generated::KERNEL_CONTROL_METHODS.contains(&method)
}
fn response_lane(method: &str) -> Lane {
    if crate::protocol_generated::KERNEL_CONTROL_RESPONSE_METHODS.contains(&method) {
        Lane::Control
    } else {
        Lane::Data
    }
}
fn identity(value: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for key in [
        "v",
        "kind",
        "id",
        "method",
        "epoch",
        "grantId",
        "kernelEpoch",
    ] {
        if let Some(value) = value.get(key) {
            fields.insert(key.into(), value.clone());
        }
    }
    if value["kind"] == "request" {
        if let Some((_, field)) = crate::protocol_generated::KERNEL_INPUT_ORDER_PARAMS
            .iter()
            .find(|(method, _)| value["method"].as_str() == Some(*method))
        {
            if let Some(target) = value["params"][*field].as_str() {
                fields.insert(
                    "inputOrderKey".into(),
                    Value::String(format!("input:{field}:{target}")),
                );
            }
        }
    }
    Value::Object(fields)
}
pub(crate) fn input_order_key(meta: &Value) -> Option<&str> {
    let (_, field) = crate::protocol_generated::KERNEL_INPUT_ORDER_PARAMS
        .iter()
        .find(|(method, _)| meta["method"].as_str() == Some(*method))?;
    meta["inputOrderKey"]
        .as_str()
        .filter(|key| key.starts_with(&format!("input:{field}:")))
}
fn protocol_error(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    v: u64,
    kind: String,
    control_endpoint: String,
    data_endpoint: String,
    token: String,
    chunk_bytes: usize,
}

#[cfg(unix)]
type Connection = std::os::unix::net::UnixStream;
#[cfg(windows)]
use windows_connection::Connection;
#[cfg(windows)]
mod windows_connection {
    use std::{
        fs::File,
        io::{self, Read, Write},
        os::windows::{
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{ERROR_BROKEN_PIPE, ERROR_IO_PENDING},
        Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED},
        System::{
            Threading::{CreateEventW, ResetEvent},
            IO::{GetOverlappedResult, OVERLAPPED},
        },
    };

    // Synchronous Windows pipe handles serialize a waiting read with writes on their shared
    // file object, even after DuplicateHandle. Each reader/writer instead owns one overlapped
    // event; blocking its own worker never prevents the opposite direction from progressing.
    pub(super) struct Connection {
        file: File,
        event: OwnedHandle,
    }
    impl Connection {
        fn new(file: File) -> io::Result<Self> {
            let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                file,
                event: unsafe { OwnedHandle::from_raw_handle(event) },
            })
        }
        pub(super) fn open(endpoint: &str) -> io::Result<Self> {
            Self::new(
                std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .custom_flags(FILE_FLAG_OVERLAPPED)
                    .open(endpoint)?,
            )
        }
        pub(super) fn try_clone(&self) -> io::Result<Self> {
            Self::new(self.file.try_clone()?)
        }
        fn transfer(&mut self, bytes: *mut u8, length: usize, write: bool) -> io::Result<usize> {
            let mut operation: OVERLAPPED = unsafe { std::mem::zeroed() };
            operation.hEvent = self.event.as_raw_handle();
            if unsafe { ResetEvent(operation.hEvent) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let length = length.min(u32::MAX as usize) as u32;
            let completed = unsafe {
                if write {
                    WriteFile(
                        self.file.as_raw_handle(),
                        bytes,
                        length,
                        ptr::null_mut(),
                        &mut operation,
                    )
                } else {
                    ReadFile(
                        self.file.as_raw_handle(),
                        bytes,
                        length,
                        ptr::null_mut(),
                        &mut operation,
                    )
                }
            };
            if completed == 0 {
                let error = io::Error::last_os_error();
                if !write && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0);
                }
                if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    return Err(error);
                }
            }
            let mut transferred = 0;
            if unsafe {
                GetOverlappedResult(self.file.as_raw_handle(), &operation, &mut transferred, 1)
            } == 0
            {
                let error = io::Error::last_os_error();
                if !write && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0);
                }
                return Err(error);
            }
            Ok(transferred as usize)
        }
    }
    impl Read for Connection {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.transfer(bytes.as_mut_ptr(), bytes.len(), false)
        }
    }
    impl Write for Connection {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.transfer(bytes.as_ptr().cast_mut(), bytes.len(), true)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
fn connect(endpoint: &str) -> io::Result<Connection> {
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(endpoint)
    }
    #[cfg(windows)]
    {
        if !endpoint.starts_with(r"\\.\pipe\") {
            return Err(protocol_error("expected a local named pipe"));
        }
        Connection::open(endpoint)
    }
}

struct Outgoing {
    stream_id: Uuid,
    bytes: Option<Vec<u8>>,
    offset: usize,
    sequence: u64,
    waiting: bool,
    ready: bool,
    aborting: bool,
    ending: bool,
}
struct Received {
    meta: Value,
    length: Option<usize>,
    bytes: Vec<u8>,
    sequence: u64,
    abort_sequence: Option<u64>,
}
struct Scheduler {
    streams: HashMap<Uuid, Outgoing>,
    order: VecDeque<Uuid>,
}
enum Control {
    Frame(Value),
    DurableCursor,
}
struct Shared {
    stopped: AtomicBool,
    control: mpsc::Sender<Control>,
    durable_cursor: Mutex<Option<Value>>,
    incoming: mpsc::Sender<Incoming>,
    scheduled: Mutex<Scheduler>,
    changed: Condvar,
    received: Mutex<HashMap<Uuid, Arc<Mutex<Received>>>>,
    response_lanes: Mutex<HashMap<String, Lane>>,
    queued: AtomicUsize,
    epoch: String,
    chunk_bytes: usize,
}
impl Shared {
    fn fail(&self) {
        if !self.stopped.swap(true, Ordering::AcqRel) {
            self.changed.notify_all();
            let _ = self.incoming.send(Incoming::Disconnected);
        }
    }
    fn control(&self, value: Value) -> io::Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        self.enqueue_control(value)
            .map_err(|_| io::ErrorKind::BrokenPipe.into())
    }
    fn enqueue_control(&self, value: Value) -> Result<(), mpsc::SendError<Value>> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(mpsc::SendError(value));
        }
        if value["kind"] == "runtime-event" && value["stream"] == "durable" {
            // This is a high-water cursor, never the durable facts themselves. One pending
            // wake is sufficient; consumers replay all original events from their own cursor.
            let mut latest = self.durable_cursor.lock().unwrap();
            if let Some(previous) = latest.as_mut() {
                if value["cursor"].as_u64() >= previous["cursor"].as_u64() {
                    *previous = value;
                }
                return Ok(());
            }
            *latest = Some(value);
            self.control
                .send(Control::DurableCursor)
                .map_err(|_| mpsc::SendError(latest.take().unwrap()))
        } else {
            self.control
                .send(Control::Frame(value))
                .map_err(|error| match error.0 {
                    Control::Frame(value) => mpsc::SendError(value),
                    Control::DurableCursor => unreachable!(),
                })
        }
    }
    fn command(&self, kind: &str, id: Uuid, extra: Value) -> io::Result<()> {
        let mut value = json!({"v":PROTOCOL_VERSION,"kind":kind,"streamId":id.to_string(),"kernelEpoch":self.epoch});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.control(value)
    }
}

#[derive(Clone)]
pub(crate) struct Sender {
    shared: Option<Arc<Shared>>,
    encode: Option<mpsc::Sender<(Uuid, Value)>>,
    #[cfg(test)]
    fixture: Option<mpsc::SyncSender<Value>>,
}
#[cfg(test)]
impl From<mpsc::SyncSender<Value>> for Sender {
    fn from(sender: mpsc::SyncSender<Value>) -> Self {
        Self {
            shared: None,
            encode: None,
            fixture: Some(sender),
        }
    }
}
impl Sender {
    fn lane(&self, value: &Value) -> Lane {
        match value["kind"].as_str().unwrap_or_default() {
            "response" => value["id"]
                .as_str()
                .and_then(|id| self.shared.as_ref()?.response_lanes.lock().ok()?.remove(id))
                .unwrap_or(Lane::Data),
            "process-event" if value["stream"] != "data" => Lane::Control,
            "runtime-event" if value["stream"] == "durable" => Lane::Control,
            "credential-request"
            | "host-tool-receipt-ack"
            | "file-observation-request"
            | "file-observation-invalidated" => Lane::Control,
            "host-tool-binding-retain"
            | "host-tool-binding-activate"
            | "host-tool-binding-deactivate" => Lane::Control,
            kind if kind.ends_with("-cancel") || kind.ends_with("-release") => Lane::Control,
            _ => Lane::Data,
        }
    }
    pub(crate) fn send(&self, value: Value) -> Result<(), mpsc::SendError<Value>> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.send(value);
        }
        let shared = self.shared.as_ref().expect("live transport sender");
        if shared.stopped.load(Ordering::Acquire) {
            return Err(mpsc::SendError(value));
        }
        if self.lane(&value) == Lane::Control {
            return shared.enqueue_control(value);
        }
        self.send_body(value, false)
    }
    fn send_body(&self, value: Value, reserved: bool) -> Result<(), mpsc::SendError<Value>> {
        let shared = self.shared.as_ref().unwrap();
        if shared.stopped.load(Ordering::Acquire) {
            if reserved {
                shared.queued.fetch_sub(1, Ordering::AcqRel);
            }
            return Err(mpsc::SendError(value));
        }
        let id = Uuid::new_v4();
        // Register before announcing/encoding: a receiver can stop even a queued body.
        shared.scheduled.lock().unwrap().streams.insert(
            id,
            Outgoing {
                stream_id: id,
                bytes: None,
                offset: 0,
                sequence: 0,
                waiting: false,
                ready: false,
                aborting: false,
                ending: false,
            },
        );
        if !reserved {
            shared.queued.fetch_add(1, Ordering::AcqRel);
        }
        if shared
            .command(
                "transport-stream-open",
                id,
                json!({"identity":identity(&value)}),
            )
            .is_err()
        {
            return Err(mpsc::SendError(value));
        }
        self.encode
            .as_ref()
            .unwrap()
            .send((id, value))
            .map_err(|error| mpsc::SendError(error.0 .1))
    }
    pub(crate) fn send_control(&self, value: Value) -> Result<(), mpsc::SendError<Value>> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.send(value);
        }
        let shared = self.shared.as_ref().unwrap();
        if value["kind"] == "response" {
            if let Some(id) = value["id"].as_str() {
                shared.response_lanes.lock().unwrap().remove(id);
            }
        }
        shared.enqueue_control(value)
    }
    pub(crate) fn try_send(&self, value: Value) -> Result<(), mpsc::TrySendError<Value>> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.try_send(value);
        }
        // Replaceable progress has no independent application ACK. Keep only the transport
        // window's number of such bodies outstanding; durable facts use send and owner credits.
        if self
            .shared
            .as_ref()
            .unwrap()
            .queued
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < crate::protocol_generated::KERNEL_REQUEST_WINDOW).then_some(count + 1)
            })
            .is_err()
        {
            return Err(mpsc::TrySendError::Full(value));
        }
        self.send_body(value, true)
            .map_err(|error| mpsc::TrySendError::Disconnected(error.0))
    }
}

pub(crate) struct Transport {
    pub(crate) sender: Sender,
    pub(crate) incoming: mpsc::Receiver<Incoming>,
    pub(crate) epoch: String,
}
impl Transport {
    pub(crate) fn bootstrap() -> io::Result<Self> {
        let raw = read_frame(&mut io::stdin().lock())?
            .ok_or_else(|| protocol_error("transport bootstrap is required"))?;
        let bootstrap: Bootstrap = serde_json::from_slice(&raw)
            .map_err(|_| protocol_error("invalid transport bootstrap"))?;
        if bootstrap.v != PROTOCOL_VERSION
            || bootstrap.kind != "transport-bootstrap"
            || bootstrap.token.is_empty()
            || bootstrap.chunk_bytes == 0
            || bootstrap.chunk_bytes > MAX_FRAME_BYTES - DATA_HEADER_BYTES
        {
            return Err(protocol_error("invalid transport bootstrap contract"));
        }
        let epoch = Uuid::new_v4().to_string();
        let mut control = connect(&bootstrap.control_endpoint)?;
        let mut data = connect(&bootstrap.data_endpoint)?;
        for (lane, connection) in [("control", &mut control), ("data", &mut data)] {
            write_frame(
                connection,
                &json!({"v":PROTOCOL_VERSION,"kind":"transport-auth","lane":lane,"token":bootstrap.token,"kernelEpoch":epoch}),
            )?;
            let accepted = read_frame(connection)?
                .ok_or_else(|| protocol_error("transport authentication disconnected"))?;
            let accepted: Value = serde_json::from_slice(&accepted)
                .map_err(|_| protocol_error("invalid transport authentication receipt"))?;
            if accepted
                != json!({"v":PROTOCOL_VERSION,"kind":"transport-bound","lane":lane,"kernelEpoch":epoch})
            {
                return Err(protocol_error("transport authentication was not accepted"));
            }
        }
        let control_read = control.try_clone()?;
        let data_read = data.try_clone()?;
        let (control_tx, control_rx) = mpsc::channel::<Control>();
        let (input_tx, input_rx) = mpsc::channel();
        let (encode_tx, encode_rx) = mpsc::channel::<(Uuid, Value)>();
        let shared = Arc::new(Shared {
            stopped: AtomicBool::new(false),
            control: control_tx,
            durable_cursor: Mutex::new(None),
            incoming: input_tx,
            scheduled: Mutex::new(Scheduler {
                streams: HashMap::new(),
                order: VecDeque::new(),
            }),
            changed: Condvar::new(),
            received: Mutex::new(HashMap::new()),
            response_lanes: Mutex::new(HashMap::new()),
            queued: AtomicUsize::new(0),
            epoch: epoch.clone(),
            chunk_bytes: bootstrap.chunk_bytes,
        });
        let writer = shared.clone();
        thread::spawn(move || {
            for frame in control_rx {
                let frame = match frame {
                    Control::Frame(frame) => Some(frame),
                    Control::DurableCursor => writer.durable_cursor.lock().unwrap().take(),
                };
                if frame.is_some_and(|frame| write_frame(&mut control, &frame).is_err()) {
                    writer.fail();
                    break;
                }
            }
        });
        let encoder = shared.clone();
        thread::spawn(move || {
            for (id, value) in encode_rx {
                if encoder
                    .scheduled
                    .lock()
                    .unwrap()
                    .streams
                    .get(&id)
                    .is_none_or(|stream| stream.aborting)
                {
                    continue;
                }
                let bytes = match serde_json::to_vec(&value) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        encoder.fail();
                        break;
                    }
                };
                let length = bytes.len();
                let mut scheduler = encoder.scheduled.lock().unwrap();
                let Some(stream) = scheduler
                    .streams
                    .get_mut(&id)
                    .filter(|stream| !stream.aborting)
                else {
                    continue;
                };
                stream.bytes = Some(bytes);
                scheduler.order.push_back(id);
                if encoder
                    .command("transport-stream-begin", id, json!({"byteLength":length}))
                    .is_err()
                {
                    encoder.fail();
                    break;
                }
                drop(scheduler);
                encoder.changed.notify_all();
            }
        });
        let data_writer = shared.clone();
        thread::spawn(move || {
            if write_data(data, &data_writer).is_err() {
                data_writer.fail();
            }
        });
        let reader = shared.clone();
        thread::spawn(move || {
            if read_control(control_read, &reader).is_err() {
                reader.fail();
            }
        });
        let reader = shared.clone();
        thread::spawn(move || {
            if read_data(data_read, &reader).is_err() {
                reader.fail();
            }
        });
        Ok(Self {
            sender: Sender {
                shared: Some(shared),
                encode: Some(encode_tx),
                #[cfg(test)]
                fixture: None,
            },
            incoming: input_rx,
            epoch,
        })
    }
    pub(crate) fn shutdown(&self) {
        self.sender.shared.as_ref().unwrap().fail();
    }
}

fn read_control(mut input: Connection, shared: &Arc<Shared>) -> io::Result<()> {
    while let Some(payload) = read_frame(&mut input)? {
        let value: Value =
            serde_json::from_slice(&payload).map_err(|_| protocol_error("invalid control JSON"))?;
        let kind = value["kind"].as_str().unwrap_or_default();
        if !kind.starts_with("transport-stream-") {
            if kind == "request" {
                let method = value["method"].as_str().unwrap_or_default();
                if !control_method(method) {
                    return Err(protocol_error("body request on control connection"));
                }
                let id = value["id"]
                    .as_str()
                    .ok_or_else(|| protocol_error("request identity required"))?;
                shared
                    .response_lanes
                    .lock()
                    .unwrap()
                    .insert(id.into(), response_lane(method));
            }
            shared
                .incoming
                .send(Incoming::Frame(value, Lane::Control))
                .map_err(|_| io::ErrorKind::BrokenPipe)?;
            continue;
        }
        if value["v"] != PROTOCOL_VERSION || value["kernelEpoch"].as_str() != Some(&shared.epoch) {
            return Err(protocol_error("content stream epoch mismatch"));
        }
        let id = Uuid::parse_str(value["streamId"].as_str().unwrap_or_default())
            .map_err(|_| protocol_error("invalid stream identity"))?;
        match kind {
            "transport-stream-open" => {
                let meta = value["identity"].clone();
                if !meta.is_object() {
                    return Err(protocol_error("stream identity required"));
                }
                if shared
                    .received
                    .lock()
                    .unwrap()
                    .insert(
                        id,
                        Arc::new(Mutex::new(Received {
                            meta: meta.clone(),
                            length: None,
                            bytes: Vec::new(),
                            sequence: 0,
                            abort_sequence: None,
                        })),
                    )
                    .is_some()
                {
                    return Err(protocol_error("duplicate content stream"));
                }
                if meta["kind"] == "request" {
                    let request_id = meta["id"]
                        .as_str()
                        .ok_or_else(|| protocol_error("request identity required"))?;
                    shared
                        .response_lanes
                        .lock()
                        .unwrap()
                        .insert(request_id.into(), Lane::Data);
                    shared
                        .incoming
                        .send(Incoming::Open(meta))
                        .map_err(|_| io::ErrorKind::BrokenPipe)?;
                }
            }
            "transport-stream-begin" => {
                let length = value["byteLength"]
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or_else(|| protocol_error("invalid content length"))?;
                let stream = shared
                    .received
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| protocol_error("unknown content stream"))?;
                if stream.lock().unwrap().length.replace(length).is_some() {
                    return Err(protocol_error("stream already began"));
                }
                shared.command("transport-stream-ready", id, json!({}))?;
            }
            "transport-stream-ready" => {
                let mut scheduler = shared.scheduled.lock().unwrap();
                let stream = scheduler
                    .streams
                    .get_mut(&id)
                    .ok_or_else(|| protocol_error("unknown outgoing stream"))?;
                if stream.aborting {
                    continue;
                }
                if stream.ready {
                    return Err(protocol_error("duplicate stream credit"));
                }
                stream.ready = true;
                shared.changed.notify_all();
            }
            "transport-stream-ack" => {
                let mut scheduler = shared.scheduled.lock().unwrap();
                let stream = scheduler
                    .streams
                    .get_mut(&id)
                    .ok_or_else(|| protocol_error("unknown outgoing stream"))?;
                if stream.aborting && value["sequence"].as_u64() == Some(stream.sequence) {
                    continue;
                }
                if !stream.waiting || value["sequence"].as_u64() != Some(stream.sequence) {
                    return Err(protocol_error("invalid stream acknowledgement"));
                }
                stream.waiting = false;
                shared.changed.notify_all();
            }
            "transport-stream-end" => {
                let stream = shared
                    .received
                    .lock()
                    .unwrap()
                    .remove(&id)
                    .ok_or_else(|| protocol_error("unknown incoming stream"))?;
                let mut stream = stream.lock().unwrap();
                let received = Received {
                    meta: stream.meta.clone(),
                    length: stream.length,
                    bytes: std::mem::take(&mut stream.bytes),
                    sequence: stream.sequence,
                    abort_sequence: None,
                };
                if received.length != Some(received.bytes.len())
                    || value["sequence"].as_u64() != Some(received.sequence)
                {
                    return Err(protocol_error("incomplete content stream"));
                }
                shared.command(
                    "transport-stream-ended",
                    id,
                    json!({"sequence":received.sequence}),
                )?;
                // Hydration is never performed by the control reader or a domain owner.
                let decoder = shared.clone();
                thread::spawn(move || {
                    let result = serde_json::from_slice::<Value>(&received.bytes);
                    match result {
                        Ok(value) if identity(&value) == received.meta => {
                            let _ = decoder.incoming.send(Incoming::Frame(value, Lane::Data));
                        }
                        _ => decoder.fail(),
                    }
                });
            }
            "transport-stream-abort" => {
                let stream = shared
                    .received
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| protocol_error("unknown aborted stream"))?;
                let mut received = stream.lock().unwrap();
                let sequence = value["sequence"]
                    .as_u64()
                    .ok_or_else(|| protocol_error("abort sequence required"))?;
                if received.abort_sequence.is_some() || sequence < received.sequence {
                    return Err(protocol_error("invalid abort sequence"));
                }
                received.abort_sequence = Some(sequence);
                received.bytes.clear();
                let meta = received.meta.clone();
                let drained = sequence == received.sequence;
                drop(received);
                shared
                    .incoming
                    .send(Incoming::Abort(meta))
                    .map_err(|_| io::ErrorKind::BrokenPipe)?;
                if drained {
                    shared.received.lock().unwrap().remove(&id);
                    shared.command("transport-stream-aborted", id, json!({"sequence":sequence}))?;
                }
            }
            "transport-stream-stop" => {
                let mut scheduler = shared.scheduled.lock().unwrap();
                let stream = scheduler
                    .streams
                    .get_mut(&id)
                    .ok_or_else(|| protocol_error("unknown stopped stream"))?;
                if stream.aborting || stream.ending {
                    continue;
                }
                stream.aborting = true;
                stream.bytes = None;
                let sequence = stream.sequence;
                scheduler.order.retain(|queued| *queued != id);
                shared.command("transport-stream-abort", id, json!({"sequence":sequence}))?;
            }
            "transport-stream-aborted" | "transport-stream-ended" => {
                let mut scheduler = shared.scheduled.lock().unwrap();
                let stream = scheduler
                    .streams
                    .get(&id)
                    .ok_or_else(|| protocol_error("unknown settled stream"))?;
                if value["sequence"].as_u64() != Some(stream.sequence)
                    || (kind == "transport-stream-aborted" && !stream.aborting)
                    || (kind == "transport-stream-ended" && !stream.ending)
                {
                    return Err(protocol_error("invalid stream settlement"));
                }
                scheduler.streams.remove(&id);
                scheduler.order.retain(|queued| *queued != id);
                shared.queued.fetch_sub(1, Ordering::AcqRel);
            }
            _ => return Err(protocol_error("unknown transport command")),
        }
    }
    Err(io::ErrorKind::UnexpectedEof.into())
}

fn read_data(mut input: Connection, shared: &Arc<Shared>) -> io::Result<()> {
    while let Some(payload) = read_frame(&mut input)? {
        if payload.len() < DATA_HEADER_BYTES {
            return Err(protocol_error("truncated data header"));
        }
        let id = Uuid::from_slice(&payload[..16])
            .map_err(|_| protocol_error("invalid data identity"))?;
        let sequence = u64::from_be_bytes(payload[16..24].try_into().unwrap());
        let stream = shared
            .received
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| protocol_error("unknown incoming data stream"))?;
        let mut stream = stream.lock().unwrap();
        if let Some(last) = stream.abort_sequence {
            if sequence != stream.sequence + 1 || sequence > last {
                return Err(protocol_error("invalid aborted chunk sequence"));
            }
            stream.sequence = sequence;
            drop(stream);
            if sequence == last {
                shared.received.lock().unwrap().remove(&id);
                shared.command("transport-stream-aborted", id, json!({"sequence":sequence}))?;
            }
            continue;
        }
        let length = stream
            .length
            .ok_or_else(|| protocol_error("content sent before stream began"))?;
        let chunk = &payload[DATA_HEADER_BYTES..];
        if chunk.is_empty()
            || sequence != stream.sequence + 1
            || chunk.len() > length.saturating_sub(stream.bytes.len())
        {
            return Err(protocol_error("invalid content chunk"));
        }
        stream.bytes.extend_from_slice(chunk);
        stream.sequence = sequence;
        shared.command("transport-stream-ack", id, json!({"sequence":sequence}))?;
        drop(stream);
    }
    Err(io::ErrorKind::UnexpectedEof.into())
}

fn write_data(mut output: Connection, shared: &Arc<Shared>) -> io::Result<()> {
    loop {
        let mut scheduler = shared.scheduled.lock().unwrap();
        let selected = loop {
            if shared.stopped.load(Ordering::Acquire) {
                return Ok(());
            }
            let mut selected = None;
            for _ in 0..scheduler.order.len() {
                let id = scheduler.order.pop_front().unwrap();
                scheduler.order.push_back(id);
                if scheduler.streams.get(&id).is_some_and(|stream| {
                    stream.ready
                        && !stream.waiting
                        && !stream.aborting
                        && !stream.ending
                        && stream.bytes.is_some()
                }) {
                    selected = Some(id);
                    break;
                }
            }
            if let Some(id) = selected {
                break id;
            }
            scheduler = shared.changed.wait(scheduler).unwrap();
        };
        let stream = scheduler.streams.get_mut(&selected).unwrap();
        if stream.offset == stream.bytes.as_ref().unwrap().len() {
            let sequence = stream.sequence;
            stream.ending = true;
            stream.bytes = None;
            shared.command(
                "transport-stream-end",
                selected,
                json!({"sequence":sequence}),
            )?;
            drop(scheduler);
            continue;
        }
        let bytes = stream.bytes.as_ref().unwrap();
        let end = (stream.offset + shared.chunk_bytes).min(bytes.len());
        stream.sequence += 1;
        let mut chunk = Vec::with_capacity(DATA_HEADER_BYTES + end - stream.offset);
        chunk.extend_from_slice(stream.stream_id.as_bytes());
        chunk.extend_from_slice(&stream.sequence.to_be_bytes());
        chunk.extend_from_slice(&bytes[stream.offset..end]);
        stream.offset = end;
        stream.waiting = true;
        drop(scheduler);
        crate::protocol::write_encoded_frame(&mut output, &chunk)?;
    }
}
