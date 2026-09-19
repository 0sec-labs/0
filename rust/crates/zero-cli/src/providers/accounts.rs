//! Explicit read-only bridge to the legacy v2 account store. No discovery/refresh.
use super::Authentication;
use serde::Deserialize;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use zero_protocol::model::WireApi;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Selector {
    file: PathBuf,
    provider_id: String,
    account_id: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Account {
    ApiKey {
        secret: String,
    },
    Oauth {
        tokens: Tokens,
        #[serde(default)]
        identity: Option<serde_json::Value>,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tokens {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_at: Option<u64>,
    token_type: Option<String>,
    scope: Option<String>,
}
fn fail() -> String {
    "Selected provider account is unavailable, incompatible or invalid".into()
}
impl Selector {
    pub(super) fn load(&self, wire: WireApi, auth: &Authentication) -> Result<String, String> {
        let id = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        };
        if !id(&self.provider_id) || !id(&self.account_id) {
            return Err(fail());
        }
        let copilot = matches!(auth, Authentication::GithubCopilot)
            && wire == WireApi::ChatCompletions
            && self.provider_id == "copilot";
        let api_key = match (self.provider_id.as_str(), auth, wire) {
            ("anthropic", Authentication::WireDefault, WireApi::AnthropicMessages) => true,
            (
                "azure",
                Authentication::AzureApiKey,
                WireApi::Responses | WireApi::ChatCompletions,
            ) => true,
            (
                "openai",
                Authentication::WireDefault,
                WireApi::Responses | WireApi::ChatCompletions,
            ) => true,
            (
                "deepseek" | "openrouter" | "z-ai" | "kimi" | "qwen" | "xai" | "opencode",
                Authentication::WireDefault,
                WireApi::ChatCompletions,
            ) => true,
            _ => false,
        };
        if !copilot && !api_key {
            return Err(fail());
        }
        let bytes = read_private(&self.file)?;
        let store: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
        if store["version"] != 2 {
            return Err(fail());
        }
        let record = store
            .get("providers")
            .and_then(|p| p.get(&self.provider_id))
            .and_then(|p| p.get("accounts"))
            .and_then(|p| p.get(&self.account_id))
            .ok_or_else(fail)?;
        let account: Account = serde_json::from_value(record.clone()).map_err(|_| fail())?;
        let secret = match account {
            Account::ApiKey { secret } if api_key => secret,
            Account::Oauth { tokens, identity } if copilot => {
                let _unused = (identity, tokens.refresh_token, tokens.scope);
                if tokens
                    .token_type
                    .as_deref()
                    .is_some_and(|v| !v.eq_ignore_ascii_case("bearer"))
                {
                    return Err(fail());
                }
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| fail())?
                    .as_millis();
                if tokens
                    .expires_at
                    .is_some_and(|expires| u128::from(expires) <= now)
                {
                    return Err(fail());
                }
                tokens.access_token.ok_or_else(fail)?
            }
            _ => return Err(fail()),
        };
        if secret.is_empty()
            || secret.len() > 16384
            || !secret.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(fail());
        }
        Ok(secret)
    }
}
#[cfg(not(unix))]
fn read_private(_: &std::path::Path) -> Result<Vec<u8>, String> {
    Err("Stored provider accounts require Unix private-file support".into())
}
#[cfg(unix)]
fn read_private(path: &std::path::Path) -> Result<Vec<u8>, String> {
    read_checked(path, || {})
}
#[cfg(unix)]
fn read_checked(path: &std::path::Path, after_read: impl FnOnce()) -> Result<Vec<u8>, String> {
    use nix::{
        fcntl::{OFlag, open, openat},
        sys::stat::Mode,
        unistd::geteuid,
    };
    use std::{
        fs::File,
        io::Read,
        os::unix::fs::MetadataExt,
        path::{Component, Path},
    };
    fn anchor(path: &Path) -> Result<(File, std::ffi::OsString), String> {
        let components: Vec<_> = path.components().collect();
        if !path.is_absolute()
            || path.as_os_str().len() > 4096
            || components.len() < 2
            || components
                .iter()
                .skip(1)
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(fail());
        }
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut dir = File::from(open(Path::new("/"), flags, Mode::empty()).map_err(|_| fail())?);
        for part in &components[1..components.len() - 1] {
            dir = File::from(
                openat(&dir, part.as_os_str(), flags, Mode::empty()).map_err(|_| fail())?,
            );
        }
        let meta = dir.metadata().map_err(|_| fail())?;
        if meta.uid() != geteuid().as_raw() || meta.mode() & 0o077 != 0 {
            return Err(fail());
        }
        Ok((
            dir,
            components.last().ok_or_else(fail)?.as_os_str().to_owned(),
        ))
    }
    fn file(dir: &File, name: &std::ffi::OsStr) -> Result<File, String> {
        let f = File::from(
            openat(
                dir,
                name,
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let m = f.metadata().map_err(|_| fail())?;
        if !m.is_file()
            || m.uid() != geteuid().as_raw()
            || m.nlink() != 1
            || m.mode() & 0o7777 != 0o600
            || m.len() > 1024 * 1024
        {
            return Err(fail());
        }
        Ok(f)
    }
    let (dir, name) = anchor(path)?;
    let f = file(&dir, &name)?;
    let before = f.metadata().map_err(|_| fail())?;
    let mut bytes = Vec::new();
    (&f).take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail())?;
    after_read();
    let after = f.metadata().map_err(|_| fail())?;
    let (current_dir, current_name) = anchor(path)?;
    let current = file(&current_dir, &current_name)?
        .metadata()
        .map_err(|_| fail())?;
    let identity = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
            m.mode(),
            m.nlink(),
            m.uid(),
        )
    };
    if bytes.len() > 1024 * 1024
        || identity(&before) != identity(&after)
        || identity(&after) != identity(&current)
    {
        return Err(fail());
    }
    Ok(bytes)
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn read_rejects_replacement_symlinks_hardlinks_and_nonprivate_files() {
        let d = tempfile::tempdir().unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let p = d.path().join("credentials.json");
        let write = || {
            std::fs::write(&p, b"original").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        };
        write();
        assert_eq!(read_private(&p).unwrap(), b"original");
        assert!(
            read_checked(&p, || {
                let replacement = d.path().join("replacement");
                std::fs::write(&replacement, b"replaced").unwrap();
                std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o600))
                    .unwrap();
                std::fs::rename(replacement, &p).unwrap();
            })
            .is_err()
        );
        assert!(
            read_checked(&p, || {
                std::fs::write(&p, b"in-place-changed").unwrap();
            })
            .is_err()
        );
        write();
        let fifo = d.path().join("fifo");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
        assert!(read_private(&fifo).is_err());
        std::fs::hard_link(&p, d.path().join("hardlink")).unwrap();
        assert!(read_private(&p).is_err());
        std::fs::remove_file(d.path().join("hardlink")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_private(&p).is_err());
        write();
        let link = d.path().join("link");
        symlink(&p, &link).unwrap();
        assert!(read_private(&link).is_err());
        let parent_link = d.path().join("parent-link");
        symlink(d.path(), &parent_link).unwrap();
        assert!(read_private(&parent_link.join("credentials.json")).is_err());
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read_private(&p).is_err());
    }
}
