//! Explicit registry metadata + integrity-checked published source. Never installs.
mod credential;
mod extract;
pub use credential::NpmCredential;
use sha2::{Digest, Sha256, Sha512};
use std::{
    path::{Component, PathBuf},
    time::Duration,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use zero_protocol::source_acquisition::{NpmReceipt, NpmSource};

#[derive(Debug, Clone)]
pub struct NpmRequest {
    pub source: NpmSource,
    pub output: PathBuf,
    pub timeout_ms: u64,
    pub limits: crate::SnapshotLimits,
}
pub async fn acquire_npm(
    request: NpmRequest,
    cancel: CancellationToken,
) -> Result<NpmReceipt, String> {
    acquire_npm_with_credential(request, None, cancel).await
}
/// Authenticate only with the explicit host selector; default acquisition stays public.
pub async fn acquire_npm_with_credential(
    request: NpmRequest,
    credential: Option<NpmCredential>,
    cancel: CancellationToken,
) -> Result<NpmReceipt, String> {
    let token = cancel.child_token();
    let _on_drop = token.clone().drop_guard();
    tokio::spawn(async move { owned(request, credential, token).await })
        .await
        .map_err(|_| "npm acquisition supervisor failed")?
}
fn check(cancel: &CancellationToken, deadline: Instant) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("npm acquisition cancelled".into())
    } else if Instant::now() >= deadline {
        Err("npm acquisition deadline exceeded".into())
    } else {
        Ok(())
    }
}
async fn download(
    client: &reqwest::Client,
    url: &str,
    cap: usize,
    cancel: &CancellationToken,
    deadline: Instant,
    credential: Option<&credential::ResolvedCredential>,
) -> Result<Vec<u8>, String> {
    check(cancel, deadline)?;
    let mut request = client.get(url).header("Accept-Encoding", "identity");
    if let Some(credential) = credential {
        request = request.header(reqwest::header::AUTHORIZATION, credential.header_for(url)?);
    }
    let mut response = tokio::select! {biased;_=cancel.cancelled()=>return Err("npm acquisition cancelled".into()),_=tokio::time::sleep_until(deadline)=>return Err("npm acquisition deadline exceeded".into()),v=request.send()=>v.map_err(|_|"npm registry transport failed")?};
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > cap as u64)
        || response
            .headers()
            .get("content-encoding")
            .is_some_and(|v| v != "identity")
    {
        return Err("npm response status, encoding or declared length rejected".into());
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {biased;_=cancel.cancelled()=>return Err("npm acquisition cancelled".into()),_=tokio::time::sleep_until(deadline)=>return Err("npm acquisition deadline exceeded".into()),v=response.chunk()=>v.map_err(|_|"npm response interrupted")?};
        let Some(chunk) = chunk else { break };
        if bytes.len().checked_add(chunk.len()).is_none_or(|n| n > cap) {
            return Err("npm download byte limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    check(cancel, deadline)?;
    Ok(bytes)
}
async fn owned(
    request: NpmRequest,
    credential: Option<NpmCredential>,
    cancel: CancellationToken,
) -> Result<NpmReceipt, String> {
    request.source.validate()?;
    let credential = credential.map(|c| c.resolve(&request.source)).transpose()?;
    if request.timeout_ms == 0
        || request.timeout_ms > 120_000
        || request.limits.max_files == 0
        || request.limits.max_files > 4096
        || request.limits.max_bytes == 0
        || request.limits.max_bytes > 64 * 1024 * 1024
    {
        return Err("npm acquisition limits outside supported bounds".into());
    }
    if !request.output.is_absolute()
        || request
            .output
            .to_str()
            .is_none_or(|p| p.len() > 4096 || p.chars().any(char::is_control))
        || request.output.file_name().is_none()
        || request
            .output
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        || std::fs::symlink_metadata(&request.output).is_ok()
    {
        return Err("npm output must be a new absolute directory".into());
    }
    let parent = request
        .output
        .parent()
        .ok_or("npm output parent absent")?
        .to_owned();
    let parent_fd = crate::repository::open_parent(&parent)?;
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    check(&cancel, deadline)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "npm HTTP configuration failed")?;
    let metadata = download(
        &client,
        &request.source.metadata_url()?,
        2 * 1024 * 1024,
        &cancel,
        deadline,
        credential.as_ref(),
    )
    .await?;
    let value: serde_json::Value =
        serde_json::from_slice(&metadata).map_err(|_| "invalid npm version metadata")?;
    if value["name"] != request.source.package || value["version"] != request.source.version {
        return Err("npm metadata differs from requested package/version".into());
    }
    let tarball = value["dist"]["tarball"]
        .as_str()
        .ok_or("npm tarball URL missing")?
        .to_owned();
    request.source.validate_tarball(&tarball)?;
    if let Some(credential) = &credential {
        credential.validate_tarball(&tarball)?;
    }
    let integrity = value["dist"]["integrity"]
        .as_str()
        .ok_or("npm SHA-512 integrity missing")?
        .to_owned();
    let expected = NpmReceipt::integrity_bytes(&integrity)?;
    let compressed = download(
        &client,
        &tarball,
        32 * 1024 * 1024,
        &cancel,
        deadline,
        credential.as_ref(),
    )
    .await?;
    let token = cancel.clone();
    // The blocking task owns extraction, publication and cleanup until it returns.
    // Public future drop only cancels the supervisor; it never abandons this work.
    tokio::task::spawn_blocking(move || {
        check(&token, deadline)?;
        let mut sha512 = Sha512::new();
        let mut sha256 = Sha256::new();
        for chunk in compressed.chunks(65536) {
            check(&token, deadline)?;
            sha512.update(chunk);
            sha256.update(chunk);
        }
        if sha512.finalize().as_slice() != expected {
            return Err("npm tarball integrity mismatch".into());
        }
        let tarball_sha256 = format!("sha256:{:x}", sha256.finalize());
        crate::repository::parent_unchanged(&parent, &parent_fd)?;
        let output = tempfile::Builder::new()
            .prefix(".0sec-npm-")
            .tempdir_in(format!(
                "/proc/self/fd/{}",
                std::os::fd::AsRawFd::as_raw_fd(&parent_fd)
            ))
            .map_err(|e| e.to_string())?;
        let guarded = || {
            check(&token, deadline)?;
            crate::repository::parent_unchanged(&parent, &parent_fd)
        };
        let mut published = false;
        let result = (|| {
            let (mut snapshot, executable_paths) =
                extract::source(&compressed, output.path(), request.limits, &guarded).map_err(
                    |error| {
                        if credential.is_some() {
                            "authenticated npm archive extraction failed".to_owned()
                        } else {
                            error
                        }
                    },
                )?;
            snapshot.root = request
                .output
                .join("source")
                .to_str()
                .ok_or("npm output UTF-8")?
                .into();
            let receipt = NpmReceipt {
                schema_version: 1,
                source: request.source,
                metadata_sha256: format!("sha256:{:x}", Sha256::digest(&metadata)),
                tarball_url: tarball,
                integrity,
                tarball_sha256,
                tarball_bytes: compressed.len() as u64,
                snapshot,
                executable_paths,
            };
            if let Some(credential) = &credential {
                credential.validate_receipt_paths(&receipt)?;
            }
            let package_path = output.path().join("source/package.json");
            if std::fs::metadata(&package_path)
                .map_err(|_| "npm archive package.json missing")?
                .len()
                > 2 * 1024 * 1024
            {
                return Err("npm package.json byte limit".into());
            }
            let package =
                std::fs::read(&package_path).map_err(|_| "npm archive package.json missing")?;
            if package.len() > 2 * 1024 * 1024 {
                return Err("npm package.json byte limit".into());
            }
            let package: serde_json::Value =
                serde_json::from_slice(&package).map_err(|_| "invalid archive package.json")?;
            if package["name"] != receipt.source.package
                || package["version"] != receipt.source.version
            {
                return Err("npm archive package identity differs".into());
            }
            let bytes = receipt.canonical_bytes()?;
            if bytes.len() > zero_protocol::source_acquisition::MAX_RECEIPT_BYTES {
                return Err("npm receipt byte limit".into());
            }
            std::fs::write(output.path().join("receipt.json"), bytes).map_err(|e| e.to_string())?;
            std::fs::File::open(output.path().join("receipt.json"))
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            std::fs::File::open(output.path())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            guarded()?;
            nix::fcntl::renameat2(
                &parent_fd,
                output.path().file_name().ok_or("npm staging name absent")?,
                &parent_fd,
                request.output.file_name().ok_or("npm output name absent")?,
                nix::fcntl::RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|e| e.to_string())?;
            published = true;
            parent_fd.sync_all().map_err(|e| e.to_string())?;
            crate::repository::parent_unchanged(&parent, &parent_fd)?;
            Ok(receipt)
        })();
        if published {
            let _ = output.keep();
        } else {
            let recovery = std::fs::canonicalize(output.path())
                .unwrap_or_else(|_| parent.join(output.path().file_name().unwrap_or_default()));
            if let Err(cleanup) = output.close() {
                return Err(format!(
                    "npm staging cleanup unconfirmed at {}: {cleanup}",
                    recovery.display()
                ));
            }
        }
        result
    })
    .await
    .map_err(|_| "npm extraction supervisor failed".to_owned())?
}
