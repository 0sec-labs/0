use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// A malformed line does not prevent the next independently framed request.
#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Data(Vec<u8>),
    Oversized,
}

/// Reads one NDJSON record with bounded allocation, draining oversized records.
/// EOF accepts a final record without a newline, but never invents an empty one.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Option<Frame>> {
    let mut frame = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if oversized {
                Some(Frame::Oversized)
            } else if frame.is_empty() {
                None
            } else {
                Some(Frame::Data(frame))
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(available.len());
        if !oversized {
            if frame.len().saturating_add(take) > limit {
                oversized = true;
                frame.clear();
            } else {
                frame.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            if frame.last() == Some(&b'\r') {
                frame.pop();
            }
            return Ok(Some(if oversized {
                Frame::Oversized
            } else {
                Frame::Data(frame)
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn drains_oversized_record_and_retains_following_request() {
        let mut reader = BufReader::with_capacity(2, &b"1234567\nok\r\nlast"[..]);
        assert_eq!(
            read_frame(&mut reader, 4).await.unwrap(),
            Some(Frame::Oversized)
        );
        assert_eq!(
            read_frame(&mut reader, 4).await.unwrap(),
            Some(Frame::Data(b"ok".to_vec()))
        );
        assert_eq!(
            read_frame(&mut reader, 4).await.unwrap(),
            Some(Frame::Data(b"last".to_vec()))
        );
        assert_eq!(read_frame(&mut reader, 4).await.unwrap(), None);
    }
}
