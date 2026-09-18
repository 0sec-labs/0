use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
/// Deliberately bounded JSON Schema subset; unsupported schema keywords reject.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Schema {
    String {
        #[serde(rename = "maxLength")]
        max_length: u32,
    },
    Integer {
        minimum: i64,
        maximum: i64,
    },
    Boolean,
    Array {
        items: Box<Schema>,
        #[serde(rename = "maxItems")]
        max_items: u32,
    },
    Object {
        properties: BTreeMap<String, Schema>,
        required: Vec<String>,
        #[serde(rename = "additionalProperties")]
        additional_properties: bool,
    },
}
impl Schema {
    pub fn validate(&self) -> Result<(), Error> {
        let mut nodes = 0;
        self.check(0, &mut nodes)
    }
    fn check(&self, depth: usize, nodes: &mut usize) -> Result<(), Error> {
        *nodes += 1;
        if depth > 16 || *nodes > 4096 {
            return Err(Error::Limit);
        }
        match self {
            Self::String { max_length } if *max_length > 100_000 => Err(Error::Limit),
            Self::Integer { minimum, maximum } if minimum > maximum => {
                Err(Error::Invalid("integer range"))
            }
            Self::Array { items, max_items } => {
                if *max_items > 1024 {
                    return Err(Error::Limit);
                }
                items.check(depth + 1, nodes)
            }
            Self::Object {
                properties,
                required,
                additional_properties,
            } => {
                if *additional_properties || properties.len() > 256 {
                    return Err(Error::Invalid("object schema"));
                }
                let mut seen = BTreeSet::new();
                for key in required {
                    if !properties.contains_key(key) || !seen.insert(key) {
                        return Err(Error::Invalid("required property"));
                    }
                }
                for (key, schema) in properties {
                    if !crate::identifier(key, 64, b"_") {
                        return Err(Error::Invalid("property name"));
                    }
                    schema.check(depth + 1, nodes)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    pub fn accepts(&self, value: &Value) -> Result<(), Error> {
        self.validate()?;
        if serde_json::to_vec(value)
            .map_err(|_| Error::Invalid("arguments"))?
            .len()
            > MAX_ARGUMENT_BYTES
        {
            return Err(Error::Limit);
        }
        if self.matches(value) {
            Ok(())
        } else {
            Err(Error::Invalid("tool arguments do not match schema"))
        }
    }
    fn matches(&self, v: &Value) -> bool {
        match self {
            Self::String { max_length } => v
                .as_str()
                .is_some_and(|s| s.chars().count() <= *max_length as usize),
            Self::Integer { minimum, maximum } => {
                v.as_i64().is_some_and(|n| n >= *minimum && n <= *maximum)
            }
            Self::Boolean => v.is_boolean(),
            Self::Array { items, max_items } => v.as_array().is_some_and(|a| {
                a.len() <= *max_items as usize && a.iter().all(|v| items.matches(v))
            }),
            Self::Object {
                properties,
                required,
                ..
            } => v.as_object().is_some_and(|o| {
                required.iter().all(|k| o.contains_key(k))
                    && o.iter()
                        .all(|(k, v)| properties.get(k).is_some_and(|s| s.matches(v)))
            }),
        }
    }
}
pub const MAX_ARGUMENT_BYTES: usize = 100_000;
