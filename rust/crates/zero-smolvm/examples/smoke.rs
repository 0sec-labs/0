//! Explicit local archive smoke. No image provisioning or group changes.
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};
use tokio_util::sync::CancellationToken;
use zero_smolvm::{SmolvmConfig, SmolvmRequest, SmolvmStatus, VmCleanup, execute};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let archive = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: smoke <prepared-node-archive>")?,
    );
    let mut file = std::fs::File::open(&archive)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    let digest = format!("sha256:{:x}", hash.finalize());
    let r=SmolvmRequest{execution_id:"native-smolvm-smoke".into(),image_archive:archive,archive_digest:digest,argv:vec!["node".into(),"-e".into(),"const fs=require('fs'); console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),input:fs.readFileSync(0,'utf8'),secret:!!process.env.OPENAI_API_KEY,docker:fs.existsSync('/var/run/docker.sock')}))".into()],stdin:b"native smoke".to_vec(),mounts:vec![],timeout_ms:120000,memory_mb:2048,cpus:2,storage_gb:4,max_output_bytes:4096};
    let result = execute(r, SmolvmConfig::default(), CancellationToken::new()).await;
    println!("{}", serde_json::to_string(&result)?);
    if result.status != SmolvmStatus::Exited
        || result.exit_code != Some(0)
        || result.cleanup != VmCleanup::Confirmed
    {
        return Err("native smolvm smoke execution failed".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&result.stdout)?;
    if value["uid"] != 1000
        || value["gid"] != 1000
        || value["input"] != "native smoke"
        || value["secret"] != false
        || value["docker"] != false
    {
        return Err("native smolvm smoke guest assertions failed".into());
    }
    Ok(())
}
