#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, process::Command};
const URL: &str = "https://example.test/org/private.git";
const TOKEN: &str = "fixture-only-private-token-123";
struct Fixture {
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new(fail: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir(&repo).unwrap();
        for args in [
            vec!["init", "--initial-branch=main"],
            vec!["add", "."],
            vec!["commit", "-m", "fixture"],
        ] {
            fs::write(repo.join("app.rs"), "fn main() {}\n").unwrap();
            assert!(
                Command::new("/usr/bin/git")
                    .arg("-C")
                    .arg(&repo)
                    .args(args)
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_AUTHOR_NAME", "Fixture")
                    .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
                    .env("GIT_COMMITTER_NAME", "Fixture")
                    .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        // Host-selected fake transport records the child contract, then replaces
        // the remote with an owned local fixture. No external HTTP occurs.
        let script = format!(
            r#"#!/usr/bin/python3
import os,sys,json,subprocess,base64
args=sys.argv[1:]
entry={{'args':args,'env':dict(os.environ)}}
if 'fetch' in args and os.environ.get('GIT_CONFIG_COUNT')=='1':
 entry['match']={{}}
 for url in [{url}, {sibling}, {host}, {nested}]:
  p=subprocess.run(['/usr/bin/git','config','--get-urlmatch','http.extraHeader',url],capture_output=True)
  entry['match'][url]=p.stdout.decode().strip()
with open({log},'a') as f:f.write(json.dumps(entry)+'\n')
if 'fetch' in args:
 if {fail}:
  secret=os.environ.get('GIT_CONFIG_VALUE_0','')
  plain=base64.b64decode(secret.split()[-1]).decode() if secret else ''
  print(secret);print(plain);print(secret,file=sys.stderr);print(plain,file=sys.stderr);sys.exit(41)
 args=[{repo} if a=={url} else a for a in args]
 args=['-c','protocol.file.allow=always']+args
 os.environ['GIT_ALLOW_PROTOCOL']='file'
 for k in list(os.environ):
  if k.startswith('GIT_CONFIG_KEY_') or k.startswith('GIT_CONFIG_VALUE_') or k=='GIT_CONFIG_COUNT':del os.environ[k]
os.execve('/usr/bin/git',['git']+args,dict(os.environ))
"#,
            url = json!(URL),
            sibling = json!("https://example.test/org/private.git-other"),
            host = json!("https://other.test/org/private.git"),
            nested = json!("https://example.test/org/private.git/info/refs"),
            log = json!(dir.path().join("calls.jsonl")),
            repo = json!(repo),
            fail = if fail { "True" } else { "False" }
        );
        fs::write(dir.path().join("git-fixture"), script).unwrap();
        fs::set_permissions(
            dir.path().join("git-fixture"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        Self { dir }
    }
    fn command(&self, private: bool) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(self.dir.path().join("unused.db"))
            .args([
                "source",
                "acquire",
                "--url",
                URL,
                "--ref",
                "refs/heads/main",
                "--git-bin",
            ])
            .arg(self.dir.path().join("git-fixture"))
            .arg("--output")
            .arg(self.dir.path().join("capture"))
            .env("SELECTED_PRIVATE_TOKEN", TOKEN)
            .env("GITHUB_TOKEN", "ambient-must-not-reach-git")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env("GIT_CONFIG_VALUE_0", "ambient-header-must-not-reach-git");
        if private {
            c.args([
                "--credential-env",
                "SELECTED_PRIVATE_TOKEN",
                "--credential-url",
                URL,
                "--credential-username",
                "x-access-token",
            ]);
        }
        c
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}
#[test]
fn private_token_only_reaches_scoped_fetch_without_changing_receipt_format() {
    for private in [true, false] {
        let f = Fixture::new(false);
        let result = f.command(private).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let receipt: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(receipt["source"]["url"], URL);
        let calls = f.calls();
        assert!(calls.len() > 3);
        for call in calls {
            let args = call["args"].as_array().unwrap();
            assert!(!call["args"].to_string().contains(TOKEN));
            assert!(call["env"]["SELECTED_PRIVATE_TOKEN"].is_null());
            assert!(call["env"]["GITHUB_TOKEN"].is_null());
            assert_eq!(call["env"]["GIT_ASKPASS"], "/bin/false");
            assert!(args.contains(&json!("credential.helper=")));
            assert!(args.contains(&json!("http.followRedirects=false")));
            if private && args.contains(&json!("fetch")) {
                assert_eq!(call["env"]["GIT_CONFIG_COUNT"], "1");
                assert_eq!(
                    call["env"]["GIT_CONFIG_KEY_0"],
                    format!("http.{URL}.extraHeader")
                );
                assert!(
                    call["match"][URL]
                        .as_str()
                        .unwrap()
                        .starts_with("Authorization: Basic ")
                );
                assert_eq!(
                    call["match"]["https://example.test/org/private.git-other"],
                    ""
                );
                assert_eq!(call["match"]["https://other.test/org/private.git"], "");
                assert_eq!(
                    call["match"]["https://example.test/org/private.git/info/refs"],
                    call["match"][URL]
                );
            } else {
                assert!(call["env"]["GIT_CONFIG_COUNT"].is_null());
            }
        }
        for data in [
            &result.stdout,
            &result.stderr,
            &fs::read(f.dir.path().join("capture/receipt.json")).unwrap(),
        ] {
            let s = String::from_utf8_lossy(data);
            assert!(!s.contains(TOKEN));
            assert!(!s.contains("Authorization"));
            assert!(!s.contains("SELECTED_PRIVATE_TOKEN"));
        }
        assert!(!f.dir.path().join("unused.db").exists());
    }
}
#[test]
fn child_secret_echo_is_not_returned_on_failure() {
    let f = Fixture::new(true);
    let out = f.command(true).output().unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("Git"));
    assert!(!err.contains(TOKEN));
    assert!(!err.contains("Authorization"));
    assert!(!err.contains("Basic"));
    assert!(!f.dir.path().join("capture").exists());
}
#[test]
fn missing_environment_and_invalid_scope_fail_before_git() {
    for bad in ["missing", "scope", "username", "newline"] {
        let f = Fixture::new(false);
        let mut c = f.command(false);
        c.args([
            "--credential-env",
            "SELECTED_PRIVATE_TOKEN",
            "--credential-url",
            if bad == "scope" {
                "https://other.test/org/private.git"
            } else {
                URL
            },
            "--credential-username",
            if bad == "username" {
                "bad:name"
            } else {
                "x-access-token"
            },
        ]);
        if bad == "missing" {
            c.env_remove("SELECTED_PRIVATE_TOKEN");
        }
        if bad == "newline" {
            c.env("SELECTED_PRIVATE_TOKEN", "fixture-secret\nInjected: value");
        }
        let out = c.output().unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!f.dir.path().join("calls.jsonl").exists());
        assert!(!f.dir.path().join("capture").exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("fixture-secret"));
    }
}

#[test]
fn incomplete_or_non_https_cli_credential_selection_is_rejected() {
    for args in [
        vec![
            "--url",
            URL,
            "--ref",
            "refs/heads/main",
            "--credential-env",
            "SELECTED_PRIVATE_TOKEN",
        ],
        vec![
            "--local-repository",
            "/tmp/repo",
            "--ref",
            "refs/heads/main",
            "--credential-env",
            "SELECTED_PRIVATE_TOKEN",
            "--credential-url",
            URL,
            "--credential-username",
            "x-access-token",
        ],
        vec![
            "--npm-package",
            "example",
            "--version",
            "1.0.0",
            "--credential-env",
            "SELECTED_PRIVATE_TOKEN",
            "--credential-url",
            URL,
            "--credential-username",
            "x-access-token",
        ],
    ] {
        let d = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_0sec-native"))
            .args(["source", "acquire"])
            .args(args)
            .arg("--output")
            .arg(d.path().join("capture"))
            .env("SELECTED_PRIVATE_TOKEN", TOKEN)
            .output()
            .unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!d.path().join("capture").exists());
        assert!(!String::from_utf8_lossy(&out.stderr).contains(TOKEN));
    }
}
