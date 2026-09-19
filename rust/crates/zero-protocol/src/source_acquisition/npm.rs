//! Exact-version published package provenance. Integrity is not publisher authentication.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};

pub fn validate_npm_name(name: &str) -> Result<(), String> {
    let part = |p: &str| {
        !p.is_empty()
            && !p.starts_with(['.', '_'])
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
    };
    let valid = if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, name)| part(scope) && part(name))
    } else {
        part(name)
    };
    if name.len() > 214 || !valid {
        return Err("npm package name must be explicit and canonical".into());
    }
    Ok(())
}
pub fn validate_npm_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.len() > 128 {
        return Err("npm requires an exact semantic version".into());
    }
    let (core, build) = version
        .split_once('+')
        .map_or((version, None), |(a, b)| (a, Some(b)));
    let (core, pre) = core
        .split_once('-')
        .map_or((core, None), |(a, b)| (a, Some(b)));
    let numeric = |v: &str| {
        !v.is_empty()
            && v.bytes().all(|b| b.is_ascii_digit())
            && (v == "0" || !v.starts_with('0'))
            && v.parse::<u64>().is_ok()
    };
    let parts: Vec<_> = core.split('.').collect();
    if parts.len() != 3 || !parts.into_iter().all(numeric) {
        return Err("npm version must not be a tag, range or shorthand".into());
    }
    for (value, prerelease) in [(pre, true), (build, false)] {
        if let Some(value) = value {
            if value.split('.').any(|v| {
                v.is_empty()
                    || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || (prerelease && v.bytes().all(|b| b.is_ascii_digit()) && !numeric(v))
            }) {
                return Err("invalid npm version suffix".into());
            }
        }
    }
    Ok(())
}
fn registry_url(value: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(value).map_err(|_| "invalid npm URL")?;
    let loopback = u.host_str().is_some_and(|h| {
        h == "localhost"
            || h.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if value.len() > 2048
        || u.as_str() != value
        || !(u.scheme() == "https" || (u.scheme() == "http" && loopback))
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return Err("npm URL must be canonical HTTPS or explicit loopback HTTP without credentials/query/fragment".into());
    }
    Ok(u)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NpmSource {
    pub registry: String,
    pub package: String,
    pub version: String,
}
impl NpmSource {
    pub fn validate(&self) -> Result<(), String> {
        validate_npm_name(&self.package)?;
        validate_npm_version(&self.version)?;
        registry_url(&self.registry)?;
        if !self.registry.ends_with('/') {
            return Err("npm registry must end with slash".into());
        }
        Ok(())
    }
    pub fn metadata_url(&self) -> Result<String, String> {
        self.validate()?;
        let mut u = registry_url(&self.registry)?;
        u.path_segments_mut()
            .map_err(|_| "registry cannot be a base")?
            .pop_if_empty()
            .push(&self.package)
            .push(&self.version);
        Ok(u.to_string())
    }
    pub fn validate_tarball(&self, value: &str) -> Result<(), String> {
        self.validate()?;
        let registry = registry_url(&self.registry)?;
        let tar = registry_url(value)?;
        if registry.origin() != tar.origin() {
            return Err("npm tarball must use the explicit registry origin".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NpmReceipt {
    pub schema_version: u32,
    pub source: NpmSource,
    pub metadata_sha256: String,
    pub tarball_url: String,
    pub integrity: String,
    pub tarball_sha256: String,
    pub tarball_bytes: u64,
    pub snapshot: SnapshotPin,
    pub executable_paths: Vec<String>,
}
impl NpmReceipt {
    pub fn integrity_bytes(value: &str) -> Result<Vec<u8>, String> {
        let encoded = value
            .strip_prefix("sha512-")
            .ok_or("npm requires SHA-512 integrity")?;
        if encoded.len() != 88 {
            return Err("invalid npm SHA-512 integrity length".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "invalid npm integrity")?;
        if bytes.len() != 64 || STANDARD.encode(&bytes) != encoded {
            return Err("invalid npm SHA-512 integrity".into());
        }
        Ok(bytes)
    }
    pub fn validate(&self) -> Result<(), String> {
        self.source.validate_tarball(&self.tarball_url)?;
        Self::integrity_bytes(&self.integrity)?;
        if self.schema_version != 1
            || !is_sha256(&self.metadata_sha256)
            || !is_sha256(&self.tarball_sha256)
            || self.tarball_bytes == 0
            || self.tarball_bytes > 32 * 1024 * 1024
        {
            return Err("invalid npm receipt identity or bounds".into());
        }
        validate_snapshot(&self.snapshot, &self.executable_paths)
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, String> {
        self.validate()?;
        serde_json::to_vec(&serde_json::to_value(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NpmReceiptRef {
    pub input_path: String,
    pub receipt_sha256: String,
    pub source: NpmSource,
    pub metadata_sha256: String,
    pub tarball_url: String,
    pub integrity: String,
    pub tarball_sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_version_and_registry_authority() {
        for name in ["lodash", "@scope/pkg", "one.two-three_4"] {
            validate_npm_name(name).unwrap();
        }
        for name in [
            "",
            "../p",
            "@scope",
            "@s/p/extra",
            "Upper",
            "_hidden",
            "npm:other",
        ] {
            assert!(validate_npm_name(name).is_err(), "{name}");
        }
        for version in ["1.2.3", "0.0.0-alpha.1+build.001", "1.2.3-rc-x"] {
            validate_npm_version(version).unwrap();
        }
        for version in [
            "latest", "next", "^1.2.3", "~1.2.3", "1", "v1.2.3", "01.2.3", "1.2.3-01", "1.2.3+",
            "1.2.3\n",
        ] {
            assert!(validate_npm_version(version).is_err(), "{version}");
        }
        let mut source = NpmSource {
            registry: "https://registry.example/".into(),
            package: "@scope/pkg".into(),
            version: "1.2.3".into(),
        };
        assert_eq!(
            source.metadata_url().unwrap(),
            "https://registry.example/@scope%2Fpkg/1.2.3"
        );
        source
            .validate_tarball("https://registry.example/path/pkg.tgz")
            .unwrap();
        for url in [
            "https://other.example/pkg.tgz",
            "http://registry.example/pkg.tgz",
            "https://user:secret@registry.example/pkg.tgz",
            "https://registry.example/pkg.tgz?token=x",
            "https://registry.example/../pkg.tgz",
            "https://REGISTRY.example/pkg.tgz",
        ] {
            assert!(source.validate_tarball(url).is_err(), "{url}");
        }
        for registry in [
            "http://public.example/",
            "https://example.test",
            "https://example.test/#x",
        ] {
            source.registry = registry.into();
            assert!(source.validate().is_err());
        }
        source.registry = "http://127.0.0.1:1234/".into();
        source.validate().unwrap();
    }
    #[test]
    fn strong_integrity_only_and_historical_git_bytes_unchanged() {
        let integrity = format!("sha512-{}", STANDARD.encode([9u8; 64]));
        assert_eq!(NpmReceipt::integrity_bytes(&integrity).unwrap(), [9u8; 64]);
        for value in [
            "sha1-abc",
            "sha512-abc",
            &(integrity.clone() + " sha256-other"),
            integrity.trim_end_matches('='),
        ] {
            assert!(NpmReceipt::integrity_bytes(value).is_err());
        }
        let literal = r#"{"schema_version":1,"object_format":"sha1","source":{"kind":"https","url":"https://example.test/repo"},"requested_ref":"refs/heads/main","commit_oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tree_oid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","snapshot":{"id":"capture","root":"/private/source","digest":"sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","files":[]},"executable_paths":[]}"#;
        let old: RepositoryReceipt = serde_json::from_str(literal).unwrap();
        let polymorphic: SourceReceipt = serde_json::from_str(literal).unwrap();
        assert_eq!(serde_json::to_string(&old).unwrap(), literal);
        assert_eq!(serde_json::to_string(&polymorphic).unwrap(), literal);
        assert_eq!(
            old.canonical_bytes().unwrap(),
            polymorphic.canonical_bytes().unwrap()
        );
        let input = AcquisitionReceiptInput {
            input_path: "/private/receipt.json".into(),
            receipt: polymorphic,
        };
        let reference = input.reference().unwrap();
        let AcquisitionReceiptRef::Git(old_ref) = &reference else {
            panic!()
        };
        assert_eq!(
            serde_json::to_vec(old_ref).unwrap(),
            serde_json::to_vec(&reference).unwrap()
        );
        let mut unknown = serde_json::to_value(&input.receipt).unwrap();
        unknown["integrity"] = serde_json::json!(integrity);
        assert!(serde_json::from_value::<SourceReceipt>(unknown).is_err());
    }
}
