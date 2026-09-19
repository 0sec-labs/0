use serde_json::json;
use zero_plugin::{MAX_FRAME_BYTES, WorkerDecoder, WorkerFrame};
#[test]
fn fragmentation_correlation_fields_and_poison_are_explicit() {
    let frames = [
        WorkerFrame::Ready { version: 1 },
        WorkerFrame::CapabilityRequest {
            call_id: 1,
            id: 2,
            operation: "host.inspect".into(),
            input: json!({}),
        },
        WorkerFrame::Shutdown,
    ];
    let mut decoder = WorkerDecoder::default();
    let mut received = vec![];
    for frame in &frames {
        for byte in frame.encode().unwrap() {
            decoder.feed(&[byte], |v| received.push(v)).unwrap();
        }
    }
    decoder.finish().unwrap();
    assert_eq!(received, frames);
    for bytes in [
        b"{\"type\":\"ready\",\"version\":2}\n".as_slice(),
        b"{\"type\":\"result\",\"id\":0,\"result\":null}\n",
        b"{\"type\":\"result\",\"id\":9007199254740992,\"result\":null}\n",
        b"{\"type\":\"ready\",\"version\":1,\"grant\":true}\n",
    ] {
        let mut decoder = WorkerDecoder::default();
        assert!(decoder.feed(bytes, |_| {}).is_err());
        assert!(decoder.feed(&frames[0].encode().unwrap(), |_| {}).is_err());
    }
}
#[test]
fn frame_and_payload_bounds_and_truncated_eof_are_enforced() {
    let mut decoder = WorkerDecoder::default();
    assert!(
        decoder
            .feed(&vec![b'x'; MAX_FRAME_BYTES + 1], |_| {})
            .is_err()
    );
    assert!(decoder.finish().is_err());
    let mut decoder = WorkerDecoder::default();
    decoder.feed(b"{", |_| {}).unwrap();
    assert!(decoder.finish().is_err());
    assert!(
        WorkerFrame::Result {
            id: 1,
            result: json!("x".repeat(100001))
        }
        .encode()
        .is_err()
    );
    assert!(
        WorkerFrame::CapabilityRequest {
            call_id: 1,
            id: 1,
            operation: "host.inspect".into(),
            input: json!(1)
        }
        .encode()
        .is_err()
    );
}

#[test]
fn encoded_control_character_expansion_is_charged_before_frame_retention() {
    assert!(
        WorkerFrame::Result {
            id: 1,
            result: json!("\0".repeat(20_000))
        }
        .encode()
        .is_err()
    );
}
