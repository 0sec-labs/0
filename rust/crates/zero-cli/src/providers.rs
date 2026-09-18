use serde::Deserialize;
use std::{collections::BTreeMap, error::Error, path::Path, time::Duration};
use tokio::io::AsyncReadExt;
use zero_engine::Engine;
use zero_protocol::{
    MAX_FRAME_BYTES,
    model::{Rates, WireApi},
};
use zero_provider::{Endpoint, ProviderClient};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    url: String,
    #[serde(default)]
    wire_api: WireApi,
    api_key_env: String,
    rates: Rates,
    timeout_ms: u64,
    max_response_bytes: usize,
}

pub async fn read_bounded(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err("JSON file exceeds the frame byte limit".into());
    }
    Ok(bytes)
}

pub async fn load(path: &Path) -> Result<Vec<(String, ProviderClient, Rates)>, Box<dyn Error>> {
    let profiles: BTreeMap<String, Profile> = serde_json::from_slice(&read_bounded(path).await?)
        .map_err(|_| "Invalid provider configuration JSON")?;
    let mut loaded = Vec::new();
    for (name, profile) in profiles {
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("Invalid provider profile name".into());
        }
        // Report fixed messages: configuration can contain misplaced credentials.
        if profile.api_key_env.is_empty()
            || !profile
                .api_key_env
                .bytes()
                .enumerate()
                .all(|(index, byte)| {
                    byte.is_ascii_alphabetic()
                        || byte == b'_'
                        || (index > 0 && byte.is_ascii_digit())
                })
        {
            return Err("Invalid provider credential environment variable name".into());
        }
        let key = std::env::var(&profile.api_key_env)
            .map_err(|_| "Provider credential environment variable is unavailable")?;
        if key.is_empty() {
            return Err("Provider credential environment variable is empty".into());
        }
        let endpoint = Endpoint::responses(&profile.url, Some(&key))?;
        let client = ProviderClient::with_wire(
            endpoint,
            profile.wire_api,
            Duration::from_millis(profile.timeout_ms),
            profile.max_response_bytes,
        )?;
        loaded.push((name, client, profile.rates));
    }
    Ok(loaded)
}

pub async fn configure(engine: &Engine, path: &Path) -> Result<(), Box<dyn Error>> {
    for (name, client, rates) in load(path).await? {
        engine.configure_provider(&name, client, rates)?;
    }
    Ok(())
}
