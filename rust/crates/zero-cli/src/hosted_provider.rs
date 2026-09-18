//! Configure an explicit hosted route without copying credentials into requests or state.
use std::{error::Error, time::Duration};
use tokio_util::sync::CancellationToken;
use zero_cloud_client::CloudClient;
use zero_engine::Engine;
use zero_provider::{Endpoint, ProviderClient};

pub async fn configure(
    engine: &Engine,
    model: &str,
    host: Option<&str>,
    token_env: &str,
    timeout_ms: u64,
) -> Result<(), Box<dyn Error>> {
    let cancel = CancellationToken::new();
    let load = async {
        let credentials = crate::hosted::credentials::resolve(host, token_env).await?;
        let catalog = CloudClient::new(
            &credentials.host,
            &credentials.token,
            Duration::from_secs(30),
            1024 * 1024,
        )?;
        let route = catalog.hosted_route(model, cancel.clone()).await?;
        let endpoint = Endpoint::responses(&route.endpoint, Some(&credentials.token))?;
        let client = ProviderClient::with_wire(
            endpoint,
            route.wire_api,
            Duration::from_millis(timeout_ms),
            16 * 1024 * 1024,
        )?
        .bind_hosted(route.provenance.clone())?;
        engine.configure_hosted_provider("hosted", client, route.rates, route.provenance)?;
        Ok::<_, Box<dyn Error>>(())
    };
    tokio::select! {
        biased;
        _ = crate::server::shutdown_signal() => {
            cancel.cancel();
            Err("Hosted provider configuration interrupted".into())
        },
        result = load => result,
    }
}
