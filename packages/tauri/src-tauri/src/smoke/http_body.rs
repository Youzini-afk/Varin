//! Bounded HTTP/1.1 body reader for the fixed, owned loopback smoke connection.
//! Production Browser clients use their normal HTTP implementation.
use std::io::{self, BufRead, Read};
const MAX_CHUNK: usize = 32 * 1024 * 1024;
pub struct Body<R> {
    reader: R,
    chunked: bool,
    remaining: usize,
    boundary: bool,
    ended: bool,
}
impl<R: BufRead> Body<R> {
    pub fn new(reader: R, chunked: bool, length: Option<usize>) -> Self {
        Self {
            reader,
            chunked,
            remaining: length.unwrap_or(usize::MAX),
            boundary: false,
            ended: false,
        }
    }
    fn line(&mut self) -> io::Result<Vec<u8>> {
        let mut line = Vec::new();
        loop {
            let mut byte = [0];
            self.reader.read_exact(&mut byte)?;
            line.push(byte[0]);
            if line.len() > 1024 {
                return Err(io::Error::other("Loopback chunk line exceeds its bound"));
            }
            if line.ends_with(b"\r\n") {
                line.truncate(line.len() - 2);
                return Ok(line);
            }
        }
    }
}
impl<R: BufRead> Read for Body<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.ended {
            return Ok(0);
        }
        if self.chunked && (!self.boundary || self.remaining == 0) {
            if self.boundary {
                let mut crlf = [0; 2];
                self.reader.read_exact(&mut crlf)?;
                if crlf != *b"\r\n" {
                    return Err(io::Error::other("Invalid loopback chunk boundary"));
                }
            }
            let line = self.line()?;
            let size = line.split(|b| *b == b';').next().unwrap_or_default();
            self.remaining = std::str::from_utf8(size)
                .ok()
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .and_then(|s| usize::from_str_radix(s, 16).ok())
                .filter(|size| *size <= MAX_CHUNK)
                .ok_or_else(|| io::Error::other("Invalid loopback chunk length"))?;
            self.boundary = true;
            if self.remaining == 0 {
                let mut total = 0;
                loop {
                    let line = self.line()?;
                    total += line.len() + 2;
                    if total > 16 * 1024 {
                        return Err(io::Error::other("Loopback trailers exceed their bound"));
                    }
                    if line.is_empty() {
                        break;
                    }
                }
                self.ended = true;
                return Ok(0);
            }
        }
        if self.remaining == 0 {
            self.ended = true;
            return Ok(0);
        }
        let count = output.len().min(self.remaining);
        let read = self.reader.read(&mut output[..count])?;
        if read == 0 {
            if self.chunked || self.remaining != usize::MAX {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Original loopback response ended before its declared bytes",
                ));
            }
            self.ended = true;
            return Ok(0);
        }
        if self.remaining != usize::MAX {
            self.remaining -= read
        }
        Ok(read)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_chunks_preserve_original_packet_bytes() {
        let wire = b"3\r\nabc\r\n2;ignored=yes\r\nde\r\n0\r\nX-Test: done\r\n\r\n";
        let mut body = Body::new(&wire[..], true, None);
        let mut bytes = Vec::new();
        let mut chunk = [0; 2];
        loop {
            let n = body.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(bytes, b"abcde");
    }
    #[test]
    fn short_declared_chunk_never_succeeds() {
        let mut body = Body::new(&b"5\r\nabc"[..], true, None);
        assert!(body.read_to_end(&mut Vec::new()).is_err());
    }
    #[test]
    fn oversized_or_malformed_chunk_is_rejected_before_allocation() {
        for wire in [
            &b"ffffffffffffffff\r\n"[..],
            &b"+3\r\nabc"[..],
            &b"2\r\nab!!0\r\n\r\n"[..],
        ] {
            assert!(
                Body::new(wire, true, None)
                    .read_to_end(&mut Vec::new())
                    .is_err()
            );
        }
    }
    #[test]
    fn content_length_and_close_delimited_bodies_remain_distinct() {
        let mut output = Vec::new();
        Body::new(&b"abcd"[..], false, Some(3))
            .read_to_end(&mut output)
            .unwrap();
        assert_eq!(output, b"abc");
        assert!(
            Body::new(&b"ab"[..], false, Some(3))
                .read_to_end(&mut Vec::new())
                .is_err()
        );
        output.clear();
        Body::new(&b"ab"[..], false, None)
            .read_to_end(&mut output)
            .unwrap();
        assert_eq!(output, b"ab");
    }
}
