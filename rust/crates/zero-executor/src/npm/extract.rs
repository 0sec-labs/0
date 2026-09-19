//! Maintained tar parsing; entry data is copied explicitly, never unpacked.
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};
use zero_protocol::{SnapshotPin, source_acquisition::validate_repository_path};
const MAX_EXPANDED: u64 = 72 * 1024 * 1024;
fn io<T>(r: std::io::Result<T>) -> Result<T, String> {
    // tar errors can quote a header path before that path has been validated.
    r.map_err(|e| {
        e.to_string()
            .chars()
            .take(4096)
            .flat_map(char::escape_default)
            .collect()
    })
}
fn read_chunks(
    reader: &mut impl Read,
    mut write: impl FnMut(&[u8]) -> Result<(), String>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<u64, String> {
    let mut total = 0u64;
    let mut b = [0; 65536];
    loop {
        check()?;
        let n = io(reader.read(&mut b))?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .ok_or("npm read size overflow")?;
        write(&b[..n])?;
    }
    Ok(total)
}
fn preflight(
    path: &Path,
    limits: crate::SnapshotLimits,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(io(File::open(path))?);
    let mut count = 0;
    let mut files = 0;
    let mut total = 0u64;
    let mut extension_total = 0u64;
    let mut last_end = 0u64;
    let mut pax_size = None;
    let mut pax_path = None;
    let mut long_path = None;
    let mut pending_extension = false;
    for entry in io(archive.entries())?.raw(true) {
        check()?;
        let mut entry = io(entry)?;
        count += 1;
        if count > 16384 {
            return Err("npm tar header count limit".into());
        }
        let kind = entry.header().entry_type();
        let size = entry.size();
        if kind.is_pax_local_extensions() || kind.is_gnu_longname() {
            pending_extension = true;
            if size > 16384 {
                return Err("npm tar extension byte limit".into());
            }
            extension_total = extension_total
                .checked_add(size)
                .ok_or("extension overflow")?;
            if extension_total > 1024 * 1024 {
                return Err("npm tar cumulative extension limit".into());
            }
            if kind.is_pax_local_extensions() {
                let mut keys = BTreeSet::new();
                for item in io(entry.pax_extensions())?.ok_or("PAX metadata absent")? {
                    let item = io(item)?;
                    let key = std::str::from_utf8(item.key_bytes()).map_err(|_| "PAX key UTF-8")?;
                    let value =
                        std::str::from_utf8(item.value_bytes()).map_err(|_| "PAX value UTF-8")?;
                    if !keys.insert(key.to_owned())
                        || ![
                            "path",
                            "size",
                            "mtime",
                            "atime",
                            "ctime",
                            "uid",
                            "gid",
                            "uname",
                            "gname",
                            "SCHILY.dev",
                            "SCHILY.ino",
                            "SCHILY.nlink",
                        ]
                        .contains(&key)
                    {
                        return Err("unsupported or duplicate npm PAX key".into());
                    }
                    if key == "path" {
                        pax_path = Some(value.to_owned());
                    }
                    if key == "size" {
                        let n = value.parse::<u64>().map_err(|_| "invalid PAX size")?;
                        if n > limits.max_bytes {
                            return Err("PAX size limit".into());
                        }
                        pax_size = Some(n);
                    }
                }
            } else {
                let mut bytes = Vec::new();
                read_chunks(
                    &mut entry,
                    |b| {
                        bytes.extend_from_slice(b);
                        Ok(())
                    },
                    check,
                )?;
                if bytes.len() != size as usize {
                    return Err("truncated GNU longname".into());
                }
                if bytes.last() == Some(&0) {
                    bytes.pop();
                }
                if bytes.contains(&0) {
                    return Err("GNU longname contains NUL".into());
                }
                if long_path
                    .replace(String::from_utf8(bytes).map_err(|_| "GNU longname UTF-8")?)
                    .is_some()
                {
                    return Err("duplicate GNU longname".into());
                }
            }
        } else if kind.is_file() || kind.is_dir() {
            if let (Some(pax), Some(long)) = (&pax_path, &long_path) {
                if pax != long {
                    return Err("contradictory npm path extensions".into());
                }
            }
            pax_path = None;
            long_path = None;
            pending_extension = false;
            if pax_size.take().is_some_and(|n| n != size) {
                return Err("PAX size conflicts with bounded tar header".into());
            }
            if kind.is_dir() && size != 0 {
                return Err("npm directory has content".into());
            }
            if kind.is_file() {
                files += 1;
                total = total.checked_add(size).ok_or("tar size overflow")?;
                if files > limits.max_files || total > limits.max_bytes {
                    return Err("npm extracted file bounds".into());
                }
            }
            if io(entry.header().mode())? & !0o777 != 0 {
                return Err("npm special permission bits forbidden".into());
            }
        } else {
            return Err(
                "npm links, sparse files, devices and unsupported tar extensions forbidden".into(),
            );
        }
        last_end = entry
            .raw_file_position()
            .checked_add(size.checked_add(511).ok_or("tar size overflow")? & !511)
            .ok_or("tar size overflow")?;
        // Consume every entry now, so truncation cannot be hidden by iterator skipping.
        let remaining = read_chunks(&mut entry, |_| Ok(()), check)?;
        if !kind.is_pax_local_extensions() && !kind.is_gnu_longname() && remaining != size {
            return Err("truncated npm archive member".into());
        }
    }
    if pending_extension {
        return Err("orphan npm PAX header".into());
    }
    let mut file = io(File::open(path))?;
    let len = io(file.metadata())?.len();
    if len % 512 != 0 || len < last_end.checked_add(1024).ok_or("tar size overflow")? {
        return Err("npm tar terminator or padding missing".into());
    }
    io(file.seek(SeekFrom::Start(last_end)))?;
    read_chunks(
        &mut file,
        |b| {
            if b.iter().any(|b| *b != 0) {
                Err("npm tar hidden trailing content".into())
            } else {
                Ok(())
            }
        },
        check,
    )?;
    Ok(())
}
// Bound implicit directories too: a small tar can otherwise fan out into many
// deep paths without contributing much to the file-data limit.
fn create_directories(
    root: &Path,
    relative: &Path,
    known: &mut BTreeSet<std::path::PathBuf>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<std::path::PathBuf, String> {
    let mut path = root.to_owned();
    for (depth, component) in relative.components().enumerate() {
        check()?;
        if depth >= 128 {
            return Err("npm directory depth limit".into());
        }
        path.push(component);
        if !known.contains(&path) {
            if known.len() >= 16384 {
                return Err("npm directory count limit".into());
            }
            io(std::fs::DirBuilder::new().mode(0o700).create(&path))?;
            known.insert(path.clone());
        }
    }
    Ok(path)
}
pub(super) fn source(
    compressed: &[u8],
    staging: &Path,
    limits: crate::SnapshotLimits,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(SnapshotPin, Vec<String>), String> {
    check()?;
    let archive_path = staging.join("download.tar");
    let mut tarfile = io(std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&archive_path))?;
    let mut decoder = flate2::bufread::GzDecoder::new(std::io::Cursor::new(compressed));
    let mut expanded = 0u64;
    read_chunks(
        &mut decoder,
        |bytes| {
            expanded = expanded
                .checked_add(bytes.len() as u64)
                .ok_or("npm expanded size overflow")?;
            if expanded > MAX_EXPANDED {
                return Err("npm decompression byte limit".into());
            }
            io(tarfile.write_all(bytes))
        },
        check,
    )?;
    if decoder.into_inner().position() != compressed.len() as u64 {
        return Err("npm gzip concatenation or trailing bytes forbidden".into());
    }
    drop(tarfile);
    preflight(&archive_path, limits, check)?;
    let root = staging.join("source");
    io(std::fs::DirBuilder::new().mode(0o700).create(&root))?;
    let mut archive = tar::Archive::new(io(File::open(&archive_path))?);
    let mut explicit = BTreeSet::new();
    let mut executable = Vec::new();
    let mut expected = Vec::new();
    let mut directories = BTreeSet::new();
    directories.insert(root.clone());
    for entry in io(archive.entries())? {
        check()?;
        let mut entry = io(entry)?;
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("unsupported npm archive member".into());
        }
        let raw = entry.path_bytes().into_owned();
        let raw = std::str::from_utf8(&raw).map_err(|_| "npm paths must be UTF-8")?;
        let path = if kind.is_dir() {
            raw.strip_suffix('/').unwrap_or(raw)
        } else {
            raw
        };
        if !explicit.insert(path.to_owned()) {
            return Err("duplicate npm archive path".into());
        }
        if path == "package" && kind.is_dir() {
            continue;
        }
        let path = path
            .strip_prefix("package/")
            .ok_or("npm entries must be under package/")?;
        validate_repository_path(path)?;
        let target = root.join(path);
        if kind.is_dir() {
            create_directories(&root, Path::new(path), &mut directories, check)?;
            continue;
        }
        let parent = Path::new(path).parent().ok_or("npm file parent absent")?;
        create_directories(&root, parent, &mut directories, check)?;
        let is_exec = io(entry.header().mode())? & 0o111 != 0;
        let mode = if is_exec { 0o700 } else { 0o600 };
        let mut file = io(std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .mode(mode)
            .open(&target))?;
        io(file.set_permissions(std::fs::Permissions::from_mode(mode)))?;
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        let size = entry.size();
        let copied = read_chunks(
            &mut entry,
            |b| {
                hash.update(b);
                io(file.write_all(b))
            },
            check,
        )?;
        if copied != size {
            return Err("npm extracted length differs".into());
        }
        io(file.sync_all())?;
        expected.push(zero_protocol::SnapshotFile {
            path: path.into(),
            digest: format!("sha256:{:x}", hash.finalize()),
            bytes: size,
        });
        if is_exec {
            executable.push(path.to_owned());
        }
    }
    io(std::fs::remove_file(&archive_path))?;
    for directory in directories.iter().rev() {
        check()?;
        io(File::open(directory).and_then(|f| f.sync_all()))?;
    }
    expected.sort_by(|a, b| a.path.cmp(&b.path));
    executable.sort();
    let canonical = io(std::fs::canonicalize(&root))?;
    let snapshot = crate::pin_snapshot_checked(&canonical, limits, check)?;
    if serde_json::to_value(&snapshot.files).map_err(|e| e.to_string())?
        != serde_json::to_value(expected).map_err(|e| e.to_string())?
    {
        return Err("npm extracted snapshot differs".into());
    }
    check()?;
    Ok((snapshot, executable))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut w = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        w.write_all(bytes).unwrap();
        w.finish().unwrap()
    }
    fn header(path: &str, kind: u8, size: u64) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.set_path(path).unwrap();
        h.set_entry_type(tar::EntryType::new(kind));
        h.set_size(size);
        h.set_mode(0o644);
        h.set_cksum();
        h
    }
    fn tar(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut w = tar::Builder::new(Vec::new());
        for (path, kind, bytes) in entries {
            w.append(&header(path, *kind, bytes.len() as u64), *bytes)
                .unwrap();
        }
        w.into_inner().unwrap()
    }
    fn extract(bytes: &[u8]) -> Result<(SnapshotPin, Vec<String>), String> {
        let d = tempfile::tempdir().unwrap();
        source(
            bytes,
            d.path(),
            crate::SnapshotLimits {
                max_files: 4096,
                max_bytes: 64 * 1024 * 1024,
            },
            &|| Ok(()),
        )
    }
    fn pax(key: &str, value: &str) -> Vec<u8> {
        let body = format!(" {key}={value}\n");
        let mut n = body.len() + 1;
        loop {
            let total = n.to_string().len() + body.len();
            if n == total {
                return format!("{n}{body}").into_bytes();
            }
            n = total;
        }
    }
    #[test]
    fn supports_long_paths_pax_metadata_and_executable_modes() {
        let long = format!("package/{}/file", "dir".repeat(70));
        let mut w = tar::Builder::new(Vec::new());
        w.append_pax_extensions([("mtime", b"123.25".as_slice()), ("path", long.as_bytes())])
            .unwrap();
        let mut h = header("package/short", b'0', 3);
        h.set_mode(0o755);
        h.set_cksum();
        w.append(&h, b"abc".as_slice()).unwrap();
        let other = format!("package/{}/other", "long".repeat(60));
        w.append_data(&mut header("unused", b'0', 2), &other, b"\0x".as_slice())
            .unwrap();
        let result = extract(&gzip(&w.into_inner().unwrap())).unwrap();
        assert_eq!(result.0.files.len(), 2);
        assert_eq!(result.1, vec![long.strip_prefix("package/").unwrap()]);
    }
    #[test]
    fn rejects_paths_links_sparse_devices_and_ancestor_collisions() {
        for path in [
            "../escape",
            "/absolute",
            "package/../escape",
            "package/a/../../escape",
            "package/.git/config",
            "package/a\\b",
        ] {
            let mut h = header("package/safe", b'0', 1);
            h.as_mut_bytes()[..100].fill(0);
            h.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            h.set_cksum();
            let mut w = tar::Builder::new(Vec::new());
            w.append(&h, b"x".as_slice()).unwrap();
            assert!(extract(&gzip(&w.into_inner().unwrap())).is_err(), "{path}");
        }
        for kind in [b'1', b'2', b'3', b'4', b'6', b'S', b'g', b'K'] {
            assert!(
                extract(&gzip(&tar(&[("package/evil", kind, b"")]))).is_err(),
                "{kind}"
            );
        }
        for entries in [
            vec![
                ("package/x", b'0', b"x".as_slice()),
                ("package/x", b'0', b"x".as_slice()),
            ],
            vec![
                ("package/x", b'0', b"x".as_slice()),
                ("package/x/y", b'0', b"x".as_slice()),
            ],
            vec![
                ("package/x/y", b'0', b"x".as_slice()),
                ("package/x", b'0', b"x".as_slice()),
            ],
        ] {
            assert!(extract(&gzip(&tar(&entries))).is_err());
        }
    }
    #[test]
    fn rejects_extension_ambiguity_orphans_and_hidden_trailers() {
        let p = pax("path", "package/a");
        let size = pax("size", "2");
        let mut duplicate = p.clone();
        duplicate.extend_from_slice(&p);
        for raw in [
            tar(&[("PaxHeader", b'x', &p)]),
            tar(&[("LongName", b'L', b"package/a\0")]),
            tar(&[("PaxHeader", b'x', &duplicate), ("package/a", b'0', b"x")]),
            tar(&[("PaxHeader", b'x', &size), ("package/a", b'0', b"x")]),
            tar(&[
                ("PaxHeader", b'x', &p),
                ("LongName", b'L', b"package/b\0"),
                ("package/a", b'0', b"x"),
            ]),
            tar(&[
                ("PaxHeader", b'x', b"999 path=package/a\n"),
                ("package/a", b'0', b"x"),
            ]),
        ] {
            assert!(extract(&gzip(&raw)).is_err());
        }
        let valid = tar(&[("package/a", b'0', b"x")]);
        for trailing in [b"hidden".as_slice(), gzip(b"hidden").as_slice()] {
            let mut compressed = gzip(&valid);
            compressed.extend_from_slice(trailing);
            assert!(extract(&compressed).is_err());
        }
        let mut hidden = valid.clone();
        hidden.extend_from_slice(&tar(&[("package/hidden", b'0', b"x")]));
        assert!(extract(&gzip(&hidden)).is_err());
        let truncated = valid[..1025].to_vec();
        assert!(extract(&gzip(&truncated)).is_err());
    }
    #[test]
    fn cumulative_extension_and_expansion_limits_are_real_byte_bounds() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut name = vec![b'x'; 16383];
        name.push(0);
        for _ in 0..65 {
            builder
                .append(
                    &header("LongName", b'L', name.len() as u64),
                    name.as_slice(),
                )
                .unwrap();
            builder
                .append(&header("package/x", b'0', 0), b"".as_slice())
                .unwrap();
        }
        let error = extract(&gzip(&builder.into_inner().unwrap())).unwrap_err();
        assert!(error.contains("cumulative extension limit"), "{error}");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        for _ in 0..=MAX_EXPANDED / 65536 {
            encoder.write_all(&[0; 65536]).unwrap();
        }
        let error = extract(&encoder.finish().unwrap()).unwrap_err();
        assert!(error.contains("decompression byte limit"), "{error}");
    }
    #[test]
    fn rejects_checksum_size_overflow_quotas_and_observes_cancellation() {
        let mut hostile = header("package/safe", b'0', 0);
        hostile.as_mut_bytes()[..100].fill(0);
        hostile.as_mut_bytes()[..13].copy_from_slice(b"package/\x1b[31m");
        hostile.as_mut_bytes()[100..108].fill(b'x');
        hostile.set_cksum();
        let mut raw = hostile.as_bytes().to_vec();
        raw.extend_from_slice(&[0; 1024]);
        let error = extract(&gzip(&raw)).unwrap_err();
        assert!(!error.contains('\x1b'));
        assert!(!error.contains('\n'));
        assert!(error.len() <= 49152);
        let valid = tar(&[("package/a", b'0', b"x")]);
        let mut bad = valid.clone();
        bad[0] ^= 1;
        assert!(extract(&gzip(&bad)).is_err());
        for fill in [b'7', 255] {
            let mut h = header("package/a", b'0', 0);
            h.as_mut_bytes()[124..136].fill(fill);
            h.set_cksum();
            let mut raw = h.as_bytes().to_vec();
            raw.extend_from_slice(&[0; 1024]);
            assert!(extract(&gzip(&raw)).is_err());
        }
        let deep = format!("package/{}file", "d/".repeat(129));
        let mut builder = tar::Builder::new(Vec::new());
        builder
            .append_data(&mut header("unused", b'0', 1), &deep, b"x".as_slice())
            .unwrap();
        assert!(extract(&gzip(&builder.into_inner().unwrap())).is_err());
        let extension = vec![b'x'; 16385];
        assert!(
            extract(&gzip(&tar(&[
                ("LongName", b'L', &extension),
                ("package/a", b'0', b"x")
            ])))
            .is_err()
        );
        let d = tempfile::tempdir().unwrap();
        let bytes = gzip(&tar(&[("package/a", b'0', b"xx")]));
        assert!(
            source(
                &bytes,
                d.path(),
                crate::SnapshotLimits {
                    max_files: 1,
                    max_bytes: 1
                },
                &|| Ok(())
            )
            .is_err()
        );
        let d = tempfile::tempdir().unwrap();
        let calls = std::cell::Cell::new(0);
        let data = vec![7; 200_000];
        let bytes = gzip(&tar(&[("package/a", b'0', &data)]));
        let error = source(
            &bytes,
            d.path(),
            crate::SnapshotLimits {
                max_files: 10,
                max_bytes: 1_000_000,
            },
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() > 3 {
                    Err("cancelled fixture".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(error, "cancelled fixture");
    }
}
