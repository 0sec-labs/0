//! Named, strict public review profiles. Provider credentials remain in their own loader.
use serde::{Deserialize, Deserializer};
use std::{collections::BTreeMap, error::Error, path::Path};
use zero_protocol::review::ReviewProfile;
struct Profiles(BTreeMap<String, ReviewProfile>);
impl<'de> Deserialize<'de> for Profiles {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Profiles;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("at most 128 unique named review profiles")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Profiles, A::Error> {
                let mut values = BTreeMap::new();
                while let Some((name, profile)) = map.next_entry::<String, ReviewProfile>()? {
                    if values.len() >= 128
                        || !valid_name(&name)
                        || values.insert(name, profile).is_some()
                    {
                        return Err(serde::de::Error::custom(
                            "invalid or duplicate review profile name",
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
pub async fn load(path: &Path) -> Result<Vec<(String, ReviewProfile)>, Box<dyn Error>> {
    let bytes = crate::providers::read_bounded(path).await?;
    let Profiles(values) =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid review profile configuration")?;
    for p in values.values() {
        p.validate()
            .map_err(|_| "Invalid review profile authority or bounds")?;
    }
    Ok(values.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> serde_json::Value {
        serde_json::json!({"schema_version":1,"provider":"p","model":"m","instructions":"Review source","question":"Inspect input handling","execution":{"backend":{"type":"docker","image":format!("sha256:{}","a".repeat(64))},"timeout_ms":1000,"memory_mb":128,"cpus":1.0,"max_output_bytes":4096},"budget_limit":100,"currency":"units","reservation_per_turn":10,"max_turns":4,"max_hypotheses":2,"deadline_ms":60000})
    }
    #[tokio::test]
    async fn review_profiles_reject_duplicates_unknown_authority_and_invalid_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let value = profile();
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"local":value})).unwrap(),
        )
        .unwrap();
        assert_eq!(load(&path).await.unwrap().len(), 1);
        let text = serde_json::to_string(&value).unwrap();
        std::fs::write(&path, format!("{{\"local\":{text},\"local\":{text}}}")).unwrap();
        assert!(load(&path).await.is_err());
        for (key, bad) in [
            ("http_profile", serde_json::json!("unauthorized")),
            ("max_turns", serde_json::json!(33)),
            ("deadline_ms", serde_json::json!(0)),
        ] {
            let mut invalid = value.clone();
            invalid[key] = bad;
            std::fs::write(
                &path,
                serde_json::to_vec(&serde_json::json!({"local":invalid})).unwrap(),
            )
            .unwrap();
            assert!(load(&path).await.is_err());
        }
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"../profile":value})).unwrap(),
        )
        .unwrap();
        assert!(load(&path).await.is_err());
    }
}
