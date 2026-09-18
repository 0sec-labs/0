use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use zero_evolution::{
    EvaluationDecision, EvaluationReceipt, Manifest, PreparedState, Registry, RuntimeLifecycle,
    RuntimeState,
};
use zero_harness::{Error, GenerationPin, Harness, HostGrants};
use zero_plugin::{Artifact, Capability, EntryPoint, HostPolicy, Schema, Tool};
fn grants() -> HostGrants {
    HostGrants::new(BTreeMap::from([(
        "inspector".into(),
        HostPolicy {
            enabled: true,
            trusted: false,
            grants: BTreeSet::from([Capability::Compute]),
        },
    )]))
}
struct Setup {
    dir: tempfile::TempDir,
    engine: String,
    first: String,
    second: String,
    first_eligibility: String,
    second_eligibility: String,
}
impl Setup {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(
            dir.path().join("evolution.sqlite"),
            "v1",
            &json!({"counter":0}),
        )
        .unwrap();
        let engine = registry.put_artifact(b"host-engine-fixture").unwrap();
        let policy = registry
            .put_artifact(&grants().artifact_bytes().unwrap())
            .unwrap();
        let first = register(&mut registry, &engine, &policy, b"first", vec![]);
        let second = register(&mut registry, &engine, &policy, b"second", vec![]);
        let first_eligibility = registry
            .authorize_baseline(&first, "explicit unmeasured fixture baseline")
            .unwrap();
        let evaluator = registry
            .put_artifact(b"fixture evaluator identity")
            .unwrap();
        let evidence = registry
            .put_artifact(b"caller supplied fixture evidence; not empirical evaluation")
            .unwrap();
        let receipt = registry
            .record_evaluation(&EvaluationReceipt {
                candidate: second.clone(),
                baseline: first.clone(),
                evaluator_artifact: evaluator.clone(),
                policy_artifact: policy.clone(),
                evidence_artifacts: BTreeMap::from([("fixture".into(), evidence)]),
                decision: EvaluationDecision::Eligible,
                observations: json!({"fixture":true}),
            })
            .unwrap();
        let second_eligibility = registry
            .admit_eligibility(&second, &receipt, &first, &evaluator, &policy)
            .unwrap();
        Self {
            dir,
            engine,
            first,
            second,
            first_eligibility,
            second_eligibility,
        }
    }
    fn registry(&self) -> Registry {
        Registry::open(
            self.dir.path().join("evolution.sqlite"),
            "ignored",
            &json!({}),
        )
        .unwrap()
    }
    fn harness(&self) -> Harness {
        Harness::new(self.registry(), self.engine.clone())
    }
    fn activate(&self, h: &mut Harness) -> GenerationPin {
        let prepared = h
            .prepare_activation(
                &self.first,
                &self.first_eligibility,
                &h.current().unwrap(),
                &grants(),
                copy,
            )
            .unwrap();
        h.commit(prepared).unwrap()
    }
}
fn register(
    registry: &mut Registry,
    engine: &str,
    policy: &str,
    bytes: &[u8],
    dependencies: Vec<zero_plugin::Dependency>,
) -> String {
    let artifact = registry.put_artifact(bytes).unwrap();
    let plugin = zero_plugin::Manifest {
        schema_version: 1,
        protocol_version: 1,
        id: "inspector".into(),
        version: "1.0.0".into(),
        artifacts: vec![Artifact {
            sha256: artifact.strip_prefix("sha256:").unwrap().into(),
            size: bytes.len() as u64,
        }],
        entrypoint: EntryPoint {
            artifact: artifact.strip_prefix("sha256:").unwrap().into(),
            argv: vec![],
        },
        dependencies,
        tools: vec![Tool {
            name: "inspect".into(),
            description: "fixture".into(),
            parameters: Schema::Object {
                properties: BTreeMap::new(),
                required: vec![],
                additional_properties: false,
            },
            capabilities: BTreeSet::from([Capability::Compute]),
        }],
    };
    let manifest = registry
        .put_artifact(&serde_json::to_vec(&plugin).unwrap())
        .unwrap();
    registry
        .register_generation(&Manifest {
            engine_artifact: engine.into(),
            components: BTreeMap::from([("plugin:inspector".into(), manifest)]),
            protocol_version: 1,
            state_schema: "v1".into(),
            compatible_state_schemas: vec![],
            configuration: json!({"native_plugin_graph":1}),
            policy_artifact: policy.into(),
        })
        .unwrap()
}
fn copy(manifest: &Manifest, state: &RuntimeState) -> Result<PreparedState, String> {
    Ok(PreparedState {
        state_schema: manifest.state_schema.clone(),
        state: state.state.clone(),
    })
}
#[test]
fn prepare_failure_and_grant_mismatch_preserve_current_graph_and_state() {
    let s = Setup::new();
    let mut h = s.harness();
    let pin = s.activate(&mut h);
    let before = h.current().unwrap();
    assert!(
        h.prepare_activation(
            &s.second,
            &s.second_eligibility,
            &before,
            &grants(),
            |_, _| Err("injected migration failure".into())
        )
        .is_err()
    );
    assert_eq!(h.current().unwrap(), before);
    assert!(matches!(
        h.prepare_activation(
            &s.second,
            &s.second_eligibility,
            &before,
            &HostGrants::new(BTreeMap::new()),
            copy
        ),
        Err(Error::Binding(_))
    ));
    assert_eq!(h.current().unwrap(), before);
    let mut call = h
        .begin_call(&pin, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    assert_eq!(call.graph().generation(), s.first);
    h.complete_settled(&mut call).unwrap();
}
#[test]
fn atomic_switch_preserves_old_call_and_rejects_stale_new_calls_and_replies() {
    let s = Setup::new();
    let mut h = s.harness();
    let first = s.activate(&mut h);
    let mut old = h
        .begin_call(&first, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    let old_pin = old.pin();
    let old_manifest = old.invocation().manifest_digest.clone();
    let prepared = h
        .prepare_activation(
            &s.second,
            &s.second_eligibility,
            &h.current().unwrap(),
            &grants(),
            copy,
        )
        .unwrap();
    let second = h.commit(prepared).unwrap();
    assert_eq!(
        h.lifecycle(&s.first).unwrap(),
        RuntimeLifecycle::Draining { leases: 1 }
    );
    assert_eq!(old.graph().generation(), s.first);
    assert_eq!(old.invocation().manifest_digest, old_manifest);
    h.validate_reply(&old, &old_pin).unwrap();
    assert!(matches!(
        h.begin_call(&first, "owner", "inspector", "inspect", json!({})),
        Err(Error::Stale)
    ));
    let mut new = h
        .begin_call(&second, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    assert_ne!(new.invocation().manifest_digest, old_manifest);
    assert!(matches!(
        h.validate_reply(&new, &old_pin),
        Err(Error::Stale)
    ));
    h.complete_settled(&mut old).unwrap();
    assert_eq!(h.lifecycle(&s.first).unwrap(), RuntimeLifecycle::Inactive);
    assert!(matches!(
        h.validate_reply(&old, &old_pin),
        Err(Error::Stale)
    ));
    h.complete_settled(&mut old).unwrap();
    h.complete_settled(&mut new).unwrap();
}
#[test]
fn concurrent_preparations_compare_and_swap_without_replacing_winner() {
    let s = Setup::new();
    let mut a = s.harness();
    let mut b = s.harness();
    let pa = a
        .prepare_activation(
            &s.first,
            &s.first_eligibility,
            &a.current().unwrap(),
            &grants(),
            copy,
        )
        .unwrap();
    let pb = b
        .prepare_activation(
            &s.first,
            &s.first_eligibility,
            &b.current().unwrap(),
            &grants(),
            copy,
        )
        .unwrap();
    let pin = a.commit(pa).unwrap();
    assert!(b.commit(pb).is_err());
    assert_eq!(
        GenerationPin::from_state(&b.current().unwrap()).unwrap(),
        pin
    );
    // Selection in SQLite is not readiness in another process.
    assert!(matches!(
        b.begin_call(&pin, "other", "inspector", "inspect", json!({})),
        Err(Error::NotPrepared)
    ));
}
#[test]
fn rollback_uses_current_state_and_new_epoch_without_relabeling_old_invocations() {
    let s = Setup::new();
    let mut h = s.harness();
    let first = s.activate(&mut h);
    let mut old = h
        .begin_call(&first, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    let prepared = h
        .prepare_activation(
            &s.second,
            &s.second_eligibility,
            &h.current().unwrap(),
            &grants(),
            |m, _| {
                Ok(PreparedState {
                    state_schema: m.state_schema.clone(),
                    state: json!({"counter":9}),
                })
            },
        )
        .unwrap();
    h.commit(prepared).unwrap();
    let prepared = h
        .prepare_rollback(
            &s.first,
            &s.first_eligibility,
            &h.current().unwrap(),
            &grants(),
            |m, current| {
                assert_eq!(current.state, json!({"counter":9}));
                copy(m, current)
            },
        )
        .unwrap();
    let rollback = h.commit(prepared).unwrap();
    assert_eq!(rollback.generation, first.generation);
    assert_ne!(rollback.epoch, first.epoch);
    assert_eq!(h.current().unwrap().state, json!({"counter":9}));
    assert!(matches!(
        h.begin_call(&first, "owner", "inspector", "inspect", json!({})),
        Err(Error::Stale)
    ));
    h.validate_reply(&old, &old.pin()).unwrap();
    h.complete_settled(&mut old).unwrap();
}
#[test]
fn restart_lists_dropped_call_leases_but_never_resumes_or_auto_releases() {
    let s = Setup::new();
    let mut h = s.harness();
    let pin = s.activate(&mut h);
    let call = h
        .begin_call(&pin, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    let lease = call.lease().clone();
    drop(call);
    drop(h);
    let mut reopened = s.harness();
    assert_eq!(
        reopened.unreleased(Some("owner"), None, 16).unwrap(),
        vec![lease.clone()]
    );
    assert!(matches!(
        reopened.begin_call(&pin, "owner", "inspector", "inspect", json!({})),
        Err(Error::NotPrepared)
    ));
    reopened.restore_current(&grants()).unwrap();
    assert!(reopened.release_fenced(&lease.id, "wrong-owner").is_err());
    assert_eq!(
        reopened.unreleased(Some("owner"), None, 16).unwrap().len(),
        1
    );
    reopened.release_fenced(&lease.id, "owner").unwrap();
    assert!(
        reopened
            .unreleased(Some("owner"), None, 16)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn preparation_and_call_handles_are_bound_to_issuing_harness() {
    let s = Setup::new();
    let mut a = s.harness();
    let mut b = s.harness();
    let prepared = a
        .prepare_activation(
            &s.first,
            &s.first_eligibility,
            &a.current().unwrap(),
            &grants(),
            copy,
        )
        .unwrap();
    assert!(matches!(b.commit(prepared), Err(Error::Stale)));
    assert!(a.current().unwrap().generation.is_none());
    let pin = s.activate(&mut a);
    let mut call = a
        .begin_call(&pin, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    b.restore_current(&grants()).unwrap();
    assert!(matches!(
        b.validate_reply(&call, &call.pin()),
        Err(Error::Stale)
    ));
    assert!(matches!(b.complete_settled(&mut call), Err(Error::Stale)));
    a.complete_settled(&mut call).unwrap();
}
#[test]
fn unbound_components_wrong_engine_and_missing_dependencies_never_prepare() {
    let s = Setup::new();
    let mut r = s.registry();
    let policy = r.generation(&s.first).unwrap().policy_artifact;
    let missing = register(
        &mut r,
        &s.engine,
        &policy,
        b"missing dependency",
        vec![zero_plugin::Dependency {
            id: "absent".into(),
            version: "1.0.0".into(),
        }],
    );
    let permission = r.authorize_baseline(&missing, "fixture").unwrap();
    let mut h = Harness::new(r, s.engine.clone());
    assert!(matches!(
        h.prepare_activation(
            &missing,
            &permission,
            &h.current().unwrap(),
            &grants(),
            copy
        ),
        Err(Error::Plugin(_))
    ));
    let mut r = s.registry();
    let mut manifest = r.generation(&s.first).unwrap();
    let component = manifest.components.values().next().unwrap().clone();
    manifest
        .components
        .insert("source:native".into(), component);
    let extra = r.register_generation(&manifest).unwrap();
    let permission = r.authorize_baseline(&extra, "fixture").unwrap();
    let mut h = Harness::new(r, s.engine.clone());
    assert!(matches!(
        h.prepare_activation(&extra, &permission, &h.current().unwrap(), &grants(), copy),
        Err(Error::Binding(_))
    ));
    let mut h = Harness::new(s.registry(), "sha256:wrong-engine".into());
    assert!(matches!(
        h.prepare_activation(
            &s.first,
            &s.first_eligibility,
            &h.current().unwrap(),
            &grants(),
            copy
        ),
        Err(Error::Binding(_))
    ));
}

#[test]
fn complete_dependency_graph_pins_every_manifest_and_retained_artifact() {
    let s = Setup::new();
    let mut r = s.registry();
    let original = r.generation(&s.first).unwrap();
    let bytes = r
        .artifact(original.components.values().next().unwrap())
        .unwrap();
    let mut parent = zero_plugin::Manifest::parse(&bytes).unwrap();
    let mut helper = parent.clone();
    helper.id = "helper".into();
    parent.dependencies.push(zero_plugin::Dependency {
        id: "helper".into(),
        version: helper.version.clone(),
    });
    let parent_artifact = r
        .put_artifact(&serde_json::to_vec(&parent).unwrap())
        .unwrap();
    let helper_artifact = r
        .put_artifact(&serde_json::to_vec(&helper).unwrap())
        .unwrap();
    let grants = HostGrants::new(
        ["helper", "inspector"]
            .into_iter()
            .map(|id| {
                (
                    id.into(),
                    HostPolicy {
                        enabled: true,
                        trusted: false,
                        grants: BTreeSet::from([Capability::Compute]),
                    },
                )
            })
            .collect(),
    );
    let policy = r.put_artifact(&grants.artifact_bytes().unwrap()).unwrap();
    let mut manifest = original;
    manifest.components = BTreeMap::from([
        ("plugin:inspector".into(), parent_artifact),
        ("plugin:helper".into(), helper_artifact),
    ]);
    manifest.policy_artifact = policy;
    let generation = r.register_generation(&manifest).unwrap();
    let eligibility = r
        .authorize_baseline(&generation, "dependency fixture")
        .unwrap();
    let mut h = Harness::new(r, s.engine.clone());
    let prepared = h
        .prepare_activation(
            &generation,
            &eligibility,
            &h.current().unwrap(),
            &grants,
            copy,
        )
        .unwrap();
    let pin = h.commit(prepared).unwrap();
    let mut call = h
        .begin_call(&pin, "owner", "inspector", "inspect", json!({}))
        .unwrap();
    assert_eq!(
        call.invocation().dependency_pins["helper"],
        helper.digest().unwrap()
    );
    assert_eq!(
        call.graph().plugin_digest("helper"),
        Some(helper.digest().unwrap().as_str())
    );
    assert_eq!(
        call.graph()
            .artifact("helper", &helper.entrypoint.artifact)
            .unwrap(),
        b"first"
    );
    h.complete_settled(&mut call).unwrap();
}

#[test]
fn noncanonical_manifest_binding_is_rejected_instead_of_relabeling_identity() {
    let s = Setup::new();
    let mut r = s.registry();
    let mut generation = r.generation(&s.first).unwrap();
    let bytes = r
        .artifact(generation.components.values().next().unwrap())
        .unwrap();
    let plugin = zero_plugin::Manifest::parse(&bytes).unwrap();
    let pretty = r
        .put_artifact(&serde_json::to_vec_pretty(&plugin).unwrap())
        .unwrap();
    generation
        .components
        .insert("plugin:inspector".into(), pretty);
    let id = r.register_generation(&generation).unwrap();
    let eligibility = r.authorize_baseline(&id, "noncanonical fixture").unwrap();
    let mut h = Harness::new(r, s.engine.clone());
    assert!(matches!(
        h.prepare_activation(&id, &eligibility, &h.current().unwrap(), &grants(), copy),
        Err(Error::Binding(_))
    ));
    assert!(h.current().unwrap().generation.is_none());
}
