use super::*;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::{fs::DirBuilderExt, net::{UnixListener, UnixStream}};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

pub(in crate::workspace_mount) struct Server {
    pub resource: PathBuf,
    pub attached: Arc<AtomicBool>,
    service: Arc<Service>,
    stopping: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
    sockets: Arc<Mutex<HashMap<uuid::Uuid, UnixStream>>>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    pub(in crate::workspace_mount) fn start(session: Arc<Session>) -> Result<Self, KernelError> {
        // A short OS-owned path fits sockaddr_un even when Application Support
        // or the project's actual name is long. Never use the project as IPC.
        let resource = PathBuf::from(format!("/tmp/varin-workspace-{}",uuid::Uuid::new_v4()));
        std::fs::DirBuilder::new().mode(0o700).create(&resource)?;
        let prepared = (|| {
            let service = Arc::new(Service::new(session.clone())?);
            let socket = resource.join("executor.sock");
            let listener = UnixListener::bind(&socket)?;
            let token = uuid::Uuid::new_v4().to_string();
            let generation = session.identity().to_string();
            use std::os::unix::fs::OpenOptionsExt;
            let mut manifest = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(resource.join("resource.json"))?;
            serde_json::to_writer(&mut manifest,&json!({"protocol":1,"socket":socket,"token":token,"generation":generation,
                "maxFrameBytes":crate::protocol::MAX_FRAME_BYTES}))?;
            manifest.sync_all()?;
            let stopping = Arc::new(AtomicBool::new(false));
            let shutdown = Arc::new(AtomicBool::new(false));
            let attached = Arc::new(AtomicBool::new(false));
            let sockets = Arc::new(Mutex::new(HashMap::new()));
            let (stop, live, channels, operations) = (stopping.clone(),attached.clone(),sockets.clone(),service.clone());
            let exiting = shutdown.clone();
            let worker = std::thread::spawn(move || {
                let mut workers:Vec<JoinHandle<()>> = Vec::new();
                for connection in listener.incoming() {
                    if exiting.load(Ordering::Acquire) { break; }
                    let Ok(mut stream) = connection else { break; };
                    let mut uid = 0; let mut gid = 0;
                    if unsafe {libc::getpeereid(stream.as_raw_fd(),&mut uid,&mut gid)} != 0 || uid != unsafe {libc::geteuid()} { continue; }
                    let id = uuid::Uuid::new_v4();
                    let Ok(shutdown) = stream.try_clone() else {continue;};
                    if let Ok(mut sockets) = channels.lock() {sockets.insert(id,shutdown);} else {break;}
                    let (token,generation,channels,stop,live,service) = (token.clone(),generation.clone(),channels.clone(),stop.clone(),live.clone(),operations.clone());
                    workers.push(std::thread::spawn(move || {
                        let mut control = false;
                        let accepted = (|| -> std::io::Result<()> {
                            let (hello,body) = read(&mut stream)?;
                            let requested_control = hello["role"] == "control";
                            if !body.is_empty() || hello["op"] != "attach" || hello["version"] != 1 || hello["token"] != token || hello["generation"] != generation
                                || (!requested_control && hello["role"] != "worker") {
                                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"Invalid mount executor admission"));
                            }
                            if requested_control && live.swap(true,Ordering::AcqRel) {return Err(std::io::Error::other("Mount already has an extension owner"));}
                            control=requested_control;
                            write(&mut stream,&json!({"value":null}),&[])?;
                            loop {
                                let (request,body) = read(&mut stream)?;
                                match service.dispatch(&request,&body) {
                                    Ok((value,body)) => write(&mut stream,&json!({"value":value}),&body)?,
                                    Err(error) => write(&mut stream,&json!({"errno":errno(&error),"code":kind_error(&error)}),&[])?,
                                }
                            }
                        })();
                        let _ = accepted; // Connection closure is observed by its original owner.
                        if control { live.store(false,Ordering::Release); if !stop.load(Ordering::Acquire) {service.session.mount_disconnected();} }
                        if let Ok(mut sockets) = channels.lock() {sockets.remove(&id);}
                    }));
                    let mut index=0;
                    while index<workers.len() {if workers[index].is_finished(){let _=workers.swap_remove(index).join();}else{index+=1;}}
                }
                if let Ok(sockets) = channels.lock() {for socket in sockets.values(){let _=socket.shutdown(std::net::Shutdown::Both);}}
                for worker in workers {let _=worker.join();}
            });
            Ok(Self {resource:resource.clone(),service,stopping,shutdown,attached,sockets,worker:Some(worker)})
        })();
        if prepared.is_err(){let _=std::fs::remove_dir_all(&resource);}
        prepared
    }
    pub(in crate::workspace_mount) fn open_count(&self) -> Result<usize, KernelError> {
        Ok(self.service.items.lock().map_err(|_|unsupported("FSKit item registry failed"))?.values().map(|item|item.opens).sum())
    }
    pub(in crate::workspace_mount) fn stopping(&self, value:bool) {self.stopping.store(value,Ordering::Release);}
    pub(in crate::workspace_mount) fn stop(&mut self) {
        self.stopping(true);
        self.shutdown.store(true,Ordering::Release);
        if let Ok(sockets) = self.sockets.lock(){for socket in sockets.values(){let _=socket.shutdown(std::net::Shutdown::Both);}}
        let _=UnixStream::connect(self.resource.join("executor.sock"));
        if let Some(worker)=self.worker.take(){let _=worker.join();}
        if let Ok(mut items)=self.service.items.lock(){items.clear();}
        let _=std::fs::remove_dir_all(&self.resource);
    }
}
impl Drop for Server {fn drop(&mut self){self.stop();}}
fn read(stream:&mut UnixStream)->std::io::Result<(Value,Vec<u8>)>{
    let mut header=[0;8];stream.read_exact(&mut header)?;
    let a=u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
    let b=u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if a==0 || a>crate::protocol::MAX_FRAME_BYTES || b>crate::protocol::MAX_FRAME_BYTES {return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"Native frame exceeds content protocol"));}
    let mut json=vec![0;a];stream.read_exact(&mut json)?;
    let mut body=vec![0;b];stream.read_exact(&mut body)?;
    Ok((serde_json::from_slice(&json)?,body))
}
fn write(stream:&mut UnixStream,value:&Value,body:&[u8])->std::io::Result<()>{
    let json=serde_json::to_vec(value)?;
    if json.len()>crate::protocol::MAX_FRAME_BYTES || body.len()>crate::protocol::MAX_FRAME_BYTES {return Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"Native reply exceeds content protocol"));}
    stream.write_all(&(json.len() as u32).to_le_bytes())?;stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(&json)?;stream.write_all(body)
}
fn errno(error:&KernelError)->i32{match kind_error(error){
    "denied"=>libc::EACCES,"cancelled"=>libc::EINTR,"namespace_missing"|"namespace_not_found"|"namespace_parent_missing"=>libc::ENOENT,
    "namespace_exists"|"namespace_xattr_exists"=>libc::EEXIST,"namespace_xattr_missing"=>libc::ENOATTR,
    "namespace_not_directory"=>libc::ENOTDIR,"namespace_is_directory"|"namespace_not_file"=>libc::EISDIR,
    "namespace_not_empty"=>libc::ENOTEMPTY,"namespace_stale_cursor"|"namespace_conflict"=>libc::ESTALE,
    "workspace_backend_unsupported"=>libc::ENOTSUP,_=>libc::EIO,
}}
