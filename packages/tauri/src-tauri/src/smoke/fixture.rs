//! A bounded, loopback-only HTTP fixture. No file serving or arbitrary handlers.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
pub const DOWNLOAD: &[u8] = b"Varin native Chromium download acceptance\n";
const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';navigate-to 'self'"><style>body{margin:0;background:white}button{position:absolute;left:40px;top:40px;width:160px;height:90px}a{position:absolute;top:160px}canvas{position:absolute;left:240px;top:20px}</style><button onclick="varinSmoke.clicks++">Native page interaction</button><a id="download" href="/download" download="varin-smoke.bin">Download</a><canvas id="animation" width="256" height="128"></canvas><script>window.varinSmoke={marker:crypto.randomUUID(),clicks:0,frames:0};const ctx=document.getElementById('animation').getContext('2d');function paint(){const n=++varinSmoke.frames;ctx.fillStyle=`rgb(${n*37%256},${n*67%256},${n*97%256})`;ctx.fillRect(0,0,256,128);ctx.fillStyle='black';ctx.font='32px monospace';ctx.fillText(String(n),16,70);requestAnimationFrame(paint)}requestAnimationFrame(paint)</script>"#;
struct State {
    stopping: AtomicBool,
    connections: AtomicUsize,
    stream_closed: AtomicBool,
    stream_cookie: Mutex<Option<bool>>,
}
pub struct Server {
    port: u16,
    state: Arc<State>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    pub fn start() -> Result<Self, String> {
        let listener =
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let state = Arc::new(State {
            stopping: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            stream_closed: AtomicBool::new(false),
            stream_cookie: Mutex::new(None),
        });
        let worker = state.clone();
        let thread = thread::Builder::new()
            .name("varin-smoke-http".into())
            .spawn(move || {
                let mut clients: Vec<thread::JoinHandle<()>> = Vec::new();
                while !worker.stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut socket, _)) => {
                            if worker.connections.fetch_add(1, Ordering::AcqRel) >= 32 {
                                worker.connections.fetch_sub(1, Ordering::AcqRel);
                                continue;
                            }
                            let state = worker.clone();
                            clients.push(thread::spawn(move || {
                                let _ = serve(&mut socket, &state);
                                state.connections.fetch_sub(1, Ordering::AcqRel);
                            }));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                    let mut index = 0;
                    while index < clients.len() {
                        if clients[index].is_finished() {
                            let _ = clients.swap_remove(index).join();
                        } else {
                            index += 1;
                        }
                    }
                }
                // No fixture threads survive the native scope receipt.
                for client in clients {
                    let _ = client.join();
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            port,
            state,
            thread: Some(thread),
        })
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn stream_closed(&self) -> bool {
        self.state.stream_closed.load(Ordering::Acquire)
    }
    pub fn stream_cookie(&self) -> Option<bool> {
        *self.state.stream_cookie.lock().unwrap()
    }
    pub fn stop(mut self) {
        self.state.stopping.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.state.stopping.store(true, Ordering::Release);
    }
}
fn serve(socket: &mut TcpStream, state: &State) -> std::io::Result<()> {
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = socket.read(&mut buffer)?;
        if n == 0 {
            return Ok(());
        }
        request.extend_from_slice(&buffer[..n]);
        if request.len() > 16384 {
            return Ok(());
        }
    }
    let text = String::from_utf8_lossy(&request);
    let route = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    if route == "/stream" {
        *state.stream_cookie.lock().unwrap() = Some(
            text.lines()
                .any(|l| l.to_ascii_lowercase().starts_with("cookie:")),
        );
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")?;
        let mut bytes = vec![b'x'; 65536];
        bytes[..14].copy_from_slice(b"native-stream\n");
        while !state.stopping.load(Ordering::Acquire) {
            if write!(socket, "{:x}\r\n", bytes.len())
                .and_then(|_| socket.write_all(&bytes))
                .and_then(|_| socket.write_all(b"\r\n"))
                .is_err()
            {
                state.stream_closed.store(true, Ordering::Release);
                return Ok(());
            }
            thread::sleep(Duration::from_millis(10));
        }
        return Ok(());
    }
    let (status, kind, body, extra) = match route {
        "/page" => ("200 OK", "text/html", PAGE.as_bytes(), ""),
        "/download" => (
            "200 OK",
            "application/octet-stream",
            DOWNLOAD,
            "Content-Disposition: attachment; filename=varin-smoke.bin\r\n",
        ),
        _ => ("404 Not Found", "text/plain", &b"Not found"[..], ""),
    };
    write!(
        socket,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
        body.len()
    )?;
    socket.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_http_download_matches_fixture() {
        let server = Server::start().unwrap();
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.port)).unwrap();
        stream
            .write_all(b"GET /download HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        assert!(bytes.starts_with(b"HTTP/1.1 200 OK"));
        assert!(bytes.ends_with(DOWNLOAD));
        server.stop();
    }
    #[test]
    fn original_stream_disconnect_is_observed() {
        let server = Server::start().unwrap();
        let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.port)).unwrap();
        stream
            .write_all(b"GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut bytes = [0; 256];
        assert!(stream.read(&mut bytes).unwrap() > 0);
        stream.shutdown(std::net::Shutdown::Both).unwrap();
        drop(stream);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !server.stream_closed() {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.stream_cookie(), Some(false));
        server.stop();
    }
}
