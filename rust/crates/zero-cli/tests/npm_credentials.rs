#![cfg(target_os = "linux")]
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
const TOKEN: &str = "fixture-private-npm-token-123";
struct Registry {
    dir: tempfile::TempDir,
    base: String,
    seen: Arc<Mutex<Vec<String>>>,
    foreign: TcpListener,
    stop: Arc<AtomicBool>,
    task: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Registry {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.task.take().unwrap().join().unwrap();
    }
}
impl Registry {
    fn new(mode: &'static str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let created=Command::new("/usr/bin/python3").args(["-c",r#"import io,tarfile,gzip,hashlib,base64,sys
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w') as tar:
 for path,data in [('package/package.json',b'{"name":"@scope/fixture","version":"1.2.3","scripts":{"postinstall":"exit 99"}}'),('package/app.js',b'export const value = 1;\n')]:
  info=tarfile.TarInfo(path);info.size=len(data);info.mode=0o644;tar.addfile(info,io.BytesIO(data))
 if sys.argv[2] in ['secret_filename','secret_malformed_header']:
  data=b'fixture';info=tarfile.TarInfo('package/'+sys.argv[3]+'.js');info.size=len(data);info.mode=0o755;tar.addfile(info,io.BytesIO(data))
raw=bytearray(buf.getvalue())
if sys.argv[2]=='secret_malformed_header':
 offset=raw.index(('package/'+sys.argv[3]+'.js').encode())
 raw[offset+100:offset+108]=b'badmode!'
 raw[offset+148:offset+156]=b'        '
 checksum=sum(raw[offset:offset+512])
 raw[offset+148:offset+156]=('%06o\0 '%checksum).encode()
compressed=gzip.compress(bytes(raw),mtime=0)
open(sys.argv[1],'wb').write(compressed)
print('sha512-'+base64.b64encode(hashlib.sha512(compressed).digest()).decode())
"#]).arg(dir.path().join("fixture.tgz")).arg(mode).arg(TOKEN).output().unwrap();
        assert!(created.status.success());
        let integrity = String::from_utf8(created.stdout).unwrap().trim().to_owned();
        let bytes = fs::read(dir.path().join("fixture.tgz")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let foreign = TcpListener::bind("127.0.0.1:0").unwrap();
        foreign.set_nonblocking(true).unwrap();
        let foreign_url = format!("http://{}/package.tgz", foreign.local_addr().unwrap());
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let base = format!("{origin}/private/");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let registry = base.clone();
        let task = std::thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("{e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0u8; 1024];
                while !raw.windows(4).any(|v| v == b"\r\n\r\n") {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    raw.extend_from_slice(&chunk[..n]);
                    assert!(raw.len() < 16384);
                }
                let request = String::from_utf8(raw).unwrap();
                let tarball = request.starts_with("GET /private/package.tgz ");
                record.lock().unwrap().push(request);
                let (status, body, extra) = if mode == "redirect_metadata"
                    || (mode == "redirect_tarball" && tarball)
                {
                    (
                        "302 Found",
                        Vec::new(),
                        format!("Location: {foreign_url}\r\n"),
                    )
                } else if mode == "secret_echo" || mode == "secret_json" {
                    (
                        if mode == "secret_json" {
                            "200 OK"
                        } else {
                            "401 Unauthorized"
                        },
                        format!("Bearer {TOKEN}").into_bytes(),
                        String::new(),
                    )
                } else if tarball {
                    ("200 OK", bytes.clone(), String::new())
                } else {
                    let url = match mode {
                        "cross_origin" => foreign_url.clone(),
                        "outside_base" => format!("{origin}/another/package.tgz"),
                        "encoded" => format!("{registry}%2e%2e/another/package.tgz"),
                        "secret_url" => format!("{registry}{TOKEN}.tgz"),
                        "secret_encoded" => format!(
                            "{registry}{}.tgz",
                            TOKEN
                                .bytes()
                                .map(|b| format!("%{b:02x}"))
                                .collect::<String>()
                        ),
                        "secret_userinfo" => format!(
                            "http://{TOKEN}@{}/private/package.tgz",
                            origin.strip_prefix("http://").unwrap()
                        ),
                        "secret_query" => format!("{registry}package.tgz?token={TOKEN}"),
                        _ => format!("{registry}package.tgz"),
                    };
                    let hash = if mode == "corrupt_digest" {
                        format!("sha512-{}", "A".repeat(86) + "==")
                    } else {
                        integrity.clone()
                    };
                    ("200 OK",serde_json::to_vec(&json!({"name":"@scope/fixture","version":"1.2.3","dist":{"tarball":url,"integrity":hash}})).unwrap(),String::new())
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self {
            dir,
            base,
            seen,
            foreign,
            stop,
            task: Some(task),
        }
    }
    fn command(&self, auth: bool) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_0sec-native"));
        c.arg("--state")
            .arg(self.dir.path().join("unused.db"))
            .args([
                "source",
                "acquire",
                "--npm-package",
                "@scope/fixture",
                "--version",
                "1.2.3",
                "--registry",
                &self.base,
                "--output",
            ])
            .arg(self.dir.path().join("capture"))
            .args(["--timeout-ms", "3000"])
            .env("PRIVATE_NPM_TOKEN", TOKEN)
            .env("NODE_AUTH_TOKEN", "ambient-token-unused")
            .env("NPM_TOKEN", "ambient-token-unused")
            .env("npm_config_registry", "https://invalid.example/");
        if auth {
            c.args([
                "--npm-credential-env",
                "PRIVATE_NPM_TOKEN",
                "--npm-credential-registry",
                &self.base,
            ]);
        }
        c
    }
}
#[test]
fn explicit_auth_only_and_public_receipt_shape_unchanged() {
    for auth in [true, false] {
        let r = Registry::new("good");
        let out = r.command(auth).output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(receipt["source"]["registry"], r.base);
        let seen = r.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        for request in seen.iter() {
            assert_eq!(
                request
                    .to_ascii_lowercase()
                    .contains(&format!("authorization: bearer {TOKEN}")),
                auth
            );
            assert!(!request.contains("ambient-token-unused"));
        }
        for data in [
            &out.stdout,
            &out.stderr,
            &fs::read(r.dir.path().join("capture/receipt.json")).unwrap(),
        ] {
            let s = String::from_utf8_lossy(data);
            assert!(!s.contains(TOKEN));
            assert!(!s.contains("PRIVATE_NPM_TOKEN"));
        }
        assert!(
            fs::read_to_string(r.dir.path().join("capture/source/package.json"))
                .unwrap()
                .contains("postinstall")
        );
        assert!(!r.dir.path().join("unused.db").exists());
        assert!(r.foreign.accept().is_err());
    }
}
#[test]
fn redirects_cross_origin_path_escape_corruption_and_echo_fail_closed() {
    for mode in [
        "redirect_metadata",
        "redirect_tarball",
        "cross_origin",
        "outside_base",
        "encoded",
        "corrupt_digest",
        "secret_echo",
        "secret_url",
        "secret_encoded",
        "secret_userinfo",
        "secret_query",
        "secret_json",
        "secret_filename",
        "secret_malformed_header",
    ] {
        let r = Registry::new(mode);
        let out = r.command(true).output().unwrap();
        assert!(!out.status.success(), "{mode}");
        assert!(out.stdout.is_empty());
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(!err.contains(TOKEN));
        assert!(!err.contains("Bearer"));
        if mode == "secret_malformed_header" {
            assert!(err.contains("authenticated npm archive extraction failed"));
        }
        assert!(!r.dir.path().join("capture").exists());
        assert!(r.foreign.accept().is_err());
        let expected = if [
            "redirect_tarball",
            "corrupt_digest",
            "secret_filename",
            "secret_malformed_header",
        ]
        .contains(&mode)
        {
            2
        } else {
            1
        };
        assert_eq!(r.seen.lock().unwrap().len(), expected, "{mode}: {err}");
    }
}
#[test]
fn missing_or_mismatched_credential_selector_makes_no_http_request() {
    for mode in ["missing", "scope", "newline", "missing_flag"] {
        let r = Registry::new("good");
        let mut c = r.command(false);
        c.args(["--npm-credential-env", "PRIVATE_NPM_TOKEN"]);
        if mode != "missing_flag" {
            c.args([
                "--npm-credential-registry",
                if mode == "scope" {
                    "https://different.example/"
                } else {
                    &r.base
                },
            ]);
        }
        if mode == "missing" {
            c.env_remove("PRIVATE_NPM_TOKEN");
        }
        if mode == "newline" {
            c.env("PRIVATE_NPM_TOKEN", "secret\nHeader: value");
        }
        let out = c.output().unwrap();
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(r.seen.lock().unwrap().is_empty());
        assert!(!r.dir.path().join("capture").exists());
    }
}
