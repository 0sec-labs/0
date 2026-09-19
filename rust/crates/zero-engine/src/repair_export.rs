//! Offline patch export requires the independently reassessed repair workflow.
use super::*;
use zero_protocol::repair::{MaterializeRequest, RepairValidationStatus};

/// Return a unified patch from exact retained bytes. This neither reads nor changes
/// the original checkout, and does not establish a verified vulnerability.
pub fn read_source_repair_patch(
    state: &Path,
    session: &str,
    source: &str,
    reproduction: &str,
    repair: &str,
) -> Result<String, EngineError> {
    let store = Store::open_read_only(state)?;
    let report = source_report::compose_from_store(
        &store,
        session,
        source,
        &[reproduction.into()],
        &[repair.into()],
    )?;
    let validated = report
        .repairs
        .first()
        .ok_or_else(|| fail("repair report absent"))?;
    if validated.operation_status != OperationStatus::Succeeded
        || validated.status != RepairValidationStatus::ValidatedCandidateForPlan
    {
        return Err(fail(
            "patch export requires an independently validated candidate for the frozen plan",
        ));
    }
    let digest = validated
        .artifacts
        .get("repair.materialize_request")
        .ok_or_else(|| fail("retained materialization unavailable"))?;
    let request: MaterializeRequest = serde_json::from_slice(&store.artifact(digest)?)?;
    let retained = source_provenance::load(&store, session, source)?;
    let before = retained
        .bundle
        .files()
        .iter()
        .find(|f| f.path() == request.target)
        .ok_or_else(|| {
            fail("complete retained preimage unavailable; original source is not read")
        })?;
    if before.sha256() != request.expected_preimage_sha256
        || format!("sha256:{}", zero_plugin::sha256(before.text().as_bytes()))
            != request.expected_preimage_sha256
    {
        return Err(fail("retained preimage differs from validated repair"));
    }
    patch(&request.target, before.text(), &request.replacement)
}

fn fail(message: &str) -> EngineError {
    EngineError::State(message.into())
}

fn patch(path: &str, before: &str, after: &str) -> Result<String, EngineError> {
    // Tabs delimit unified-diff timestamps; control characters in a filename must
    // not be allowed to manufacture extra file headers. Binary patches are not
    // supported by this text-only export.
    if path.is_empty()
        || path.chars().any(char::is_control)
        || path.contains('\\')
        || path.contains('"')
        || before.contains('\0')
        || after.contains('\0')
    {
        return Err(fail(
            "repair path or binary content cannot be represented by this text patch exporter",
        ));
    }
    if before == after {
        return Err(fail("validated repair has no byte changes to export"));
    }
    let count = |text: &str| text.split_inclusive('\n').count();
    let old = count(before);
    let new = count(after);
    let mut output = format!(
        "--- a/{path}\t\n+++ b/{path}\t\n@@ -{},{} +{},{} @@\n",
        usize::from(old != 0),
        old,
        usize::from(new != 0),
        new
    );
    for (prefix, text) in [('-', before), ('+', after)] {
        for line in text.split_inclusive('\n') {
            output.push(prefix);
            output.push_str(line);
            if !line.ends_with('\n') {
                output.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(unix)]
    fn patches_apply_to_exact_bytes_including_empty_and_unicode_files() {
        for (before, after) in [
            ("", "x"),
            ("x", ""),
            ("a\r\nb", "c\r\n"),
            ("old\n", "new"),
            ("α\n", "β\n"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("space name.txt");
            std::fs::write(&file, before).unwrap();
            let patch_file = dir.path().join("change.patch");
            std::fs::write(&patch_file, patch("space name.txt", before, after).unwrap()).unwrap();
            let result = std::process::Command::new("patch")
                .current_dir(dir.path())
                .args(["--batch", "-p1", "-i"])
                .arg(&patch_file)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stdout)
            );
            assert_eq!(std::fs::read(&file).unwrap(), after.as_bytes());
        }
    }
    #[test]
    fn exact_lines_preserve_crlf_and_missing_final_newlines() {
        assert_eq!(
            patch("space name.txt", "a\r\nb", "c\r\n").unwrap(),
            "--- a/space name.txt\t\n+++ b/space name.txt\t\n@@ -1,2 +1,1 @@\n-a\r\n-b\n\\ No newline at end of file\n+c\r\n"
        );
        assert!(patch("a", "", "x").unwrap().contains("@@ -0,0 +1,1 @@"));
        assert!(patch("a", "x", "").unwrap().contains("@@ -1,1 +0,0 @@"));
    }
    #[test]
    fn unrepresentable_or_unchanged_patch_rejected() {
        for path in ["x\ny", "x\ty", "x\\y", "x\"y"] {
            assert!(patch(path, "a", "b").is_err());
        }
        assert!(patch("a", "a\0", "b").is_err());
        assert!(patch("a", "a", "a").is_err());
    }
}
