use serde_json::json;
use zero_plugin::*;
#[test]
fn arbitrary_byte_splits_utf8_newlines_and_multiple_frames_roundtrip() {
    let frames = vec![
        Frame::Request {
            id: 7,
            call: Call {
                tool: "inspect".into(),
                input: json!({"text":"µ\nnext"}),
            },
        },
        Frame::Result {
            id: 7,
            result: json!({"output":"🦀"}),
        },
        Frame::Error {
            id: 8,
            error: RpcError {
                code: -32601,
                message: "unsupported".into(),
            },
        },
    ];
    let bytes: Vec<_> = frames.iter().flat_map(|f| f.encode().unwrap()).collect();
    for width in [1, 2, 3, 11, bytes.len()] {
        let mut decoder = Decoder::new();
        let mut got = vec![];
        for chunk in bytes.chunks(width) {
            decoder.feed(chunk, |f| got.push(f)).unwrap();
        }
        decoder.finish().unwrap();
        assert_eq!(got, frames);
    }
}
#[test]
fn invalid_versions_methods_authority_fields_and_ambiguous_frames_poison() {
    for text in [
        r#"{"jsonrpc":"1.0","id":1,"result":null}"#,
        r#"{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":0,"message":"both"}}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"grant","params":{"tool":"inspect","input":{}}}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"tool.invoke","params":{"tool":"inspect","input":{},"trusted":true}}"#,
        r#"{"jsonrpc":"2.0","id":1,"id":2,"result":null}"#,
        r#"{"jsonrpc":"2.0","method":"tool.invoke","params":{"tool":"inspect","input":{}}}"#,
    ] {
        let mut decoder = Decoder::new();
        assert!(
            decoder
                .feed(format!("{text}\n").as_bytes(), |_| panic!(
                    "bad frame delivered"
                ))
                .is_err()
        );
        assert!(matches!(decoder.feed(b"{}\n", |_| {}), Err(Error::Framing)));
        assert!(decoder.finish().is_err());
    }
}
#[test]
fn unterminated_oversized_frames_and_oversized_results_fail_boundedly() {
    let mut d = Decoder::new();
    assert!(matches!(
        d.feed(&vec![b'x'; MAX_FRAME_BYTES + 1], |_| {}),
        Err(Error::Limit)
    ));
    assert!(d.finish().is_err());
    let mut d = Decoder::new();
    d.feed(b"{", |_| {}).unwrap();
    assert!(matches!(d.finish(), Err(Error::Framing)));
    assert!(matches!(
        Frame::Result {
            id: 1,
            result: json!("x".repeat(MAX_RESULT_BYTES))
        }
        .encode(),
        Err(Error::Limit)
    ));
    let mut d = Decoder::new();
    assert!(d.feed(&[0xff, b'\n'], |_| {}).is_err());
}
#[test]
fn parsed_request_is_data_and_does_not_change_any_registry_policy() {
    let bytes = Frame::Request {
        id: 1,
        call: Call {
            tool: "inspect".into(),
            input: json!({"enabled":true,"grants":["network"]}),
        },
    }
    .encode()
    .unwrap();
    let mut d = Decoder::new();
    let mut got = vec![];
    d.feed(&bytes, |f| got.push(f)).unwrap();
    assert_eq!(got.len(), 1);
    // The codec carries arbitrary tool argument data; admission/schema is a
    // separate mandatory stage. There is intentionally no registry callback.
    assert!(matches!(&got[0],Frame::Request{call,..} if call.input["enabled"]==true));
}
