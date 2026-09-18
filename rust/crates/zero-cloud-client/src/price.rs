//! Exact decimal USD per million to integer micro-USD per million conversion.
use crate::CloudError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

/// A bounded JSON numeric lexeme retained without an intermediate floating-point value.
/// Serialize directly to JSON to preserve the number; an intermediate generic
/// serde_json::Value has the ordinary JSON library's floating-point semantics.
#[derive(Debug, Clone)]
pub struct ExactPrice(Box<RawValue>);
impl ExactPrice {
    pub fn as_decimal(&self) -> &str {
        self.0.get()
    }
    pub fn from_decimal(raw: &str) -> Result<Self, CloudError> {
        if !numeric_lexeme(raw) {
            return Err(CloudError::InvalidResponse);
        }
        Ok(Self(
            RawValue::from_string(raw.to_owned()).map_err(|_| CloudError::InvalidResponse)?,
        ))
    }
    pub(crate) fn nonnegative(&self) -> bool {
        let raw = self.as_decimal();
        !raw.starts_with('-')
            || raw.split(['e', 'E']).next().is_some_and(|coefficient| {
                coefficient.bytes().all(|b| matches!(b, b'-' | b'.' | b'0'))
            })
    }
}
impl std::fmt::Display for ExactPrice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_decimal())
    }
}
impl Serialize for ExactPrice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ExactPrice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        if !numeric_lexeme(raw.get()) {
            return Err(serde::de::Error::custom(
                "invalid bounded catalog price number",
            ));
        }
        Ok(Self(raw))
    }
}
fn numeric_lexeme(raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 128 {
        return false;
    }
    let bytes = raw.as_bytes();
    let mut i = usize::from(bytes[0] == b'-');
    match bytes.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

pub(crate) fn micros(number: &ExactPrice) -> Result<u64, CloudError> {
    let raw = number.as_decimal();
    // Bound exponent/coefficient work independently of the HTTP body limit.
    if raw.len() > 128 {
        return Err(CloudError::InvalidResponse);
    }
    let negative = raw.starts_with('-');
    let unsigned = raw.strip_prefix('-').unwrap_or(raw);
    let (coefficient, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((coefficient, exponent)) => (
            coefficient,
            exponent
                .parse::<i32>()
                .map_err(|_| CloudError::InvalidResponse)?,
        ),
        None => (unsigned, 0),
    };
    let decimals = coefficient
        .split_once('.')
        .map_or(0, |(_, tail)| tail.len());
    let digits: String = coefficient.chars().filter(|c| *c != '.').collect();
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CloudError::InvalidResponse);
    }
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok(0);
    }
    if negative {
        return Err(CloudError::InvalidResponse);
    }
    let scale = i64::from(exponent) + 6 - decimals as i64;
    let (integer, zeros) = if scale >= 0 {
        if digits.len() as i64 + scale > 20 {
            return Err(CloudError::InvalidResponse);
        }
        (digits, scale as usize)
    } else {
        let remove = usize::try_from(-scale).map_err(|_| CloudError::InvalidResponse)?;
        if remove >= digits.len() || !digits[digits.len() - remove..].bytes().all(|b| b == b'0') {
            return Err(CloudError::InvalidResponse);
        }
        (&digits[..digits.len() - remove], 0)
    };
    let mut value = integer
        .parse::<u64>()
        .map_err(|_| CloudError::InvalidResponse)?;
    for _ in 0..zeros {
        value = value.checked_mul(10).ok_or(CloudError::InvalidResponse)?;
    }
    Ok(value)
}

pub(crate) fn normalized(number: &ExactPrice) -> Result<String, CloudError> {
    let amount = micros(number)?;
    let whole = amount / 1_000_000;
    let fraction = amount % 1_000_000;
    let decimal = if fraction == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{}", format!("{fraction:06}").trim_end_matches('0'))
    };
    Ok(decimal)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    fn price(raw: &str) -> ExactPrice {
        serde_json::from_str(raw).unwrap()
    }
    #[test]
    fn decimal_conversion_never_rounds_fractional_micros_or_overflow() {
        for (raw, expected) in [
            ("0", 0),
            ("-0", 0),
            ("-0.0", 0),
            ("0.000000000", 0),
            ("1", 1_000_000),
            ("1.25", 1_250_000),
            ("0.000001", 1),
            ("1e-6", 1),
            ("12.34000e-2", 123_400),
            ("1000e-9", 1),
            ("18446744073709.551615", u64::MAX),
        ] {
            assert_eq!(micros(&price(raw)).unwrap(), expected, "{raw}");
        }
        for raw in [
            "-1",
            "0.0000001",
            "1e-7",
            "1.00000000000000001",
            "18446744073709.551616",
            "18446744073710",
            "1e1000",
            "1e-1000",
        ] {
            assert!(micros(&price(raw)).is_err(), "accepted {raw}");
        }
    }
    #[test]
    fn equivalent_decimal_lexemes_have_one_normalized_price() {
        for raw in ["1.250000", "1.25", "125e-2", "1250000e-6"] {
            assert_eq!(normalized(&price(raw)).unwrap().to_string(), "1.25");
        }
        assert_eq!(normalized(&price("1e-6")).unwrap().to_string(), "0.000001");
        assert_eq!(normalized(&price("2.0000")).unwrap().to_string(), "2");
    }
}
