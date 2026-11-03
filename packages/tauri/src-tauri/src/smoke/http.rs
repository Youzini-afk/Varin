//! The actual production authenticated Host frame route, over its owned
//! loopback listener. No arbitrary remote endpoints, URLs, files or JS.
use super::{Reply, http_body::Body};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};
#[derive(Clone)]
pub struct Client {
    port: u16,
    token: String,
}
struct DeadlineStream {
    stream: TcpStream,
    deadline: Instant,
}
impl Read for DeadlineStream {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "Original loopback observation deadline ended",
                )
            })?;
        self.stream
            .set_read_timeout(Some(remaining.min(Duration::from_secs(8))))?;
        self.stream.read(bytes)
    }
}
impl Client {
    pub fn new(snapshot: crate::host::HostSnapshot) -> Result<Self, String> {
        let origin = snapshot
            .origin
            .as_deref()
            .ok_or("The original native Host has no HTTP listener")?;
        let url = url::Url::parse(origin).map_err(|_| "Invalid native Host origin")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Native smoke only connects to its original loopback Host".into());
        }
        let token = snapshot
            .client_token
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b > 32 && b < 127))
            .ok_or("The original native Host omitted its authentication receipt")?;
        Ok(Self {
            port: url.port().ok_or("Native Host port missing")?,
            token,
        })
    }
    fn request(&self, path: &str) -> Result<(Body<BufReader<DeadlineStream>>, String), String> {
        let mut stream = TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, self.port)),
            Duration::from_secs(3),
        )
        .map_err(|_| "The original loopback Host could not be reached")?;
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .map_err(|_| "Loopback observation deadline could not be set")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|_| "Loopback send deadline could not be set")?;
        write!(stream,"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",self.port,self.token).map_err(|_|"The original loopback request could not be sent")?;
        let mut reader = BufReader::new(DeadlineStream {
            stream,
            deadline: Instant::now() + Duration::from_secs(12),
        });
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            reader
                .read_exact(&mut byte)
                .map_err(|_| "The native Host did not complete HTTP headers")?;
            header.push(byte[0]);
            if header.len() > 16384 {
                return Err("Native Host HTTP headers exceed their bound".into());
            }
        }
        let text =
            std::str::from_utf8(&header).map_err(|_| "Native Host HTTP headers are malformed")?;
        let mut lines = text.split("\r\n");
        let status = lines.next().and_then(|line| line.split_whitespace().nth(1));
        if status != Some("200") {
            return Err(format!(
                "The production Host route did not succeed (status {})",
                status.unwrap_or("missing")
            ));
        }
        let mut chunked = false;
        let mut length = None;
        let mut kind = None;
        for line in lines.filter(|line| !line.is_empty()) {
            let (key, value) = line.split_once(':').ok_or("Invalid native Host header")?;
            let value = value.trim();
            if key.eq_ignore_ascii_case("transfer-encoding") {
                if value != "chunked" {
                    return Err("Unsupported native Host transfer encoding".into());
                }
                chunked = true
            }
            if key.eq_ignore_ascii_case("content-length") {
                length = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| "Invalid native Host body length")?,
                )
            }
            if key.eq_ignore_ascii_case("content-type") {
                kind = Some(value.split(';').next().unwrap_or_default().to_owned())
            }
            if key.eq_ignore_ascii_case("content-encoding") && value != "identity" {
                return Err("Unexpected native Host content encoding".into());
            }
        }
        if chunked && length.is_some() {
            return Err("Ambiguous native Host response framing".into());
        }
        Ok((
            Body::new(reader, chunked, length),
            kind.ok_or("Native Host content type missing")?,
        ))
    }
    pub fn pages(&self) -> Reply {
        self.json("/api/browsers")
    }
    fn json(&self, path: &str) -> Reply {
        let (mut body, kind) = self.request(path)?;
        if kind != "application/json" {
            return Err("The production Browser listing is not JSON".into());
        }
        let mut bytes = Vec::new();
        body.by_ref()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Native Browser listing was incomplete")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Native Browser listing exceeds the isolated fixture budget".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Native Browser listing is malformed".into())
    }
    pub fn download(&self, page: &str, expected_url: &str) -> Reply {
        if !page.starts_with("native-smoke-")
            || !page.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid fixed native smoke page".into());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let download = loop {
            let list = self.json(&format!("/api/browsers/pages/{page}/downloads"))?;
            if let Some(download) = list
                .as_array()
                .and_then(|downloads| downloads.iter().find(|value| value["url"] == expected_url))
            {
                if download["state"] == "completed" {
                    break download.clone();
                }
                if download["state"] == "cancelled" || download["state"] == "interrupted" {
                    return Err("Original Node download did not complete successfully".into());
                }
            }
            if Instant::now() > deadline {
                return Err(
                    "The original Node Browser owner did not report the completed fixture download"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let id = download["downloadId"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .ok_or("Original Node download identity is invalid")?;
        let (mut body, kind) =
            self.request(&format!("/api/browsers/pages/{page}/downloads/{id}"))?;
        if kind != "application/octet-stream" {
            return Err(
                "The production download route did not return original binary bytes".into(),
            );
        }
        let mut bytes = Vec::new();
        body.by_ref()
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|_| "Original download read did not complete")?;
        if bytes != super::fixture::DOWNLOAD {
            return Err(
                "Original Node-owned download bytes differ from the fixture response".into(),
            );
        }
        Ok(
            json!({"downloadId":id,"state":download["state"],"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"transport":"authenticated-production-http-binary"}),
        )
    }
    pub fn frames(&self, page: &str) -> Reply {
        if !page.starts_with("native-smoke-")
            || !page.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid fixed native smoke page".into());
        }
        let stream_id = uuid::Uuid::new_v4().to_string();
        let (mut body, kind) = self.request(&format!(
            "/api/browsers/pages/{page}/frames?streamId={stream_id}"
        ))?;
        if kind != "application/x-varin-browser-frames" {
            return Err("The production Browser route did not return a binary frame stream".into());
        }
        let start = Instant::now();
        let mut frames = Vec::new();
        let mut hashes = HashSet::new();
        let mut identity: Option<Value> = None;
        let mut previous = None;
        let mut deliveries = 0;
        loop {
            let mut prefix = [0; 4];
            body.read_exact(&mut prefix).map_err(
                |_| "Hidden production screencast did not deliver a complete frame header",
            )?;
            let size = u32::from_be_bytes(prefix) as usize;
            if size == 0 || size > 16384 {
                return Err("Production frame header exceeds the protocol bound".into());
            }
            let mut header = vec![0; size];
            body.read_exact(&mut header)
                .map_err(|_| "Production frame metadata ended early")?;
            let header: Value = serde_json::from_slice(&header)
                .map_err(|_| "Production frame metadata is malformed")?;
            let size = header["byteLength"]
                .as_u64()
                .filter(|s| *s > 0 && *s <= 16 * 1024 * 1024)
                .ok_or("Production frame length violates its protocol bound")?
                as usize;
            let sequence = header["sequence"]
                .as_u64()
                .ok_or("Production frame sequence missing")?;
            if header["kind"] != "frame"
                || header["pageId"] != page
                || header["streamId"] != stream_id
                || header["mimeType"] != "image/jpeg"
                || previous.is_some_and(|previous| sequence <= previous)
            {
                return Err(
                    "Production frame identity/order did not match the original subscription"
                        .into(),
                );
            }
            let current = json!({"browserId":header["browserId"],"ownerGeneration":header["ownerGeneration"],"pageGeneration":header["pageGeneration"],"controlEpoch":header["controlEpoch"]});
            if current
                .as_object()
                .is_none_or(|o| o.values().any(Value::is_null))
                || identity.as_ref().is_some_and(|v| *v != current)
            {
                return Err(
                    "Production frame changed its original owner/page/control generation".into(),
                );
            }
            identity = Some(current);
            previous = Some(sequence);
            let mut bytes = vec![0; size];
            body.read_exact(&mut bytes)
                .map_err(|_| "Production frame pixels ended early")?;
            if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
                return Err(
                    "Production Browser stream did not contain complete JPEG pixels".into(),
                );
            }
            let hash = format!("{:x}", Sha256::digest(&bytes));
            deliveries += 1;
            if hashes.insert(hash.clone()) {
                frames.push(json!({"sha256":hash,"bytes":size,"sequence":sequence,"viewport":header["viewport"],"observedMs":start.elapsed().as_millis()as u64}));
            }
            if frames.len() >= 3 && start.elapsed() >= Duration::from_millis(400) {
                break;
            }
            if start.elapsed() > Duration::from_secs(8) || deliveries >= 240 {
                return Err(format!(
                    "Hidden production stream did not continuously deliver changing frames ({} distinct)",
                    frames.len()
                ));
            }
        }
        // Closing only this HTTP subscription drives the production owner's
        // unsubscribe path. The caller separately verifies lease release/page survival.
        drop(body);
        Ok(
            json!({"transport":"authenticated-production-http-binary","streamId":stream_id,"identity":identity,"deliveries":deliveries,"frames":frames}),
        )
    }
}
