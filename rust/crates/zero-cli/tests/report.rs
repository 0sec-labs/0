use serde_json::Value;
use std::process::Command;
use tempfile::TempDir;
const SOURCE: &[u8] = include_bytes!("../../zero-report/tests/fixtures/report.json");
fn cli(dir: &TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.arg("--state")
        .arg(dir.path().join("never/state.db"))
        .arg("--providers")
        .arg(dir.path().join("missing-providers.json"))
        .arg("--harness-config")
        .arg(dir.path().join("missing-harness.json"));
    c
}
#[test]
fn report_json_and_sarif_export_without_loading_engine_or_credentials() {
    let dir = TempDir::new().unwrap();
    let input = dir.path().join("report.json");
    std::fs::write(&input, SOURCE).unwrap();
    for format in ["json", "sarif"] {
        let output = cli(&dir)
            .args(["report", "--format", format, "--input"])
            .arg(&input)
            .env_remove("0SEC_CLOUD_TOKEN")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        if format == "json" {
            assert_eq!(value, serde_json::from_slice::<Value>(SOURCE).unwrap());
        } else {
            let mut expected: Value = serde_json::from_slice(include_bytes!(
                "../../zero-report/tests/fixtures/typescript.sarif.json"
            ))
            .unwrap();
            expected["runs"][0]["tool"]["driver"]["version"] =
                serde_json::json!(env!("CARGO_PKG_VERSION"));
            assert_eq!(value, expected);
            assert_eq!(
                value["runs"][0]["invocations"][0]["executionSuccessful"],
                false
            );
            assert_eq!(
                value["runs"][0]["results"][0]["properties"]["status"],
                "discovered"
            );
        }
        assert!(!dir.path().join("never").exists());
    }
}
#[test]
fn report_rejects_malformed_or_oversized_input_without_partial_stdout() {
    let dir = TempDir::new().unwrap();
    let input = dir.path().join("invalid.json");
    for body in [
        b"{\"token\":\"fixture-secret\"}".to_vec(),
        vec![b'x'; 16 * 1024 * 1024 + 1],
    ] {
        std::fs::write(&input, body).unwrap();
        let output = cli(&dir)
            .args(["report", "--format", "sarif", "--input"])
            .arg(&input)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-secret"));
        assert!(!dir.path().join("never").exists());
    }
}
#[test]
fn report_help_and_protocol_schema_bypass_input_and_configuration() {
    let dir = TempDir::new().unwrap();
    let help = cli(&dir)
        .args(["report", "--input", "/not/a/report", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("sarif"));
    let schema = cli(&dir).arg("schema").output().unwrap();
    assert!(schema.status.success());
    let schema: Value = serde_json::from_slice(&schema.stdout).unwrap();
    assert_eq!(schema["protocol_version"], 1);
    assert!(!dir.path().join("never").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn report_signal_exits_while_stdout_reader_stops_consuming() {
    use tokio::io::AsyncReadExt;
    let dir = TempDir::new().unwrap();
    let input = dir.path().join("large.json");
    let mut source: Value = serde_json::from_slice(SOURCE).unwrap();
    source["padding"] = serde_json::json!("x".repeat(1024 * 1024));
    std::fs::write(&input, source.to_string()).unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_0sec-native"))
        .args(["report", "--format", "json", "--input"])
        .arg(&input)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut pipe = child.stdout.take().unwrap();
    let mut byte = [0; 1];
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        pipe.read_exact(&mut byte),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        Command::new("kill")
            .args(["-TERM", &child.id().unwrap().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(1));
    drop(pipe);
}
