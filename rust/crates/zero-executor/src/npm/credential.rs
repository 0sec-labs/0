//! Host-selected npm credential; no ambient npmrc, serialization or default headers.
use reqwest::header::HeaderValue;
use zero_protocol::source_acquisition::{NpmReceipt, NpmSource};
#[derive(Clone, Debug)]
pub struct NpmCredential {
    pub environment: String,
    pub registry: String,
}
pub(super) struct ResolvedCredential {
    registry: String,
    header: HeaderValue,
    token: String,
}
impl NpmCredential {
    pub(super) fn resolve(self, source: &NpmSource) -> Result<ResolvedCredential, String> {
        source.validate()?;
        if self.registry != source.registry || !literal_base(&self.registry) {
            return Err(
                "npm credential scope must equal the literal selected registry base".into(),
            );
        }
        let name = self.environment.as_bytes();
        if name.is_empty()
            || name.len() > 128
            || !(name[0].is_ascii_alphabetic() || name[0] == b'_')
            || !name.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            return Err("npm credential environment name invalid".into());
        }
        let token = std::env::var(&self.environment)
            .map_err(|_| "selected npm credential environment is unavailable")?;
        if token.is_empty() || token.len() > 8192 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("selected npm credential value invalid".into());
        }
        if self.registry.contains(&token) {
            return Err("npm credential cannot occur in the registry URL".into());
        }
        let mut header = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "selected npm credential value invalid")?;
        header.set_sensitive(true);
        Ok(ResolvedCredential {
            registry: self.registry,
            header,
            token,
        })
    }
}
fn literal_base(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-._~:/[]".contains(&b))
        && value
            .split_once("://")
            .and_then(|(_, v)| v.split_once('/'))
            .is_some_and(|(_, path)| {
                path.strip_suffix('/')
                    .unwrap_or(path)
                    .split('/')
                    .all(|p| p != "." && p != ".." && (path.is_empty() || !p.is_empty()))
            })
}
impl ResolvedCredential {
    pub(super) fn header_for(&self, url: &str) -> Result<HeaderValue, String> {
        // Metadata may encode the slash in a scoped package name. This exact
        // generated endpoint is safe; callers validate it before reaching here.
        if !url.starts_with(&self.registry) || url.contains(&self.token) {
            return Err("npm authenticated destination escapes registry credential scope".into());
        }
        Ok(self.header.clone())
    }
    pub(super) fn validate_receipt_paths(&self, receipt: &NpmReceipt) -> Result<(), String> {
        if std::iter::once(receipt.snapshot.root.as_str())
            .chain(receipt.snapshot.files.iter().map(|file| file.path.as_str()))
            .chain(receipt.executable_paths.iter().map(String::as_str))
            .any(|path| path.contains(&self.token))
        {
            return Err("npm archive paths contain selected credential material".into());
        }
        Ok(())
    }
    pub(super) fn validate_tarball(&self, url: &str) -> Result<(), String> {
        // A trailing slash in the frozen base supplies the path boundary.
        // Reject encoded separators/dot aliases rather than decoding a broader
        // destination; public uncredentialed acquisition retains its old rules.
        if !literal_base(url)
            || !url.starts_with(&self.registry)
            || url == self.registry
            || url.contains(&self.token)
        {
            return Err("npm authenticated tarball escapes literal registry path scope".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_path_boundary_and_sensitive_headers_are_preserved() {
        let mut header = HeaderValue::from_static("Bearer fixture-only-secret");
        header.set_sensitive(true);
        let credential = ResolvedCredential {
            registry: "https://registry.example/private/".into(),
            header,
            token: "fixture-only-secret".into(),
        };
        assert!(
            credential
                .header_for("https://registry.example/private/%40scope%2Fpkg/1.2.3")
                .unwrap()
                .is_sensitive()
        );
        assert!(
            credential
                .validate_tarball("https://registry.example/private/pkg/-/pkg-1.2.3.tgz")
                .is_ok()
        );
        for url in [
            "https://other.example/private/package.tgz",
            "https://registry.example/private-other/package.tgz",
            "https://registry.example/package.tgz",
            "https://registry.example/private/%2e%2e/package.tgz",
            "https://registry.example/private/../package.tgz",
            "https://registry.example/private//package.tgz",
            "https://registry.example/private/fixture-only-secret.tgz",
        ] {
            assert!(credential.validate_tarball(url).is_err(), "{url}");
        }
        assert!(literal_base("https://registry.example/"));
        assert!(literal_base("http://127.0.0.1:1234/private/"));
        assert!(!literal_base("https://registry.example/private%2Fother/"));
    }
}
