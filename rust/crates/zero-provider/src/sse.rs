//! Byte-wise framing keeps split UTF-8 intact until a complete SSE event exists.
use crate::TransportError;
const MAX_LINE: usize = 1024 * 1024;
const MAX_EVENT: usize = 4 * 1024 * 1024;
#[derive(Default)]
pub(crate) struct Decoder {
    line: Vec<u8>,
    data: Vec<u8>,
}
impl Decoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, TransportError> {
        let mut frames = Vec::new();
        for byte in bytes {
            if *byte != b'\n' {
                self.line.push(*byte);
                if self.line.len() > MAX_LINE {
                    return Err(TransportError::ResponseLimit);
                }
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            if self.line.is_empty() {
                if !self.data.is_empty() {
                    self.data.pop();
                    frames.push(std::mem::take(&mut self.data));
                }
            } else if let Some(mut field) = self.line.strip_prefix(b"data:") {
                if field.first() == Some(&b' ') {
                    field = &field[1..];
                }
                if self.data.len() + field.len() + 1 > MAX_EVENT {
                    return Err(TransportError::ResponseLimit);
                }
                self.data.extend_from_slice(field);
                self.data.push(b'\n');
            }
            self.line.clear();
        }
        Ok(frames)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunk_boundaries_crlf_comments_and_multiline_are_preserved() {
        let fixture = ":comment\r\ndata: {\r\ndata: \"text\":\"€\"}\r\n\r\n".as_bytes();
        for split in 0..fixture.len() {
            let mut decoder = Decoder::default();
            let mut frames = decoder.feed(&fixture[..split]).unwrap();
            frames.extend(decoder.feed(&fixture[split..]).unwrap());
            assert_eq!(frames, vec!["{\n\"text\":\"€\"}".as_bytes()]);
        }
    }
    #[test]
    fn rejects_unbounded_unterminated_lines() {
        assert!(matches!(
            Decoder::default().feed(&vec![b'x'; MAX_LINE + 1]),
            Err(TransportError::ResponseLimit)
        ));
    }
}
