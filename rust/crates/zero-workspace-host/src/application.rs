//! Journaled, explicit host application. No model or executor entrypoint.
use crate::{
    Bundle, Change,
    filesystem::{directory, parent, read},
    preflight,
};
use nix::{
    errno::Errno,
    fcntl::{Flock, FlockArg, OFlag, RenameFlags, openat, renameat2},
    sys::stat::{Mode, mkdirat},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    change: Change,
    original_metadata: Option<crate::metadata::FileMetadata>,
    installed_metadata: Option<crate::metadata::FileMetadata>,
    original_identity: Option<(u64, u64)>,
    original_mode: Option<u32>,
    installed_identity: Option<(u64, u64)>,
    installed_mode: Option<u32>,
    original_parent_identity: Option<(u64, u64)>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    schema_version: u32,
    root: PathBuf,
    root_identity: (u64, u64),
    journal_identity: (u64, u64),
    bundle_sha256: String,
    entries: Vec<Entry>,
}
#[derive(Serialize)]
pub struct ApplyStatus {
    pub assessment: &'static str,
    pub phase_semantics: &'static str,
    pub phase: String,
    pub bundle_sha256: String,
    pub journal: PathBuf,
    pub applied_files: usize,
    pub total_files: usize,
    pub restored_files: usize,
}
fn identity(file: &File) -> Result<(u64, u64), String> {
    let m = file.metadata().map_err(|e| e.to_string())?;
    Ok((m.dev(), m.ino()))
}
fn sync(file: &File) -> Result<(), String> {
    file.sync_all().map_err(|e| e.to_string())
}
fn write_new(root: &File, name: &str, bytes: &[u8], mode: u32) -> Result<File, String> {
    let mut file = File::from(
        openat(
            root,
            name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(mode),
        )
        .map_err(|e| e.to_string())?,
    );
    file.write_all(bytes).map_err(|e| e.to_string())?;
    nix::sys::stat::fchmod(&file, Mode::from_bits_truncate(mode)).map_err(|e| e.to_string())?;
    sync(&file)?;
    sync(root)?;
    Ok(file)
}
fn marker(root: &File, name: &str) -> Result<(), String> {
    // Publish only a fully synced marker. A process can die while writing the
    // private pending file; a later recovery safely rewrites that bounded file.
    let pending = format!("pending-{name}");
    let mut staged = File::from(
        openat(
            root,
            pending.as_str(),
            OFlag::O_RDWR
                | OFlag::O_CREAT
                | OFlag::O_NOFOLLOW
                | OFlag::O_CLOEXEC
                | OFlag::O_NONBLOCK,
            Mode::from_bits_truncate(0o600),
        )
        .map_err(|e| e.to_string())?,
    );
    let m = staged.metadata().map_err(|e| e.to_string())?;
    if !m.is_file()
        || m.nlink() != 1
        || m.len() > 3
        || m.mode() & 0o777 != 0o600
        || m.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err("unexpected pending journal marker".into());
    }
    let mut prior = Vec::new();
    (&mut staged)
        .take(4)
        .read_to_end(&mut prior)
        .map_err(|e| e.to_string())?;
    if !b"{}\n".starts_with(&prior) {
        return Err("unexpected pending journal marker content".into());
    }
    staged.rewind().map_err(|e| e.to_string())?;
    staged.set_len(0).map_err(|e| e.to_string())?;
    staged.write_all(b"{}\n").map_err(|e| e.to_string())?;
    sync(&staged)?;
    renameat2(
        root,
        pending.as_str(),
        root,
        name,
        RenameFlags::RENAME_NOREPLACE,
    )
    .map_err(|e| e.to_string())?;
    sync(root)
}
fn marked(root: &File, name: &str) -> Result<bool, String> {
    match read(root, name, 3)? {
        None => Ok(false),
        Some(v) if v.bytes == b"{}\n" => Ok(true),
        Some(_) => Err("application journal marker differs".into()),
    }
}
fn check_root(intent: &Intent) -> Result<File, String> {
    let root = directory(&intent.root)?;
    if identity(&root)? != intent.root_identity {
        return Err("application root identity changed".into());
    }
    Ok(root)
}
fn check_journal(path: &Path, journal: &File, intent: &Intent) -> Result<(), String> {
    if identity(journal)? != intent.journal_identity
        || identity(&directory(path)?)? != intent.journal_identity
    {
        return Err("application journal directory changed".into());
    }
    Ok(())
}
fn check_parent(root: &File, path: &str, pinned: &File) -> Result<(), String> {
    let (current, _) = parent(root, path)?.ok_or("application parent disappeared")?;
    if identity(&current)? != identity(pinned)? {
        return Err("application parent directory changed".into());
    }
    Ok(())
}
fn load_intent(journal: &File) -> Result<Intent, String> {
    let raw = read(journal, "intent.json", 32 * 1024 * 1024)?
        .ok_or("application preparation interrupted before durable intent")?;
    let intent: Intent = serde_json::from_slice(&raw.bytes).map_err(|e| e.to_string())?;
    if intent.schema_version != 1
        || intent.entries.len() > 256
        || !zero_protocol::is_sha256(&intent.bundle_sha256)
    {
        return Err("application journal identity invalid".into());
    }
    if identity(journal)? != intent.journal_identity {
        return Err("copied or substituted application journal".into());
    }
    Ok(intent)
}
pub fn inspect_application(path: &Path) -> Result<ApplyStatus, String> {
    let journal = directory(path)?;
    let intent = load_intent(&journal)?;
    let mut applied = 0;
    let mut restored = 0;
    for i in 0..intent.entries.len() {
        if marked(&journal, &format!("applied-{i}"))? {
            applied += 1;
        }
        if marked(&journal, &format!("restored-{i}"))? {
            restored += 1;
        }
    }
    let completed = marked(&journal, "complete")?;
    if completed && applied != intent.entries.len() {
        return Err("complete application lacks file receipts".into());
    }
    let rolled_back = marked(&journal, "rolled-back")?;
    if rolled_back && restored != intent.entries.len() {
        return Err("rolled back application lacks restoration receipts".into());
    }
    Ok(ApplyStatus {
        assessment: "unverified",
        phase_semantics: "historical journal receipts; not a claim about current checkout contents",
        phase: if rolled_back {
            "rolled_back"
        } else if marked(&journal, "rollback-started")? {
            "recovery_interrupted"
        } else if completed {
            "completed"
        } else {
            "interrupted"
        }
        .into(),
        bundle_sha256: intent.bundle_sha256,
        journal: path.into(),
        applied_files: applied,
        total_files: intent.entries.len(),
        restored_files: restored,
    })
}
fn ensure_parent(root: &File, path: &str) -> Result<(File, String), String> {
    // First validate even when a missing directory terminates the ordinary walk.
    let _ = parent(root, path)?;
    let parts: Vec<_> = path.split('/').collect();
    let mut current = root.try_clone().map_err(|e| e.to_string())?;
    for name in &parts[..parts.len() - 1] {
        match mkdirat(&current, *name, Mode::from_bits_truncate(0o755)) {
            Ok(()) => sync(&current)?,
            Err(Errno::EEXIST) => (),
            Err(e) => return Err(e.to_string()),
        }
        current = File::from(
            openat(
                &current,
                *name,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|e| e.to_string())?,
        );
    }
    Ok((current, parts[parts.len() - 1].into()))
}
/// Existing journals are inspected only. No implicit replay after interruption.
/// Originals remain in the private journal; no rename replaces an existing file.
pub fn apply(
    bundle_path: &Path,
    root_path: &Path,
    journal_path: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<ApplyStatus, String> {
    let bundle = Bundle::read(bundle_path)?;
    if std::fs::symlink_metadata(journal_path).is_ok() {
        let journal = directory(journal_path)?;
        let intent = load_intent(&journal)?;
        if intent.root != root_path || intent.bundle_sha256 != bundle.digest {
            return Err("application retry differs from original intent".into());
        }
        return inspect_application(journal_path);
    }
    let root = directory(root_path)?;
    let _lock = Flock::lock(
        root.try_clone().map_err(|e| e.to_string())?,
        FlockArg::LockExclusiveNonblock,
    )
    .map_err(|(_, e)| format!("workspace apply is busy: {e}"))?;
    let preview = preflight(root_path, &bundle)?;
    if (preview.root_device, preview.root_inode) != identity(&root)? {
        return Err("application root changed before preparation".into());
    }
    if cancelled() {
        return Err("application cancelled before preparation".into());
    }
    let outer = directory(journal_path.parent().ok_or("journal parent missing")?)?;
    let leaf = journal_path.file_name().ok_or("journal leaf missing")?;
    if identity(&outer)?.0 != identity(&root)?.0 {
        return Err("application journal and checkout must share a filesystem".into());
    }
    if journal_path.starts_with(root_path) {
        let relative = journal_path
            .strip_prefix(root_path)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or("journal path UTF-8")?;
        if bundle.changes.iter().any(|c| {
            relative == c.path
                || relative.starts_with(&(c.path.clone() + "/"))
                || c.path.starts_with(&(relative.to_owned() + "/"))
        }) {
            return Err("application journal overlaps changed paths".into());
        }
    }
    mkdirat(&outer, leaf, Mode::from_bits_truncate(0o700)).map_err(|e| e.to_string())?;
    sync(&outer)?;
    let journal = File::from(
        openat(
            &outer,
            leaf,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| e.to_string())?,
    );
    if identity(&journal)? != identity(&directory(journal_path)?)? {
        return Err("application journal changed during creation".into());
    }
    let mut entries = Vec::new();
    for (i, change) in bundle.changes.iter().enumerate() {
        let original = read(
            &root,
            &change.path,
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        if original.as_ref().map(|v| &v.state) != change.before.as_ref() {
            return Err("workspace changed during preparation".into());
        }
        let (installed_identity, installed_mode, installed_metadata) = if change.after.is_some() {
            let file = bundle
                .current
                .manifest
                .files
                .iter()
                .find(|f| f.path == change.path)
                .ok_or("current file absent")?;
            let mut bytes = Vec::new();
            for chunk in &file.chunks {
                bytes.extend_from_slice(
                    bundle
                        .current
                        .blobs
                        .get(&chunk.sha256)
                        .ok_or("current chunk absent")?,
                );
            }
            let mode = original
                .as_ref()
                .map(|old| old.mode)
                .unwrap_or(if file.executable { 0o755 } else { 0o644 });
            let staged = write_new(&journal, &format!("new-{i}"), &bytes, mode)?;
            {
                if let Some(old) = &original {
                    old.metadata.apply_to(&staged)?;
                }
                (
                    Some(identity(&staged)?),
                    Some(mode),
                    Some(crate::metadata::FileMetadata::capture(&staged)?),
                )
            }
        } else {
            (None, None, None)
        };
        entries.push(Entry {
            change: change.clone(),
            original_metadata: original.as_ref().map(|v| v.metadata.clone()),
            installed_metadata,
            original_identity: original.as_ref().map(|v| v.identity),
            original_mode: original.as_ref().map(|v| v.mode),
            installed_identity,
            installed_mode,
            original_parent_identity: parent(&root, &change.path)?
                .map(|(p, _)| identity(&p))
                .transpose()?,
        });
    }
    let intent = Intent {
        schema_version: 1,
        root: root_path.into(),
        root_identity: identity(&root)?,
        journal_identity: identity(&journal)?,
        bundle_sha256: bundle.digest,
        entries,
    };
    let intent_bytes = serde_json::to_vec(&intent).map_err(|e| e.to_string())?;
    if intent_bytes.len() > 32 * 1024 * 1024 {
        return Err("application metadata exceeds journal bound".into());
    }
    write_new(&journal, "intent.json", &intent_bytes, 0o600)?;
    for (i, entry) in intent.entries.iter().enumerate() {
        if cancelled() {
            return Err(format!(
                "application cancelled; originals retained in {}",
                journal_path.display()
            ));
        }
        check_root(&intent)?;
        check_journal(journal_path, &journal, &intent)?;
        let current = read(
            &root,
            &entry.change.path,
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        if current.as_ref().map(|v| &v.state) != entry.change.before.as_ref()
            || current.as_ref().map(|v| v.identity) != entry.original_identity
            || current.as_ref().map(|v| v.mode) != entry.original_mode
            || current.as_ref().map(|v| &v.metadata) != entry.original_metadata.as_ref()
        {
            return Err(format!("application conflict: {}", entry.change.path));
        }
        let (parent, leaf) = ensure_parent(&root, &entry.change.path)?;
        if entry
            .original_parent_identity
            .is_some_and(|id| identity(&parent).ok() != Some(id))
        {
            return Err("original application parent changed".into());
        }
        if identity(&parent)?.0 != identity(&journal)?.0 {
            return Err("changed path crosses a filesystem boundary".into());
        }
        write_new(
            &journal,
            &format!("parent-{i}.json"),
            &serde_json::to_vec(&identity(&parent)?).map_err(|e| e.to_string())?,
            0o600,
        )?;
        check_parent(&root, &entry.change.path, &parent)?;
        marker(&journal, &format!("started-{i}"))?;
        if entry.change.before.is_some() {
            renameat2(
                &parent,
                leaf.as_str(),
                &journal,
                format!("original-{i}").as_str(),
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|e| e.to_string())?;
            sync(&parent)?;
            sync(&journal)?;
            let moved = read(
                &journal,
                &format!("original-{i}"),
                zero_protocol::source_archive::MAX_BYTES,
            )?
            .ok_or("displaced original missing")?;
            if Some(&moved.state) != entry.change.before.as_ref()
                || Some(moved.identity) != entry.original_identity
                || Some(moved.mode) != entry.original_mode
                || Some(&moved.metadata) != entry.original_metadata.as_ref()
            {
                return Err("displaced file changed; retained original requires recovery".into());
            }
        }
        if entry.change.after.is_some() {
            check_parent(&root, &entry.change.path, &parent)?;
            check_journal(journal_path, &journal, &intent)?;
            renameat2(
                &journal,
                format!("new-{i}").as_str(),
                &parent,
                leaf.as_str(),
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|e| format!("install conflict; original retained: {e}"))?;
            sync(&parent)?;
            sync(&journal)?;
        }
        check_root(&intent)?;
        check_parent(&root, &entry.change.path, &parent)?;
        check_journal(journal_path, &journal, &intent)?;
        let observed = read(
            &root,
            &entry.change.path,
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        if observed.as_ref().map(|v| &v.state) != entry.change.after.as_ref()
            || observed.as_ref().map(|v| v.identity) != entry.installed_identity
            || observed.as_ref().map(|v| v.mode) != entry.installed_mode
            || observed.as_ref().map(|v| &v.metadata) != entry.installed_metadata.as_ref()
        {
            return Err("installed file changed before receipt".into());
        }
        marker(&journal, &format!("applied-{i}"))?;
    }
    marker(&journal, "complete")?;
    inspect_application(journal_path)
}

/// Explicit reverse recovery; preserves later user changes by refusing to
/// displace anything except the exact installed inode, content and permissions.
/// New directories may remain; originals and removed candidates are retained.
pub fn rollback(journal_path: &Path, cancelled: &dyn Fn() -> bool) -> Result<ApplyStatus, String> {
    let journal = directory(journal_path)?;
    let intent = load_intent(&journal)?;
    if marked(&journal, "rolled-back")? {
        return inspect_application(journal_path);
    }
    let root = check_root(&intent)?;
    let _lock = Flock::lock(
        root.try_clone().map_err(|e| e.to_string())?,
        FlockArg::LockExclusiveNonblock,
    )
    .map_err(|(_, e)| format!("workspace recovery is busy: {e}"))?;
    if !marked(&journal, "rollback-started")? {
        marker(&journal, "rollback-started")?;
    }
    for (i, entry) in intent.entries.iter().enumerate().rev() {
        if cancelled() {
            return Err("workspace recovery cancelled; journal retained".into());
        }
        if marked(&journal, &format!("restored-{i}"))? {
            continue;
        }
        check_root(&intent)?;
        check_journal(journal_path, &journal, &intent)?;
        if !marked(&journal, &format!("started-{i}"))? {
            marker(&journal, &format!("restored-{i}"))?;
            continue;
        }
        let parent_receipt = read(&journal, &format!("parent-{i}.json"), 128)?
            .ok_or("recovery parent receipt missing")?;
        let expected_parent: (u64, u64) =
            serde_json::from_slice(&parent_receipt.bytes).map_err(|e| e.to_string())?;
        let (pinned_parent, leaf) =
            parent(&root, &entry.change.path)?.ok_or("recovery parent missing")?;
        if identity(&pinned_parent)? != expected_parent {
            return Err("recovery refuses a substituted parent directory".into());
        }
        let old = read(
            &journal,
            &format!("original-{i}"),
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        let current = read(
            &root,
            &entry.change.path,
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        if entry.change.before.is_some() && old.is_none() {
            // Either the move never happened or restoration completed before
            // its receipt was synced. Identity prevents accepting a substitute.
            if current.as_ref().map(|v| &v.state) != entry.change.before.as_ref()
                || current.as_ref().map(|v| v.identity) != entry.original_identity
                || current.as_ref().map(|v| v.mode) != entry.original_mode
                || current.as_ref().map(|v| &v.metadata) != entry.original_metadata.as_ref()
            {
                return Err(format!(
                    "recovery original missing or changed: {}",
                    entry.change.path
                ));
            }
            marker(&journal, &format!("restored-{i}"))?;
            continue;
        }
        if old.as_ref().map(|v| &v.state) != entry.change.before.as_ref()
            || old.as_ref().map(|v| v.identity) != entry.original_identity
            || old.as_ref().map(|v| v.mode) != entry.original_mode
            || old.as_ref().map(|v| &v.metadata) != entry.original_metadata.as_ref()
        {
            return Err("retained original differs; recovery preserves it for inspection".into());
        }
        // A never-published addition has no checkout effect to undo. Leave any
        // later file at that path alone, even when it happens to have equal bytes.
        if entry.change.before.is_none() {
            if let Some(staged) = read(
                &journal,
                &format!("new-{i}"),
                zero_protocol::source_archive::MAX_BYTES,
            )? {
                if Some(staged.identity) != entry.installed_identity
                    || Some(&staged.state) != entry.change.after.as_ref()
                {
                    return Err("staged addition identity differs".into());
                }
                marker(&journal, &format!("restored-{i}"))?;
                continue;
            }
        }
        let parent = pinned_parent;
        check_parent(&root, &entry.change.path, &parent)?;
        if let Some(current) = current {
            if Some(&current.state) != entry.change.after.as_ref()
                || Some(current.identity) != entry.installed_identity
                || Some(current.mode) != entry.installed_mode
                || Some(&current.metadata) != entry.installed_metadata.as_ref()
            {
                return Err(format!(
                    "recovery refuses later user changes: {}",
                    entry.change.path
                ));
            }
            renameat2(
                &parent,
                leaf.as_str(),
                &journal,
                format!("removed-{i}").as_str(),
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|e| e.to_string())?;
            sync(&parent)?;
            sync(&journal)?;
            let displaced = read(
                &journal,
                &format!("removed-{i}"),
                zero_protocol::source_archive::MAX_BYTES,
            )?
            .ok_or("removed candidate absent")?;
            if Some(&displaced.state) != entry.change.after.as_ref()
                || Some(displaced.identity) != entry.installed_identity
                || Some(displaced.mode) != entry.installed_mode
                || Some(&displaced.metadata) != entry.installed_metadata.as_ref()
            {
                return Err("file changed during recovery; displaced bytes retained".into());
            }
        } else if entry.change.before.is_none() {
            let displaced = read(
                &journal,
                &format!("removed-{i}"),
                zero_protocol::source_archive::MAX_BYTES,
            )?
            .ok_or("addition missing without recovery receipt")?;
            if Some(displaced.identity) != entry.installed_identity
                || Some(&displaced.state) != entry.change.after.as_ref()
            {
                return Err("retained removed addition differs".into());
            }
        }
        if entry.change.before.is_some() {
            check_parent(&root, &entry.change.path, &parent)?;
            check_journal(journal_path, &journal, &intent)?;
            if entry.change.after.is_some()
                && read(
                    &root,
                    &entry.change.path,
                    zero_protocol::source_archive::MAX_BYTES,
                )?
                .is_none()
            {
                let unpublished = read(
                    &journal,
                    &format!("new-{i}"),
                    zero_protocol::source_archive::MAX_BYTES,
                )?;
                let removed = read(
                    &journal,
                    &format!("removed-{i}"),
                    zero_protocol::source_archive::MAX_BYTES,
                )?;
                if unpublished.is_none() && removed.is_none() {
                    return Err(
                        "recovery refuses an unexplained deletion of the installed file".into(),
                    );
                }
                for retained in unpublished.iter().chain(removed.iter()) {
                    if Some(retained.identity) != entry.installed_identity
                        || Some(&retained.state) != entry.change.after.as_ref()
                        || Some(&retained.metadata) != entry.installed_metadata.as_ref()
                    {
                        return Err("recovery candidate provenance differs".into());
                    }
                }
            }
            renameat2(
                &journal,
                format!("original-{i}").as_str(),
                &parent,
                leaf.as_str(),
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|e| format!("restore conflict; original retained: {e}"))?;
            sync(&parent)?;
            sync(&journal)?;
        }
        check_root(&intent)?;
        check_parent(&root, &entry.change.path, &parent)?;
        check_journal(journal_path, &journal, &intent)?;
        let restored = read(
            &root,
            &entry.change.path,
            zero_protocol::source_archive::MAX_BYTES,
        )?;
        if restored.as_ref().map(|v| &v.state) != entry.change.before.as_ref()
            || restored.as_ref().map(|v| v.identity) != entry.original_identity
            || restored.as_ref().map(|v| v.mode) != entry.original_mode
            || restored.as_ref().map(|v| &v.metadata) != entry.original_metadata.as_ref()
        {
            return Err("restored path changed before receipt".into());
        }
        marker(&journal, &format!("restored-{i}"))?;
    }
    marker(&journal, "rolled-back")?;
    inspect_application(journal_path)
}
