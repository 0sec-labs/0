//! Explicit login command. No provider, engine, browser process, or implicit secret output.
use std::{
    error::Error,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use zero_cloud_client::{LoginOptions, LoginSession};

pub async fn run(
    host: Option<&str>,
    token_env: &str,
    output: Option<&Path>,
    timeout_ms: u64,
) -> Result<bool, Box<dyn Error>> {
    if token_env != "0SEC_CLOUD_TOKEN" {
        return Err(
            "Hosted login writes default cloud.env credentials; custom --token-env is unsupported"
                .into(),
        );
    }
    let host = match host {
        Some(host) => host.to_owned(),
        None => match std::env::var("0SEC_CLOUD_HOST") {
            Ok(host) => host,
            Err(std::env::VarError::NotPresent) => "https://cloud.0.security".into(),
            Err(_) => return Err("Hosted login host environment is not UTF-8".into()),
        },
    };
    let (path, create_parent) = match output {
        Some(path) => (path.to_owned(), false),
        None => {
            let home = std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .ok_or("Hosted credential home is unavailable")?;
            (PathBuf::from(home).join(".0sec/cloud.env"), true)
        }
    };
    if !path.is_absolute()
        || path.to_str().is_none()
        || path.file_name().is_none()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err("Hosted credential destination must be a normal absolute file path".into());
    }
    #[cfg(not(unix))]
    return Err("Hosted login persistence requires Unix permission support".into());
    let session = LoginSession::new(
        &host,
        LoginOptions {
            deadline: Duration::from_millis(timeout_ms),
            ..LoginOptions::default()
        },
    )?;
    // Unix signal streams must exist before displaying a URL or beginning polling.
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let signal = async move {
        tokio::select! {_=interrupt.recv()=>{},_=terminate.recv()=>{}}
    };
    #[cfg(not(unix))]
    let signal = crate::server::shutdown_signal();
    tokio::pin!(signal);
    let cancel = CancellationToken::new();
    let line = format!(
        "Open this URL to sign in to 0sec Cloud:\n{}\n",
        session.browser_url()
    );
    tokio::select! {biased;
        _=&mut signal=>return Err("Hosted login cancelled before polling".into()),
        result=tokio::time::timeout(Duration::from_secs(1),async{
            let mut stderr=tokio::io::stderr();stderr.write_all(line.as_bytes()).await?;stderr.flush().await
        })=>result.map_err(|_|"Hosted login URL output deadline exceeded")??,
    }
    let waiting = session.wait(cancel.clone());
    tokio::pin!(waiting);
    let credential = tokio::select! {biased;
        _=&mut signal=>{cancel.cancel();let _=waiting.await;return Err("Hosted login cancelled; credentials unchanged".into());},
        result=&mut waiting=>result?,
    };
    let environment_override = std::env::var("0SEC_CLOUD_TOKEN")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    let saved_host = credential.host().to_owned();
    let destination = path.clone();
    // Once atomic publication begins, await it even if interrupted; never detach a secret writer.
    let mut writer = tokio::task::spawn_blocking(move || {
        persist(
            &destination,
            create_parent,
            credential.host(),
            credential.expose_token(),
        )
    });
    tokio::select! {
        result=&mut writer=>result?.map_err(|e|->Box<dyn Error>{e.into()})?,
        _=&mut signal=>{
            writer.await?.map_err(|e|->Box<dyn Error>{e.into()})?;
            return Err("Hosted login interrupted after credentials were atomically saved".into());
        }
    }
    crate::write_json(&serde_json::json!({"logged_in":true,"host":saved_host,"credential_file":path,"environment_override":environment_override,"credential_precedence":if environment_override {"0SEC_CLOUD_TOKEN remains active ahead of this saved file"}else{"saved file is available when 0SEC_CLOUD_TOKEN is unset or empty"}}),false).await?;
    Ok(true)
}

#[cfg(unix)]
fn persist(path: &Path, create_parent: bool, host: &str, token: &str) -> Result<(), &'static str> {
    use nix::{
        fcntl::{OFlag, open, openat, renameat},
        sys::stat::{Mode, SFlag, fstat, mkdirat},
        unistd::{UnlinkatFlags, geteuid, unlinkat},
    };
    use std::{fs::File, io::Write, path::Component};
    if host.contains(['\r', '\n', '\0'])
        || token.contains(['\r', '\n', '\0'])
        || token.is_empty()
        || token.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("Hosted credentials cannot be encoded safely");
    }
    let parent = path
        .parent()
        .ok_or("Hosted credential parent unavailable")?;
    let name = path
        .file_name()
        .ok_or("Hosted credential file name unavailable")?;
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut dir = File::from(
        open(Path::new("/"), flags, Mode::empty())
            .map_err(|_| "Cannot open credential directory root")?,
    );
    let components = parent.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => {
                let opened = match openat(&dir, *part, flags, Mode::empty()) {
                    Ok(fd) => fd,
                    Err(nix::errno::Errno::ENOENT)
                        if create_parent && index + 1 == components.len() && *part == ".0sec" =>
                    {
                        mkdirat(&dir, *part, Mode::from_bits_truncate(0o700))
                            .map_err(|_| "Cannot create private credential directory")?;
                        openat(&dir, *part, flags, Mode::empty())
                            .map_err(|_| "Cannot open new credential directory")?
                    }
                    Err(_) => return Err("Credential directory must exist without symlinks"),
                };
                dir = File::from(opened);
            }
            _ => return Err("Credential directory path is not normal"),
        }
    }
    let stat = fstat(&dir).map_err(|_| "Credential directory metadata unavailable")?;
    if stat.st_uid != geteuid().as_raw() || stat.st_mode & 0o7777 != 0o700 {
        return Err("Credential directory must be owned by the current user with permissions 0700");
    }
    match openat(
        &dir,
        name,
        OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
        Mode::empty(),
    ) {
        Ok(file) => {
            let stat = fstat(file).map_err(|_| "Credential file metadata unavailable")?;
            if SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT != SFlag::S_IFREG
                || stat.st_uid != geteuid().as_raw()
                || stat.st_mode & 0o7777 != 0o600
            {
                return Err("Existing credential file must be owned, regular, and mode 0600");
            }
        }
        Err(nix::errno::Errno::ENOENT) => {}
        Err(_) => return Err("Existing credential file must not be a symlink or inaccessible"),
    }
    let temporary = format!(".cloud-login-{}.tmp", uuid::Uuid::new_v4());
    let fd = openat(
        &dir,
        temporary.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )
    .map_err(|_| "Cannot create private credential temporary file")?;
    let result = (|| {
        let mut file = File::from(fd);
        // Restrictive umasks must not leave an unreadable successful credential file.
        nix::sys::stat::fchmod(&file, Mode::from_bits_truncate(0o600))
            .map_err(|_| "Cannot set private credential permissions")?;
        write!(file, "0SEC_CLOUD_HOST={host}\n0SEC_CLOUD_TOKEN={token}\n")
            .map_err(|_| "Cannot write credential temporary file")?;
        file.sync_all()
            .map_err(|_| "Cannot sync credential temporary file")?;
        renameat(&dir, temporary.as_str(), &dir, name)
            .map_err(|_| "Cannot publish credential file")?;
        dir.sync_all()
            .map_err(|_| "Credentials saved, but directory synchronization failed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = unlinkat(&dir, temporary.as_str(), UnlinkatFlags::NoRemoveDir);
    }
    result
}
#[cfg(not(unix))]
fn persist(
    _path: &Path,
    _create_parent: bool,
    _host: &str,
    _token: &str,
) -> Result<(), &'static str> {
    Err("Hosted login persistence requires Unix permission support")
}
