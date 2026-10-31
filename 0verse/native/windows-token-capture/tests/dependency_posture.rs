//! Guard the Ed25519-only authorization contract against optional backend activation.
use std::process::Command;

#[test]
fn all_target_feature_graph_keeps_optional_rsa_and_elliptic_backends_disabled() {
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "--locked",
            "--all-features",
            "--target",
            "all",
            "--edges",
            "normal,build",
            "--prefix",
            "none",
            "--format",
            "{p}",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo tree must be available alongside cargo test");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let graph = String::from_utf8(output.stdout).expect("Cargo package names are UTF-8");
    assert!(
        graph
            .lines()
            .any(|line| line.starts_with("ed25519-dalek v"))
    );
    for backend in ["rsa", "crypto-bigint", "p256", "p384", "p521"] {
        assert!(
            !graph
                .lines()
                .any(|line| line.starts_with(&format!("{backend} v"))),
            "unsupported cryptographic backend activated: {backend}\n{graph}"
        );
    }
}

#[test]
fn older_block_buffer_keeps_cursor_separate_when_compression_panics() {
    use sha2::digest::{block_buffer::EagerBuffer, typenum::U4};
    let mut buffer = EagerBuffer::<U4>::new(&[1, 2]);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        buffer.digest_blocks(&[3, 0xff], |_| panic!("simulated compression failure"));
    }));
    assert!(result.is_err());
    // The advisory's inline-cursor overwrite would corrupt this value to 0xff.
    assert_eq!(buffer.get_pos(), 2);
    assert_eq!(buffer.get_data(), &[1, 2]);
}
