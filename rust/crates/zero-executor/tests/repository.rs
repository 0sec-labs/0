#![cfg(target_os = "linux")]
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zero_executor::{RepositoryRequest, SnapshotLimits, acquire_repository};
use zero_protocol::source_acquisition::GitSource;

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn fixture() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "--initial-branch=main"]);
    std::fs::write(d.path().join("main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(d.path().join("run.sh"), "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(
        d.path().join("run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-m", "fixture"]);
    d
}
fn request(source: &Path, output: &Path) -> RepositoryRequest {
    RepositoryRequest {
        source: GitSource::Local {
            path: source.to_str().unwrap().into(),
        },
        reference: "refs/heads/main".into(),
        output: output.into(),
        git_binary: "/usr/bin/git".into(),
        timeout_ms: 10_000,
        limits: SnapshotLimits {
            max_files: 4096,
            max_bytes: 64 * 1024 * 1024,
        },
    }
}

#[tokio::test]
async fn branch_tag_commit_pin_and_private_source_survive_upstream_change() {
    let repo = fixture();
    let out = tempfile::tempdir().unwrap();
    let commit = git(repo.path(), &["rev-parse", "HEAD"]);
    let tree = git(repo.path(), &["rev-parse", "HEAD^{tree}"]);
    git(repo.path(), &["tag", "-a", "v1", "-m", "release"]);
    for (index, reference) in ["refs/heads/main", "refs/tags/v1", &commit]
        .iter()
        .enumerate()
    {
        let mut req = request(repo.path(), &out.path().join(format!("capture{index}")));
        req.reference = (*reference).into();
        let receipt = acquire_repository(req, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(receipt.commit_oid, commit);
        assert_eq!(receipt.tree_oid, tree);
        assert_eq!(receipt.executable_paths, vec!["run.sh"]);
        assert_eq!(receipt.snapshot.files.len(), 2);
        assert!(!Path::new(&receipt.snapshot.root).join(".git").exists());
        zero_executor::verify_snapshot(&receipt.snapshot, &|| Ok(())).unwrap();
        let bytes = std::fs::read(out.path().join(format!("capture{index}/receipt.json"))).unwrap();
        assert_eq!(bytes, receipt.canonical_bytes().unwrap());
    }
    std::fs::write(repo.path().join("main.rs"), "changed upstream").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "changed"]);
    assert_eq!(
        std::fs::read_to_string(out.path().join("capture0/source/main.rs")).unwrap(),
        "fn main() {}\n"
    );
    assert!(
        acquire_repository(
            request(repo.path(), &out.path().join("capture0")),
            CancellationToken::new()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn rejects_links_gitlinks_and_bounds_without_publishing() {
    for mode in 0..4 {
        let repo = fixture();
        let out = tempfile::tempdir().unwrap();
        let mut req = request(repo.path(), &out.path().join("capture"));
        match mode {
            0 => {
                std::os::unix::fs::symlink("/etc/passwd", repo.path().join("link")).unwrap();
                git(repo.path(), &["add", "link"]);
                git(repo.path(), &["commit", "-m", "link"]);
            }
            1 => {
                let commit = git(repo.path(), &["rev-parse", "HEAD"]);
                git(
                    repo.path(),
                    &[
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        &format!("160000,{commit},submodule"),
                    ],
                );
                git(repo.path(), &["commit", "-m", "submodule"]);
            }
            2 => req.limits.max_files = 1,
            _ => req.limits.max_bytes = 1,
        }
        assert!(
            acquire_repository(req, CancellationToken::new())
                .await
                .is_err(),
            "mode{mode}"
        );
        assert!(!out.path().join("capture").exists());
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn local_filters_hooks_alternates_and_sha256_do_not_expand_authority() {
    let repo = fixture();
    let out = tempfile::tempdir().unwrap();
    let marker = out.path().join("ran");
    git(
        repo.path(),
        &[
            "config",
            "filter.unsafe.smudge",
            &format!("touch {}", marker.display()),
        ],
    );
    std::fs::write(repo.path().join(".gitattributes"), "* filter=unsafe\n").unwrap();
    let hook = repo.path().join(".git/hooks/post-checkout");
    std::fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-m", "attributes"]);
    acquire_repository(
        request(repo.path(), &out.path().join("capture")),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!marker.exists());
    std::fs::write(
        repo.path().join(".git/objects/info/alternates"),
        "/elsewhere",
    )
    .unwrap();
    assert!(
        acquire_repository(
            request(repo.path(), &out.path().join("alternate")),
            CancellationToken::new()
        )
        .await
        .is_err()
    );
    let sha = tempfile::tempdir().unwrap();
    git(
        sha.path(),
        &["init", "--object-format=sha256", "--initial-branch=main"],
    );
    git(sha.path(), &["commit", "--allow-empty", "-m", "sha256"]);
    assert!(
        acquire_repository(
            request(sha.path(), &out.path().join("sha256")),
            CancellationToken::new()
        )
        .await
        .is_err()
    );
}

fn hanging_git(root: &Path) -> (PathBuf, PathBuf) {
    let executable = root.join("git-fixture");
    let started = root.join("started");
    std::fs::write(&executable,format!("#!/usr/bin/python3\nimport os,time\npid=os.fork()\nif pid==0:\n while True: time.sleep(1)\nopen({:?},'w').write(str(os.getpid())+' '+str(pid))\nwhile True: time.sleep(1)\n",started.to_str().unwrap())).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    (executable, started)
}
async fn ready(path: &Path) -> Vec<u32> {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if text.split_whitespace().count() == 2 {
                    break text
                        .split_whitespace()
                        .map(|s| s.parse().unwrap())
                        .collect();
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn stopped(pids: Vec<u32>) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if pids.iter().all(|pid| {
                std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| {
                    s.split(") ").nth(1).is_some_and(|s| s.starts_with('Z'))
                })
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_deadline_and_dropped_future_kill_owned_process_group() {
    for mode in 0..3 {
        let repo = fixture();
        let out = tempfile::tempdir().unwrap();
        let (binary, marker) = hanging_git(out.path());
        let mut req = request(repo.path(), &out.path().join("capture"));
        req.git_binary = binary;
        if mode == 1 {
            req.timeout_ms = 500;
        }
        let cancel = CancellationToken::new();
        let owned = cancel.clone();
        let task = tokio::spawn(async move { acquire_repository(req, owned).await });
        let pids = ready(&marker).await;
        if mode == 0 {
            cancel.cancel();
            assert!(task.await.unwrap().is_err());
        } else if mode == 1 {
            assert!(task.await.unwrap().is_err());
        } else {
            task.abort();
            let _ = task.await;
        }
        stopped(pids).await;
        assert!(!out.path().join("capture").exists());
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if !std::fs::read_dir(out.path()).unwrap().any(|p| {
                    p.unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".0sec-acquire-")
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn unsupported_inputs_reject_before_starting_git() {
    let out = tempfile::tempdir().unwrap();
    let (binary, marker) = hanging_git(out.path());
    for url in [
        "http://example.test/r",
        "ssh://example.test/r",
        "https://u:p@example.test/r",
        "https://example.test/r?token=secret",
        "https://example.test/r#branch",
    ] {
        let mut req = request(out.path(), &out.path().join("capture"));
        req.git_binary = binary.clone();
        req.source = GitSource::Https { url: url.into() };
        assert!(
            acquire_repository(req, CancellationToken::new())
                .await
                .is_err()
        );
    }
    for reference in [
        "main",
        "-evil",
        "refs/heads/../escape",
        "refs/heads/main:other",
        "refs/heads/a.lock",
    ] {
        let mut req = request(out.path(), &out.path().join("capture"));
        req.git_binary = binary.clone();
        req.reference = reference.into();
        assert!(
            acquire_repository(req, CancellationToken::new())
                .await
                .is_err()
        );
    }
    assert!(!marker.exists());
}

#[tokio::test]
async fn renamed_parent_and_symlink_replacement_cannot_redirect_publication_or_cleanup() {
    for symlink in [false, true] {
        let repo = fixture();
        let d = tempfile::tempdir().unwrap();
        let parent = d.path().join("approved");
        let moved = d.path().join("moved");
        let outside = d.path().join("outside");
        std::fs::create_dir(&parent).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"untouched").unwrap();
        let marker = d.path().join("started");
        let proceed = d.path().join("proceed");
        let binary = d.path().join("gated-git");
        std::fs::write(&binary,format!("#!/usr/bin/python3\nimport os,sys,time\nif not os.path.exists({marker:?}):\n open({marker:?},'w').write('ready')\n while not os.path.exists({proceed:?}): time.sleep(0.01)\nos.execv('/usr/bin/git',['git']+sys.argv[1:])\n",marker=marker.to_str().unwrap(),proceed=proceed.to_str().unwrap())).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut req = request(repo.path(), &parent.join("capture"));
        req.git_binary = binary;
        let task =
            tokio::spawn(async move { acquire_repository(req, CancellationToken::new()).await });
        tokio::time::timeout(Duration::from_secs(3), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        std::fs::rename(&parent, &moved).unwrap();
        if symlink {
            std::os::unix::fs::symlink(&outside, &parent).unwrap();
        } else {
            std::fs::create_dir(&parent).unwrap();
        }
        std::fs::write(&proceed, b"continue").unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!outside.join("capture").exists());
        assert!(!moved.join("capture").exists());
        assert!(!parent.join("capture").exists());
        assert_eq!(std::fs::read_dir(&moved).unwrap().count(), 0);
        assert_eq!(
            std::fs::read(outside.join("sentinel")).unwrap(),
            b"untouched"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
    }
}
