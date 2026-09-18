use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use zero_plugin::*;
fn bundle(id: &str, dependencies: &[&str]) -> Bundle {
    let bytes = format!("inert artifact {id}").into_bytes();
    let digest = sha256(&bytes);
    Bundle {
        manifest: Manifest {
            schema_version: 1,
            protocol_version: 1,
            id: id.into(),
            version: "1.2.3".into(),
            artifacts: vec![Artifact {
                sha256: digest.clone(),
                size: bytes.len() as u64,
            }],
            entrypoint: EntryPoint {
                artifact: digest.clone(),
                argv: vec![],
            },
            dependencies: dependencies
                .iter()
                .map(|id| Dependency {
                    id: (*id).into(),
                    version: "1.2.3".into(),
                })
                .collect(),
            tools: vec![Tool {
                name: "inspect".into(),
                description: "inert test".into(),
                parameters: Schema::Object {
                    properties: BTreeMap::from([(
                        "path".into(),
                        Schema::String { max_length: 64 },
                    )]),
                    required: vec!["path".into()],
                    additional_properties: false,
                },
                capabilities: BTreeSet::from([Capability::FilesystemRead]),
            }],
        },
        artifacts: BTreeMap::from([(digest, bytes)]),
    }
}
fn enable(registry: &mut Registry, id: &str) -> String {
    let digest = registry.get(id).unwrap().1.manifest_digest.clone();
    registry
        .authorize(
            id,
            &digest,
            HostPolicy {
                enabled: true,
                trusted: false,
                grants: BTreeSet::from([Capability::FilesystemRead]),
            },
        )
        .unwrap();
    digest
}
#[test]
fn manifest_unknown_fields_versions_empty_capabilities_and_schema_are_rejected() {
    let valid = serde_json::to_value(bundle("test", &[]).manifest).unwrap();
    assert!(Manifest::parse(&serde_json::to_vec(&valid).unwrap()).is_ok());
    let invalids = [
        ("/schema_version", json!(2)),
        ("/protocol_version", json!(0)),
        ("/version", json!("01.2.3")),
        ("/version", json!("1.2.3-beta")),
        ("/tools/0/capabilities", json!([])),
        ("/tools/0/capabilities", json!(["host-root"])),
        ("/tools/0/parameters/additionalProperties", json!(true)),
        ("/tools/0/parameters/required", json!(["missing"])),
    ];
    for (pointer, replacement) in invalids {
        let mut value = valid.clone();
        *value.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            Manifest::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{pointer}"
        );
    }
    for field in ["enabled", "trusted", "grants", "unknown"] {
        let mut value = valid.clone();
        value[field] = json!(true);
        assert!(Manifest::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = valid;
    value["tools"][0]["parameters"]["$ref"] = json!("file:///host");
    assert!(Manifest::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(Manifest::parse(&vec![b' '; MAX_MANIFEST_BYTES + 1]).is_err());
}
#[test]
fn content_hash_mismatch_extra_artifacts_and_same_identity_updates_fail_atomically() {
    let mut registry = Registry::new();
    let mut tampered = bundle("bad", &[]);
    tampered.artifacts.values_mut().next().unwrap()[0] ^= 1;
    assert!(matches!(
        registry.admit_batch(vec![bundle("good", &[]), tampered]),
        Err(Error::Identity)
    ));
    assert!(registry.is_empty());
    let mut extra = bundle("extra", &[]);
    extra
        .artifacts
        .insert(sha256(b"undeclared"), b"undeclared".to_vec());
    assert!(registry.admit_batch(vec![extra]).is_err());
    registry.admit_batch(vec![bundle("good", &[])]).unwrap();
    assert!(matches!(
        registry.admit_batch(vec![bundle("good", &[])]),
        Err(Error::Conflict)
    ));
    let (m, a) = registry.get("good").unwrap();
    assert_eq!(a.manifest_digest, m.digest().unwrap());
    assert_eq!(
        registry.artifact("good", &m.entrypoint.artifact).unwrap(),
        b"inert artifact good"
    );
}
#[test]
fn missing_cycles_and_version_mismatches_reject_entire_batch() {
    let mut registry = Registry::new();
    assert!(matches!(
        registry.admit_batch(vec![bundle("a", &["missing"])]),
        Err(Error::MissingDependency)
    ));
    assert!(matches!(
        registry.admit_batch(vec![bundle("a", &["b"]), bundle("b", &["a"])]),
        Err(Error::Cycle)
    ));
    assert!(matches!(
        registry.admit_batch(vec![bundle("self", &["self"])]),
        Err(Error::Cycle)
    ));
    let mut bad = bundle("a", &["b"]);
    bad.manifest.dependencies[0].version = "1.2.4".into();
    assert!(matches!(
        registry.admit_batch(vec![bad, bundle("b", &[])]),
        Err(Error::Identity)
    ));
    assert!(registry.is_empty());
}
#[test]
fn flags_do_not_grant_authority_and_dependency_grants_are_separate() {
    let mut registry = Registry::new();
    registry
        .admit_batch(vec![bundle("a", &["b"]), bundle("b", &[])])
        .unwrap();
    let digest = registry.get("a").unwrap().1.manifest_digest.clone();
    registry
        .authorize(
            "a",
            &digest,
            HostPolicy {
                enabled: true,
                trusted: true,
                grants: BTreeSet::new(),
            },
        )
        .unwrap();
    assert!(matches!(
        registry.prepare_call("a", &digest, "inspect", json!({"path":"file"})),
        Err(Error::Denied)
    ));
    enable(&mut registry, "a");
    assert!(matches!(
        registry.prepare_call("a", &digest, "inspect", json!({"path":"file"})),
        Err(Error::Denied)
    ));
    let dependency = enable(&mut registry, "b");
    let call = registry
        .prepare_call("a", &digest, "inspect", json!({"path":"file"}))
        .unwrap();
    assert_eq!(call.dependency_pins["b"], dependency);
    assert_eq!(
        call.capabilities,
        BTreeSet::from([Capability::FilesystemRead])
    );
    assert!(matches!(
        registry.authorize(
            "a",
            &digest,
            HostPolicy {
                enabled: true,
                trusted: true,
                grants: BTreeSet::from([Capability::Network])
            }
        ),
        Err(Error::Denied)
    ));
    assert!(matches!(
        registry.authorize("a", &sha256(b"different manifest"), HostPolicy::default()),
        Err(Error::Identity)
    ));
    registry
        .authorize(
            "a",
            &digest,
            HostPolicy {
                enabled: false,
                trusted: true,
                grants: BTreeSet::from([Capability::FilesystemRead]),
            },
        )
        .unwrap();
    assert!(matches!(
        registry.prepare_call("a", &digest, "inspect", json!({"path":"file"})),
        Err(Error::Denied)
    ));
}
#[test]
fn no_tool_name_or_input_can_add_authority() {
    let mut registry = Registry::new();
    registry.admit_batch(vec![bundle("test", &[])]).unwrap();
    let digest = enable(&mut registry, "test");
    for input in [
        json!({}),
        json!({"path":7}),
        json!({"path":"file","trusted":true}),
        json!({"path":"x".repeat(65)}),
    ] {
        assert!(
            registry
                .prepare_call("test", &digest, "inspect", input)
                .is_err()
        );
    }
    assert!(
        registry
            .prepare_call("test", &digest, "execute_snapshot", json!({"path":"file"}))
            .is_err()
    );
    assert!(
        registry
            .prepare_call("test", &digest, "inspect", json!({"path":"file"}))
            .is_ok()
    );
}
#[test]
fn schemas_reject_excessive_depth_and_accept_only_declared_values() {
    let mut schema = Schema::Boolean;
    for _ in 0..18 {
        schema = Schema::Array {
            items: Box::new(schema),
            max_items: 1,
        };
    }
    assert!(matches!(schema.validate(), Err(Error::Limit)));
    let integer = Schema::Integer {
        minimum: -1,
        maximum: 1,
    };
    assert!(integer.accepts(&json!(0)).is_ok());
    assert!(integer.accepts(&json!(2)).is_err());
    assert!(integer.accepts(&json!(0.5)).is_err());
}
