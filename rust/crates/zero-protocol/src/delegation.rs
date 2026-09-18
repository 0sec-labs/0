//! Host-authored, nonrecursive authority for bounded joined agent tasks.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DelegationPolicy {
    pub max_parallel: u32,
    pub max_children: u32,
    pub roles: Vec<DelegationRole>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DelegationRole {
    pub name: String,
    pub provider: String,
    pub model: String,
    pub instructions: String,
    pub description: String,
    pub tools: Vec<String>,
    pub max_turns: u32,
    pub reservation_per_turn: u64,
}

fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl DelegationPolicy {
    /// Validate static bounds only. The host must additionally resolve provider
    /// profiles and verify every role tool against the parent's offered tools.
    pub fn validate(&self) -> Result<(), crate::ValidationError> {
        let invalid = |reason: &str| crate::ValidationError(reason.into());
        if !(1..=4).contains(&self.max_parallel)
            || !(1..=16).contains(&self.max_children)
            || self.max_parallel > self.max_children
            || !(1..=8).contains(&self.roles.len())
        {
            return Err(invalid(
                "delegation requires 1..4 parallel tasks, 1..16 children and 1..8 roles",
            ));
        }
        let mut names = BTreeSet::new();
        for role in &self.roles {
            if !name(&role.name) || !names.insert(&role.name) {
                return Err(invalid(
                    "delegation role names must be unique ASCII identifiers of 1..64 bytes",
                ));
            }
            if [&role.provider, &role.model]
                .iter()
                .any(|s| s.trim().is_empty() || s.len() > 256)
                || role.instructions.len() > 64 * 1024
                || role.description.len() > 2 * 1024
                || !(1..=32).contains(&role.max_turns)
                || role.reservation_per_turn == 0
            {
                return Err(invalid(
                    "delegation role exceeds provider, model, text, turn or reservation bounds",
                ));
            }
            let mut tools = BTreeSet::new();
            if role.tools.len() > 32
                || role.tools.iter().any(|tool| {
                    !name(tool)
                        || !tools.insert(tool)
                        || matches!(tool.as_str(), "delegate_tasks" | "submit_source_hypotheses")
                })
            {
                return Err(invalid(
                    "delegation tools must be at most 32 unique ASCII identifiers; recursive delegation and source submission are forbidden",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn policy() -> DelegationPolicy {
        DelegationPolicy {
            max_parallel: 2,
            max_children: 4,
            roles: vec![DelegationRole {
                name: "reviewer".into(),
                provider: "host".into(),
                model: "model".into(),
                instructions: "Read only".into(),
                description: "Review a bounded task".into(),
                tools: vec!["read_source_lines".into()],
                max_turns: 3,
                reservation_per_turn: 100,
            }],
        }
    }
    #[test]
    fn static_bounds_and_nonrecursive_authority() {
        let p = policy();
        p.validate().unwrap();
        for field in ["max_parallel", "max_children"] {
            for value in [0, 17] {
                let mut v = serde_json::to_value(&p).unwrap();
                v[field] = json!(value);
                assert!(
                    serde_json::from_value::<DelegationPolicy>(v)
                        .unwrap()
                        .validate()
                        .is_err()
                );
            }
        }
        let mut v = p.clone();
        v.max_children = 1;
        assert!(v.validate().is_err());
        let mut v = p.clone();
        v.roles.push(v.roles[0].clone());
        assert!(v.validate().is_err());
        for tool in [
            "delegate_tasks",
            "submit_source_hypotheses",
            "bad/name",
            "é",
        ] {
            let mut v = p.clone();
            v.roles[0].tools = vec![tool.into()];
            assert!(v.validate().is_err());
        }
        let mut v = p.clone();
        let duplicate = v.roles[0].tools[0].clone();
        v.roles[0].tools.push(duplicate);
        assert!(v.validate().is_err());
        for field in ["provider", "model"] {
            let mut v = serde_json::to_value(&p).unwrap();
            v["roles"][0][field] = json!("   ");
            assert!(
                serde_json::from_value::<DelegationPolicy>(v)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut v = p.clone();
        v.roles[0].instructions = "é".repeat(32769);
        assert!(v.validate().is_err());
        let mut v = p.clone();
        v.roles[0].description = "a".repeat(2049);
        assert!(v.validate().is_err());
        let mut v = p.clone();
        v.roles[0].max_turns = 33;
        assert!(v.validate().is_err());
        let mut v = p;
        v.roles[0].reservation_per_turn = 0;
        assert!(v.validate().is_err());
    }
    #[test]
    fn inclusive_limits_accept_provider_only_and_maximum_sized_roles() {
        let mut p = policy();
        p.max_parallel = 4;
        p.max_children = 16;
        p.roles = (0..8)
            .map(|i| {
                let mut r = p.roles[0].clone();
                r.name = format!("r{i}{}", "x".repeat(62));
                r.provider = "p".repeat(256);
                r.model = "m".repeat(256);
                r.instructions = "i".repeat(64 * 1024);
                r.description = "d".repeat(2 * 1024);
                r.max_turns = 32;
                r.reservation_per_turn = u64::MAX;
                r.tools = (0..32).map(|j| format!("tool_{j}")).collect();
                r
            })
            .collect();
        p.validate().unwrap();
        let mut empty = p.clone();
        empty.roles[0].tools.clear();
        empty.validate().unwrap();
        let mut bad = p.clone();
        bad.roles[0].tools.push("extra".into());
        assert!(bad.validate().is_err());
        let mut bad = p.clone();
        bad.roles.push(bad.roles[0].clone());
        assert!(bad.validate().is_err());
        let mut bad = p.clone();
        bad.roles[0].name.push('x');
        assert!(bad.validate().is_err());
        let mut bad = p;
        bad.roles[0].model.push('x');
        assert!(bad.validate().is_err());
    }

    #[test]
    fn unknown_fields_cannot_embed_authority() {
        let mut v = serde_json::to_value(policy()).unwrap();
        v["roles"][0]["delegation_policy"] = json!({});
        assert!(serde_json::from_value::<DelegationPolicy>(v).is_err());
        let mut v = serde_json::to_value(policy()).unwrap();
        v["execution"] = json!({});
        assert!(serde_json::from_value::<DelegationPolicy>(v).is_err());
    }
}

#[cfg(test)]
mod compatibility {
    use crate::agent::AgentRequest;
    use serde_json::json;
    #[test]
    fn absent_policy_preserves_the_original_canonical_request() {
        let original = json!({"provider":"p","model":"m","instructions":"i","prompt":"hello","execution":{"execution_id":"e","image":"local","argv":["true"],"snapshot":{"id":"s","root":"/tmp/source","digest":"sha256:abc","files":[]},"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024},"max_turns":2,"reservation_per_turn":10});
        let request: AgentRequest = serde_json::from_value(original.clone()).unwrap();
        assert!(request.delegation_policy.is_none());
        assert!(!request.operator_questions);
        assert!(request.tool_approval_policy.is_none());
        // Defaults on the legacy execution profile are independent of this new field.
        let canonical = serde_json::to_value(&request).unwrap();
        assert!(canonical.get("delegation_policy").is_none());
        assert!(canonical.get("operator_questions").is_none());
        assert!(canonical.get("tool_approval_policy").is_none());
        let mut explicit_false = canonical.clone();
        explicit_false["operator_questions"] = json!(false);
        let decoded: crate::agent::AgentRequest = serde_json::from_value(explicit_false).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), canonical);
        let old_canonical = serde_json::to_vec(&canonical).unwrap();
        let mut explicit_null = canonical.clone();
        explicit_null["delegation_policy"] = serde_json::Value::Null;
        explicit_null["tool_approval_policy"] = serde_json::Value::Null;
        let null_request: AgentRequest = serde_json::from_value(explicit_null).unwrap();
        assert_eq!(
            serde_json::to_vec(&serde_json::to_value(null_request).unwrap()).unwrap(),
            old_canonical
        );
        let mut with_policy = request;
        with_policy.delegation_policy = Some(super::DelegationPolicy {
            max_parallel: 1,
            max_children: 1,
            roles: vec![super::DelegationRole {
                name: "reader".into(),
                provider: "p".into(),
                model: "m".into(),
                instructions: "bounded".into(),
                description: "read".into(),
                tools: vec![],
                max_turns: 1,
                reservation_per_turn: 1,
            }],
        });
        with_policy
            .delegation_policy
            .as_ref()
            .unwrap()
            .validate()
            .unwrap();
        assert_ne!(
            serde_json::to_vec(&serde_json::to_value(with_policy).unwrap()).unwrap(),
            old_canonical
        );
    }
}
