//! Base64 avoids expanding raw byte buffers into one JSON value per byte.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serializer};
pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&STANDARD.encode(bytes))
}
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let encoded = String::deserialize(deserializer)?;
    STANDARD.decode(encoded).map_err(serde::de::Error::custom)
}
#[cfg(test)]
mod tests {
    use crate::{ExecutionEvent, OutputStream};
    #[test]
    fn arbitrary_bytes_roundtrip_as_a_compact_string() {
        let bytes = vec![0, 255, 128, b'\n'];
        let event = ExecutionEvent::Output {
            execution_id: "e".into(),
            sequence: 1,
            stream: OutputStream::Stdout,
            bytes: bytes.clone(),
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["bytes"], "AP+ACg==");
        let decoded: ExecutionEvent = serde_json::from_value(value).unwrap();
        assert!(matches!(decoded,ExecutionEvent::Output{bytes:decoded,..} if decoded==bytes));
    }
}
