use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serializer};
pub fn serialize<S: Serializer>(
    bytes: &[u8],
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&STANDARD.encode(bytes))
}
pub fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<u8>, D::Error> {
    let encoded = String::deserialize(deserializer)?;
    if encoded.len() > (64usize * 1024).div_ceil(3) * 4 {
        return Err(serde::de::Error::custom("expected stream exceeds 64 KiB"));
    }
    let bytes = STANDARD.decode(encoded).map_err(serde::de::Error::custom)?;
    if bytes.len() > 64 * 1024 {
        return Err(serde::de::Error::custom("expected stream exceeds 64 KiB"));
    }
    Ok(bytes)
}
