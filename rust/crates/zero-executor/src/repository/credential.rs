//! Host-only credential selector, deliberately excluded from acquisition receipts.
use base64::Engine;
use zero_protocol::source_acquisition::GitSource;

/// An explicit named environment secret, scoped to the exact selected repository.
/// This contains selectors only; never a secret or an ambient credential fallback.
#[derive(Clone, Debug)]
pub struct RepositoryCredential {
    pub environment: String,
    pub repository_url: String,
    pub username: String,
}
// No Debug/Serialize: the resolved value must never enter diagnostic/receipt paths.
pub(super) struct ResolvedCredential {
    pub key: String,
    pub header: String,
}
impl RepositoryCredential {
    pub(super) fn resolve(self, source: &GitSource) -> Result<ResolvedCredential, String> {
        self.validate_scope(source)?;
        let token = std::env::var(&self.environment)
            .map_err(|_| "selected Git credential environment is unavailable")?;
        self.with_token(&token)
    }
    fn validate_scope(&self, source: &GitSource) -> Result<(), String> {
        let GitSource::Https { url } = source else {
            return Err("Git credentials require explicit HTTPS acquisition".into());
        };
        source.validate()?;
        if &self.repository_url != url {
            return Err("Git credential repository scope differs from selected source".into());
        }
        // Narrow Git's URL-match input to literal host/repository components.
        // Encoded separators, globs, empty/root paths and trailing slashes must
        // not produce broader header scope through URL/config normalization.
        let path = url
            .strip_prefix("https://")
            .and_then(|u| u.split_once('/'))
            .map(|(_, p)| p)
            .ok_or("Git credential repository path absent")?;
        if path.is_empty()
            || path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !url
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~:/[]".contains(&b))
        {
            return Err("Git credential scope requires a literal canonical repository path".into());
        }
        let name = self.environment.as_bytes();
        if name.is_empty()
            || name.len() > 128
            || !(name[0].is_ascii_alphabetic() || name[0] == b'_')
            || !name.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
        {
            return Err("Git credential environment name invalid".into());
        }
        if self.username.is_empty()
            || self.username.len() > 256
            || !self
                .username
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b':')
        {
            return Err("Git credential username invalid".into());
        }
        Ok(())
    }
    fn with_token(&self, token: &str) -> Result<ResolvedCredential, String> {
        if token.is_empty() || token.len() > 8192 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("selected Git credential value invalid".into());
        }
        Ok(ResolvedCredential {
            key: format!("http.{}.extraHeader", self.repository_url),
            header: format!(
                "Authorization: Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{token}", self.username))
            ),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn selector(url: &str) -> RepositoryCredential {
        RepositoryCredential {
            environment: "PRIVATE_GIT_TOKEN".into(),
            repository_url: url.into(),
            username: "x-access-token".into(),
        }
    }
    #[test]
    fn rejects_widening_or_ambiguous_scope_and_header_injection() {
        let url = "https://example.test/org/repository.git";
        let c = selector(url);
        assert!(
            c.validate_scope(&GitSource::Https { url: url.into() })
                .is_ok()
        );
        assert!(
            c.validate_scope(&GitSource::Https {
                url: "https://other.test/org/repository.git".into()
            })
            .is_err()
        );
        assert!(
            c.validate_scope(&GitSource::Local {
                path: "/tmp/repo".into()
            })
            .is_err()
        );
        for url in [
            "https://example.test/",
            "https://example.test/org/repo/",
            "https://example.test/org%2Frepo",
            "https://example.test/org//repo",
            "https://example.test/org/*",
        ] {
            assert!(
                selector(url)
                    .validate_scope(&GitSource::Https { url: url.into() })
                    .is_err()
            );
        }
        for token in [
            "",
            "secret\nInjected: header",
            "secret\0suffix",
            "space token",
        ] {
            assert!(c.with_token(token).is_err());
        }
        assert!(c.with_token("fixture-token").is_ok());
    }
}
