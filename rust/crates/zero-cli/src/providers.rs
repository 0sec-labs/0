use serde::Deserialize;
use std::{collections::BTreeMap, error::Error, path::Path, time::Duration};
use tokio::io::AsyncReadExt;
use zero_engine::Engine;
use zero_protocol::{
    MAX_FRAME_BYTES,
    model::{Rates, WireApi},
};
use zero_provider::{Endpoint, ProviderClient};

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Authentication {
    #[default]
    WireDefault,
    AzureApiKey,
    GithubCopilot,
    AzureEntra,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile {
    url: String,
    #[serde(default)]
    wire_api: WireApi,
    #[serde(default)]
    authentication: Authentication,
    api_key_env: Option<String>,
    entra_credentials_file: Option<std::path::PathBuf>,
    entra_token_endpoint: Option<String>,
    rates: Rates,
    timeout_ms: u64,
    max_response_bytes: usize,
}

pub async fn read_bounded(path: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
    let read = async {
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
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(5), read) =>
            result.map_err(|_| "JSON input deadline exceeded")?,
        _ = crate::server::shutdown_signal() => Err("JSON input interrupted".into()),
    }
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
        let endpoint = if matches!(profile.authentication, Authentication::AzureEntra) {
            if profile.api_key_env.is_some() {
                return Err(
                    "Entra credentials cannot be combined with an API key environment variable"
                        .into(),
                );
            }
            let credential_file = profile
                .entra_credentials_file
                .as_deref()
                .ok_or("Entra requires an explicit credential file")?;
            #[cfg(unix)]
            {
                tokio::select! {
                    result = tokio::time::timeout(Duration::from_secs(5), Endpoint::azure_entra(&profile.url, credential_file, profile.entra_token_endpoint.as_deref())) => result.map_err(|_| "Provider credential file deadline exceeded")??,
                    _ = crate::server::shutdown_signal() => return Err("Provider credential loading interrupted".into()),
                }
            }
            #[cfg(not(unix))]
            {
                let _ = credential_file;
                return Err("Entra credential rotation requires Unix private-file support".into());
            }
        } else {
            if profile.entra_credentials_file.is_some() || profile.entra_token_endpoint.is_some() {
                return Err("Entra credential fields require explicit Entra authentication".into());
            }
            // Report fixed messages: configuration can contain misplaced credentials.
            let key_env = profile
                .api_key_env
                .as_deref()
                .ok_or("Provider credential environment variable is required")?;
            if key_env.is_empty()
                || !key_env.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_alphabetic()
                        || byte == b'_'
                        || (index > 0 && byte.is_ascii_digit())
                })
            {
                return Err("Invalid provider credential environment variable name".into());
            }
            let key = std::env::var(key_env)
                .map_err(|_| "Provider credential environment variable is unavailable")?;
            if key.is_empty() {
                return Err("Provider credential environment variable is empty".into());
            }
            match profile.authentication {
                Authentication::WireDefault => Endpoint::responses(&profile.url, Some(&key))?,
                Authentication::AzureApiKey => Endpoint::azure_api_key(&profile.url, &key)?,
                Authentication::GithubCopilot => Endpoint::github_copilot(&profile.url, &key)?,
                Authentication::AzureEntra => unreachable!(),
            }
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn google_wire_is_explicit_and_preserves_exact_endpoint() {
        let profile: Profile=serde_json::from_value(json!({"url":"https://generativelanguage.googleapis.com/v1beta/models/exact-model:streamGenerateContent","wire_api":"google_generate_content","api_key_env":"KEY","rates":{"input":1,"cached_input":0,"output":1},"timeout_ms":1000,"max_response_bytes":8192})).unwrap();
        assert_eq!(profile.wire_api, WireApi::GoogleGenerateContent);
        assert!(matches!(
            profile.authentication,
            Authentication::WireDefault
        ));
        assert!(
            profile
                .url
                .ends_with("/models/exact-model:streamGenerateContent")
        );
    }

    #[test]
    fn authentication_is_optional_strict_and_never_inferred_from_url() {
        let mut profile = json!({"url":"https://azure.example/openai/v1/responses","api_key_env":"KEY","rates":{"input":1,"cached_input":0,"output":1},"timeout_ms":1000,"max_response_bytes":8192});
        let parsed: Profile = serde_json::from_value(profile.clone()).unwrap();
        assert!(matches!(parsed.authentication, Authentication::WireDefault));
        profile["authentication"] = json!("azure_api_key");
        let parsed: Profile = serde_json::from_value(profile.clone()).unwrap();
        assert!(matches!(parsed.authentication, Authentication::AzureApiKey));
        profile["authentication"] = json!("github_copilot");
        let parsed: Profile = serde_json::from_value(profile.clone()).unwrap();
        assert!(matches!(
            parsed.authentication,
            Authentication::GithubCopilot
        ));
        for invalid in [
            json!("automatic"),
            json!(null),
            json!({"header":"Authorization"}),
        ] {
            profile["authentication"] = invalid;
            assert!(serde_json::from_value::<Profile>(profile.clone()).is_err());
        }
        profile["authentication"] = json!("wire_default");
        profile["credential"] = json!("do not echo");
        assert!(serde_json::from_value::<Profile>(profile).is_err());
    }
}
