//! Named, strict public scan profiles. Provider and target credentials remain in their own loaders.
use serde::{Deserialize, Deserializer};
use std::{collections::BTreeMap, error::Error, path::Path};
use zero_protocol::scan::ScanProfile;
struct Profiles(BTreeMap<String, ScanProfile>);
impl<'de> Deserialize<'de> for Profiles {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Profiles;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("at most 128 unique named scan profiles")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Profiles, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((name, profile)) = map.next_entry::<String, ScanProfile>()? {
                    if values.len() >= 128
                        || !valid_name(&name)
                        || values.insert(name, profile).is_some()
                    {
                        return Err(serde::de::Error::custom(
                            "invalid or duplicate scan profile name",
                        ));
                    }
                }
                Ok(Profiles(values))
            }
        }
        d.deserialize_map(Visitor)
    }
}
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub async fn load(path: &Path) -> Result<Vec<(String, ScanProfile)>, Box<dyn Error>> {
    let bytes = crate::providers::read_bounded(path).await?;
    let Profiles(values) =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid scan profile configuration")?;
    for p in values.values() {
        p.validate()
            .map_err(|_| "Invalid scan profile authority or bounds")?;
    }
    Ok(values.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_profile_names_and_secret_shaped_unknown_fields_reject() {
        let p = serde_json::json!({"schema_version":1,"kind":"scoped_http","provider":"p","model":"m","instructions":"Bounded HTTP","http_profile":"h","budget_limit":10,"currency":"units","reservation_per_turn":1,"max_turns":1,"max_hypotheses":1,"deadline_ms":1000});
        let text = serde_json::to_string(&p).unwrap();
        assert!(
            serde_json::from_str::<Profiles>(&format!("{{\"p\":{text},\"p\":{text}}}")).is_err()
        );
        let mut bad = p.clone();
        bad["api_key"] = serde_json::json!("SECRET");
        assert!(serde_json::from_value::<Profiles>(serde_json::json!({"p":bad})).is_err());
        assert!(serde_json::from_value::<Profiles>(serde_json::json!({"p":p})).is_ok());
    }
}
