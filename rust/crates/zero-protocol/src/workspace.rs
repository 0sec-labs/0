//! Host-captured workspace scope. Exclusions never weaken snapshot verification.
use crate::{SnapshotPin, is_sha256};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceSelectionMode {
    #[default]
    ExcludeNativeState,
    FullTree,
}
impl WorkspaceSelectionMode {
    pub fn is_default(&self) -> bool {
        *self == Self::ExcludeNativeState
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceSelectionPolicy {
    FullTree,
    ExcludeNativeState { state_relative_path: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSelectionReceipt {
    pub schema_version: u32,
    /// Canonical original caller directory; distinct from private staging paths.
    pub original_root: String,
    pub policy: WorkspaceSelectionPolicy,
    /// Exact file-path rules, whether or not those files existed at capture time.
    pub exclusions: Vec<String>,
    pub snapshot_sha256: String,
    pub file_count: u32,
    pub bytes: u64,
}
fn invalid() -> String {
    "invalid workspace selection scope or snapshot identity".into()
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && !path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
}
impl WorkspaceSelectionPolicy {
    pub fn exclusions(&self) -> Result<Vec<String>, String> {
        match self {
            Self::FullTree => Ok(vec![]),
            Self::ExcludeNativeState {
                state_relative_path: path,
            } => {
                if !relative(path) {
                    return Err(invalid());
                }
                let mut rules: Vec<_> = ["", "-wal", "-shm", "-journal", ".engine-lock"]
                    .iter()
                    .map(|suffix| format!("{path}{suffix}"))
                    .collect();
                if rules.iter().any(|p| !relative(p)) {
                    return Err(invalid());
                }
                rules.sort();
                Ok(rules)
            }
        }
    }
}
impl WorkspaceSelectionReceipt {
    pub fn validate_pin(&self, pin: &SnapshotPin) -> Result<(), String> {
        let original = self.original_root.as_str();
        let canonical = original == "/"
            || (original.starts_with('/')
                && !original.chars().any(char::is_control)
                && !original[1..]
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == ".."));
        if self.schema_version != 1
            || !canonical
            || original.len() > 4096
            || self.exclusions != self.policy.exclusions()?
            || !is_sha256(&self.snapshot_sha256)
            || self.snapshot_sha256 != pin.digest
            || pin.files.is_empty()
            || pin.files.len() > 4096
            || self.file_count as usize != pin.files.len()
        {
            return Err(invalid());
        }
        let mut total = 0u64;
        let mut previous: Option<&str> = None;
        let mut seen = std::collections::BTreeSet::new();
        for file in &pin.files {
            if !relative(&file.path)
                || !is_sha256(&file.digest)
                || previous.is_some_and(|p| p >= file.path.as_str())
                || file
                    .path
                    .match_indices('/')
                    .any(|(i, _)| seen.contains(&file.path[..i]))
                || self.exclusions.iter().any(|p| {
                    p == &file.path
                        || file.path.starts_with(&format!("{p}/"))
                        || p.starts_with(&format!("{}/", file.path))
                })
            {
                return Err(invalid());
            }
            previous = Some(&file.path);
            seen.insert(file.path.as_str());
            total = total.checked_add(file.bytes).ok_or_else(invalid)?;
            if total > 64 * 1024 * 1024 {
                return Err(invalid());
            }
        }
        if self.bytes != total {
            return Err(invalid());
        }
        let files: Vec<_> = pin
            .files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "bytes":f.bytes,"digest":f.digest,"path":f.path
                })
            })
            .collect();
        let encoded = serde_json::to_vec(&files).map_err(|_| invalid())?;
        if format!("sha256:{:x}", Sha256::digest(encoded)) != self.snapshot_sha256 {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn prompt_scope(&self) -> String {
        // Render as structured host metadata, not executable instructions from paths.
        format!(
            "\nHost-captured workspace scope (data): {}\nOnly the selected snapshot was provided. Excluded control paths and uncaptured files are outside this review's coverage.\n",
            serde_json::json!({"original_root":self.original_root,"policy":self.policy,
                "excluded_control_paths":self.exclusions,"snapshot_sha256":self.snapshot_sha256,
                "file_count":self.file_count,"bytes":self.bytes})
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (SnapshotPin, WorkspaceSelectionReceipt) {
        let files = vec![crate::SnapshotFile {
            path: "app.rs".into(),
            digest: format!("sha256:{:x}", Sha256::digest(b"source")),
            bytes: 6,
        }];
        let data = serde_json::to_vec(&vec![
            serde_json::json!({"bytes":6,"digest":files[0].digest,"path":"app.rs"}),
        ])
        .unwrap();
        let digest = format!("sha256:{:x}", Sha256::digest(data));
        let policy = WorkspaceSelectionPolicy::ExcludeNativeState {
            state_relative_path: ".0sec/native/state.db".into(),
        };
        let receipt = WorkspaceSelectionReceipt {
            schema_version: 1,
            original_root: "/workspace".into(),
            exclusions: policy.exclusions().unwrap(),
            policy,
            snapshot_sha256: digest.clone(),
            file_count: 1,
            bytes: 6,
        };
        (
            SnapshotPin {
                id: "source".into(),
                root: "/private/source".into(),
                digest,
                files,
            },
            receipt,
        )
    }
    #[test]
    fn exact_control_file_family_and_original_scope_are_retained() {
        let (pin, receipt) = fixture();
        receipt.validate_pin(&pin).unwrap();
        assert_eq!(
            receipt.exclusions,
            vec![
                ".0sec/native/state.db",
                ".0sec/native/state.db-journal",
                ".0sec/native/state.db-shm",
                ".0sec/native/state.db-wal",
                ".0sec/native/state.db.engine-lock"
            ]
        );
        assert!(receipt.prompt_scope().contains("/workspace"));
        assert!(!receipt.prompt_scope().contains("/private/source"));
    }
    #[test]
    fn forged_receipt_or_selected_control_file_rejects() {
        let (pin, receipt) = fixture();
        for mutation in 0..6 {
            let mut r = receipt.clone();
            match mutation {
                0 => r.exclusions.push("app.rs".into()),
                1 => r.file_count = 2,
                2 => r.bytes = 7,
                3 => r.original_root = "relative".into(),
                4 => r.original_root = "/workspace/../other".into(),
                _ => r.snapshot_sha256 = format!("sha256:{}", "0".repeat(64)),
            }
            assert!(r.validate_pin(&pin).is_err());
        }
        for path in ["../db", "/db", "db/", "a//db", "a\\db", "db\n"] {
            assert!(
                WorkspaceSelectionPolicy::ExcludeNativeState {
                    state_relative_path: path.into()
                }
                .exclusions()
                .is_err()
            );
        }
        let mut r = receipt;
        r.policy = WorkspaceSelectionPolicy::ExcludeNativeState {
            state_relative_path: "app.rs".into(),
        };
        r.exclusions = r.policy.exclusions().unwrap();
        assert!(r.validate_pin(&pin).is_err());
    }
}
