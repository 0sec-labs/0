//! Legacy cloud.env resolution with bounded reads and fixed, secret-free errors.
use std::{collections::BTreeMap, error::Error, path::PathBuf, time::Duration};
use tokio::io::AsyncReadExt;
const DEFAULT_HOST: &str = "https://cloud.0.security";
const DEFAULT_TOKEN_ENV: &str = "0SEC_CLOUD_TOKEN";
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;
/// Intentionally no Debug/Serialize: token never becomes a diagnostic object.
pub struct Credentials {
    pub host: String,
    pub token: String,
}
fn env(name: &str) -> Result<Option<String>, Box<dyn Error>> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err("Hosted credential environment is not UTF-8".into()),
    }
}
pub async fn resolve(
    host_override: Option<&str>,
    token_env: &str,
) -> Result<Credentials, Box<dyn Error>> {
    if token_env.is_empty()
        || !token_env
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("Invalid hosted token environment variable name".into());
    }
    if let Some(token) = env(token_env)?
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
    {
        let host = match host_override {
            Some(host) => host.to_owned(),
            None => env("0SEC_CLOUD_HOST")?.unwrap_or_else(|| DEFAULT_HOST.into()),
        };
        return Ok(Credentials {
            host: host.trim().into(),
            token,
        });
    }
    if token_env != DEFAULT_TOKEN_ENV {
        return Err("Named hosted token environment variable is unavailable or empty; file fallback is disabled".into());
    }
    let home = std::env::var_os("HOME")
        .or_else(|| {
            if cfg!(windows) {
                std::env::var_os("USERPROFILE")
            } else {
                None
            }
        })
        .filter(|v| !v.is_empty())
        .ok_or("Home directory is unavailable for hosted credentials")?;
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err("Hosted credential home directory must be absolute".into());
    }
    let path = home.join(".0sec").join("cloud.env");
    let read = async {
        let before = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|_| "Hosted credential file is unavailable")?;
        if !before.is_file() {
            return Err("Hosted credentials require a regular file, not a symlink");
        }
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|_| "Hosted credential file cannot be read")?;
        let metadata = file
            .metadata()
            .await
            .map_err(|_| "Hosted credential file metadata unavailable")?;
        if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
            return Err("Hosted credential file exceeds limits or is not regular");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if before.dev() != metadata.dev() || before.ino() != metadata.ino() {
                return Err("Hosted credential file changed while opening");
            }
            if metadata.permissions().mode() & 0o777 != 0o600 {
                return Err("Hosted credential file permissions must be 0600");
            }
        }
        let mut bytes = Vec::new();
        file.take(MAX_CREDENTIAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Hosted credential file cannot be read")?;
        if bytes.len() as u64 > MAX_CREDENTIAL_BYTES {
            return Err("Hosted credential file exceeds byte limit");
        }
        Ok::<_, &'static str>(bytes)
    };
    let bytes = tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .map_err(|_| "Hosted credential file read deadline exceeded")??;
    let raw = String::from_utf8(bytes).map_err(|_| "Hosted credential file must be UTF-8")?;
    let values = parse(&raw)?;
    let token = values
        .get(DEFAULT_TOKEN_ENV)
        .filter(|v| !v.is_empty())
        .ok_or("Hosted credential file has no token")?
        .clone();
    // A file token is paired with its file host, never an unrelated env host.
    let host = host_override
        .map(str::to_owned)
        .or_else(|| values.get("0SEC_CLOUD_HOST").cloned())
        .unwrap_or_else(|| DEFAULT_HOST.into());
    Ok(Credentials {
        host: host.trim().into(),
        token,
    })
}
fn parse(raw: &str) -> Result<BTreeMap<String, String>, Box<dyn Error>> {
    let mut result = BTreeMap::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or("Malformed hosted credential file")?;
        let key = key.trim();
        let value = value.trim();
        if key.is_empty()
            || !key
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            || value.starts_with(['\'', '"'])
            || value.contains('\0')
            || result.insert(key.into(), value.into()).is_some()
        {
            return Err("Malformed or duplicate hosted credential entry".into());
        }
    }
    Ok(result)
}
