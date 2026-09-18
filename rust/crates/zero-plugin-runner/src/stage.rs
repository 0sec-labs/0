use crate::*;
use std::{collections::BTreeMap, fs};
use zero_plugin::Capability;
pub(super) struct Prepared {
    plugins: BTreeMap<String, String>,
    argv: Vec<String>,
}
pub(super) fn prepare(
    harness: &Harness,
    call: &PinnedCall,
    plugin: &str,
    launch: &Launch,
) -> Result<Prepared, Error> {
    harness
        .validate_reply(call, &call.pin())
        .map_err(|_| Error::Rejected("stale invocation"))?;
    launch.validate()?;
    let selected = call
        .graph()
        .plugin_manifest(plugin)
        .ok_or(Error::Rejected("plugin not pinned"))?;
    if selected.digest()? != call.invocation().manifest_digest {
        return Err(Error::Rejected("selected plugin identity mismatch"));
    }
    let mut plugins = call.invocation().dependency_pins.clone();
    plugins.insert(plugin.into(), call.invocation().manifest_digest.clone());
    for (id, digest) in &plugins {
        let manifest = call
            .graph()
            .plugin_manifest(id)
            .ok_or(Error::Rejected("dependency not prepared"))?;
        if manifest.digest()? != *digest {
            return Err(Error::Rejected("dependency identity mismatch"));
        }
        if manifest.capabilities().iter().any(|c| {
            !matches!(
                c,
                Capability::Compute
                    | Capability::ProcessExec
                    | Capability::FilesystemRead
                    | Capability::FilesystemWrite
            )
        }) {
            return Err(Error::Rejected(
                "only offline disposable-snapshot capabilities supported",
            ));
        }
        for dependency in &manifest.dependencies {
            let target = call
                .graph()
                .plugin_manifest(&dependency.id)
                .ok_or(Error::Rejected("missing dependency"))?;
            if target.version != dependency.version
                || plugins.get(&dependency.id) != Some(&target.digest()?)
            {
                return Err(Error::Rejected("unbound dependency"));
            }
        }
    }
    if selected.entrypoint.argv.first().map(String::as_str) != Some("{artifact}") {
        return Err(Error::Rejected(
            "entrypoint argv must begin with literal {artifact}",
        ));
    }
    let mut argv = launch.interpreter.clone();
    argv.push(format!(
        "./plugins/{}/artifacts/{}",
        selected.digest()?,
        selected.entrypoint.artifact
    ));
    argv.extend(selected.entrypoint.argv.iter().skip(1).cloned());
    Ok(Prepared { plugins, argv })
}
pub(super) fn write(
    call: &PinnedCall,
    prepared: Prepared,
    launch: Launch,
    directory: &Path,
) -> Result<SandboxRequest, Error> {
    for (id, digest) in &prepared.plugins {
        let manifest = call
            .graph()
            .plugin_manifest(id)
            .ok_or(Error::Rejected("plugin disappeared"))?;
        let root = directory.join("plugins").join(digest);
        fs::create_dir_all(root.join("artifacts"))?;
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(manifest).map_err(|_| Error::Rejected("manifest encoding"))?,
        )?;
        for artifact in &manifest.artifacts {
            let bytes = call
                .graph()
                .artifact(id, &artifact.sha256)
                .ok_or(Error::Rejected("artifact disappeared"))?;
            if zero_plugin::sha256(bytes) != artifact.sha256 || bytes.len() as u64 != artifact.size
            {
                return Err(Error::Rejected("artifact identity mismatch"));
            }
            fs::write(root.join("artifacts").join(&artifact.sha256), bytes)?;
        }
    }
    fs::write(
        directory.join("plugins.json"),
        serde_json::to_vec(&prepared.plugins)
            .map_err(|_| Error::Rejected("dependency encoding"))?,
    )?;
    let request = SandboxRequest {
        execution_id: format!("plugin-{}", call.lease().id),
        backend: launch.backend,
        snapshot: zero_executor::pin_snapshot(directory).map_err(Error::Snapshot)?,
        argv: prepared.argv,
        build_argv: None,
        stdin: Some(input(call)?),
        timeout_ms: launch.timeout_ms,
        memory_mb: launch.memory_mb,
        cpus: launch.cpus,
        max_output_bytes: launch.max_output_bytes,
    };
    request
        .validate()
        .map_err(|e| Error::Snapshot(e.to_string()))?;
    Ok(request)
}
