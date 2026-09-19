#![cfg(unix)]
use std::{
    fs,
    net::TcpListener,
    os::unix::fs::{PermissionsExt, symlink},
    process::{Command, Output},
};
fn cli(home: &tempfile::TempDir) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
    c.env("HOME", home.path())
        .env_remove("0SEC_CLOUD_HOST")
        .env_remove("0SEC_CLOUD_TOKEN")
        .arg("--state")
        .arg(home.path().join("unused.db"))
        .args(["--providers", "/absent", "auth"]);
    c
}
fn output(c: &mut Command, success: bool) -> serde_json::Value {
    let o = c.output().unwrap();
    assert_eq!(
        o.status.success(),
        success,
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    secret_free(&o);
    if success {
        serde_json::from_slice(&o.stdout).unwrap()
    } else {
        serde_json::Value::Null
    }
}
fn secret_free(o: &Output) {
    for bytes in [&o.stdout, &o.stderr] {
        let s = String::from_utf8_lossy(bytes);
        assert!(!s.contains("lifecycle-secret"));
    }
}
fn private(home: &tempfile::TempDir, dir: &str, name: &str) -> std::path::PathBuf {
    let parent = home.path().join(dir);
    fs::create_dir_all(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    let p = parent.join(name);
    fs::write(&p, "lifecycle-secret").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
    p
}
#[test]
fn manual_import_is_offline_private_and_logout_removes_both_stores_idempotently() {
    let home = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let report = output(
        cli(&home).env("IMPORT_TOKEN", "lifecycle-secret").args([
            "--host",
            &host,
            "login",
            "--token-from-env",
            "IMPORT_TOKEN",
        ]),
        true,
    );
    assert_eq!(report["credential_validation"], "format_only");
    assert!(listener.accept().is_err());
    let path = home.path().join(".0sec/cloud.env");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains("0SEC_CLOUD_TOKEN=lifecycle-secret")
    );
    let other = private(&home, ".0cloud", "credentials.json");
    let report = output(
        cli(&home)
            .env("0SEC_CLOUD_TOKEN", "lifecycle-secret")
            .arg("logout"),
        true,
    );
    assert_eq!(report["environment_override"], true);
    assert_eq!(report["remote_sessions_revoked"], false);
    assert_eq!(report["deleted_files"].as_array().unwrap().len(), 2);
    assert!(!path.exists() && !other.exists());
    assert_eq!(
        output(cli(&home).arg("logout"), true)["deleted_files"],
        serde_json::json!([])
    );
    assert!(!home.path().join("unused.db").exists());
}
#[test]
fn invalid_import_preserves_existing_secret_without_output_or_requests() {
    let home = tempfile::tempdir().unwrap();
    let path = private(&home, ".0sec", "cloud.env");
    for value in ["lifecycle-secret\nembedded", "", "lifecycle-secret\u{007f}"] {
        output(
            cli(&home).env("IMPORT_TOKEN", value).args([
                "login",
                "--token-from-env",
                "IMPORT_TOKEN",
            ]),
            false,
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "lifecycle-secret");
    }
    output(
        cli(&home).env("IMPORT_TOKEN", "lifecycle-secret").args([
            "--host",
            "https://user:password@example.com",
            "login",
            "--token-from-env",
            "IMPORT_TOKEN",
        ]),
        false,
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "lifecycle-secret");
}
#[test]
fn logout_preflights_all_files_and_does_not_follow_symlinks_or_hardlinks() {
    for hardlink in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let first = private(&home, ".0sec", "cloud.env");
        let second = private(&home, ".0cloud", "credentials.json");
        fs::remove_file(&second).unwrap();
        if hardlink {
            fs::hard_link(&first, &second).unwrap()
        } else {
            symlink(&first, &second).unwrap()
        }
        output(cli(&home).arg("logout"), false);
        assert_eq!(fs::read_to_string(&first).unwrap(), "lifecycle-secret");
        assert!(second.symlink_metadata().is_ok());
    }
}
#[test]
fn explicit_logout_is_scoped_and_directory_lock_coordinates_login_and_logout() {
    use nix::fcntl::{Flock, FlockArg};
    let home = tempfile::tempdir().unwrap();
    let first = private(&home, ".0sec", "cloud.env");
    let other = private(&home, ".0cloud", "credentials.json");
    let lock = Flock::lock(
        fs::File::open(home.path().join(".0sec")).unwrap(),
        FlockArg::LockExclusiveNonblock,
    )
    .unwrap();
    output(cli(&home).arg("logout"), false);
    output(
        cli(&home)
            .env("IMPORT_TOKEN", "lifecycle-secret-new")
            .args(["login", "--token-from-env", "IMPORT_TOKEN"]),
        false,
    );
    assert_eq!(fs::read_to_string(&first).unwrap(), "lifecycle-secret");
    drop(lock);
    let report = output(
        cli(&home)
            .env("CUSTOM_TOKEN", "lifecycle-secret")
            .args(["--token-env", "CUSTOM_TOKEN", "logout", "--credentials"])
            .arg(&first),
        true,
    );
    assert_eq!(report["environment_override"], true);
    assert!(!first.exists());
    assert!(other.exists());
}
