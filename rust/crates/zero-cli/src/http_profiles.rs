//! Explicit target authority configuration. Environment references and values stay private.
use serde::{Deserialize, Deserializer};
use std::{collections::BTreeMap, error::Error, path::Path, time::Duration};
use tokio::io::AsyncReadExt;
use zero_http::{Client, StaticAuth};
use zero_protocol::http::{HttpAuthDescriptor, HttpProfilePolicy};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    policy: HttpProfilePolicy,
    #[serde(default)]
    auth: Option<AuthConfig>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthConfig {
    revision: String,
    #[serde(deserialize_with = "zero_protocol::http::deserialize_headers")]
    headers_env: BTreeMap<String, String>,
}
struct Profiles(BTreeMap<String, Config>);
impl<'de> Deserialize<'de> for Profiles {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Profiles;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of at most 32 unique named HTTP profiles")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Profiles, A::Error> {
                let mut profiles = BTreeMap::new();
                while let Some((name, config)) = map.next_entry::<String, Config>()? {
                    if profiles.len() >= 32
                        || !valid_name(&name)
                        || profiles.insert(name, config).is_some()
                    {
                        return Err(serde::de::Error::custom(
                            "invalid or duplicate HTTP profile name",
                        ));
                    }
                }
                Ok(Profiles(profiles))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid_env(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}
pub async fn load(path: &Path) -> Result<Vec<(String, Client)>, Box<dyn Error>> {
    let read = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(nix::libc::O_NONBLOCK);
        let file = options.open(path).await?;
        if !file.metadata().await?.is_file() {
            return Err("HTTP profiles must be a regular JSON file".into());
        }
        let mut bytes = Vec::new();
        file.take((zero_protocol::MAX_FRAME_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > zero_protocol::MAX_FRAME_BYTES {
            return Err("HTTP profiles exceed the JSON byte limit".into());
        }
        Ok::<_, Box<dyn Error>>(bytes)
    };
    let bytes = tokio::select! {result=tokio::time::timeout(Duration::from_secs(5),read)=>result.map_err(|_|"HTTP profile read deadline exceeded")??,_=crate::server::shutdown_signal()=>return Err("HTTP profile read interrupted".into())};
    let Profiles(profiles) =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid HTTP profile configuration")?;
    let mut loaded = Vec::new();
    for (name, config) in profiles {
        let mut policy = config.policy;
        if policy.auth.is_some() {
            return Err("HTTP authentication descriptor must be derived from the private auth configuration".into());
        }
        let auth = match config.auth {
            None => None,
            Some(config) => {
                if config.headers_env.is_empty()
                    || config.headers_env.values().any(|name| !valid_env(name))
                {
                    return Err("Invalid HTTP credential environment reference".into());
                }
                let origin = zero_http::canonical_origin(&policy.base_url)?;
                let mut headers = BTreeMap::new();
                for (header, variable) in config.headers_env {
                    let value = std::env::var(&variable)
                        .map_err(|_| "HTTP credential environment variable is unavailable")?;
                    if value.is_empty()
                        || value.len() > 16384
                        || value.bytes().any(|b| matches!(b, 0 | b'\r' | b'\n'))
                    {
                        return Err("Invalid HTTP credential header value".into());
                    }
                    headers.insert(header.to_ascii_lowercase(), value);
                }
                policy.auth = Some(HttpAuthDescriptor {
                    revision: config.revision.clone(),
                    origin: origin.clone(),
                    header_names: headers.keys().cloned().collect(),
                });
                Some(StaticAuth::new(config.revision, origin, headers)?)
            }
        };
        let client = Client::new(policy, auth)?;
        loaded.push((name, client));
    }
    Ok(loaded)
}
