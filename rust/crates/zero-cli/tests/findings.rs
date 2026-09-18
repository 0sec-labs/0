use std::process::Command;

#[test]
fn findings_help_and_read_errors_do_not_initialize_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("absent.db");
    for args in [
        vec!["findings", "--help"],
        vec!["findings", "show", "--help"],
        vec!["findings", "accept", "--help"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .arg("--state")
            .arg(&state)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!state.exists());
    }
    for action in ["list", "show"] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        command.arg("--state").arg(&state).args([
            "findings",
            action,
            "--session",
            "missing",
            "--operation",
            "missing",
        ]);
        if action == "show" {
            command.args(["--hypothesis", "missing"]);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!state.exists());
    }
    let output = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .arg("--state")
        .arg(&state)
        .args([
            "findings",
            "accept",
            "--session",
            "missing",
            "--operation",
            "missing",
            "--hypothesis",
            "missing",
            "--command-id",
            "test",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--expected-revision"));
    assert!(!state.exists());
}
