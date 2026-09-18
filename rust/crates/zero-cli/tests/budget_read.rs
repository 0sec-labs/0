#![allow(clippy::unwrap_used)]
use std::process::Command;
#[test]
fn readonly_budget_never_creates_missing_state_or_loads_irrelevant_config() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("absent/state.db");
    let result = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args([
            "--providers",
            "/missing/provider",
            "session",
            "budget",
            "missing",
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(!state.parent().unwrap().exists());
    assert!(!String::from_utf8_lossy(&result.stderr).contains("provider configuration"));
}
#[test]
fn readonly_budget_preserves_unresolved_holds_and_rejects_unknown_session() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state.db");
    let mut store = zero_store::Store::open(&state).unwrap();
    let session = store.create_session("fixture", 100).unwrap();
    store
        .reserve_budget(&session.id, "retained-hold", 20)
        .unwrap();
    drop(store);
    let owned = zero_engine::Engine::open(&state, None).unwrap();
    let read = |id: &str| {
        Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args(["session", "budget", id])
            .output()
            .unwrap()
    };
    let output = read(&session.id);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["budget"]["reserved"], 20);
    assert_eq!(value["budget"]["charged"], 0);
    assert!(!read("foreign").status.success());
    drop(owned);
}
