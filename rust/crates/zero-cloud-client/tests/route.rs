#![allow(clippy::unwrap_used)]
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use zero_cloud_client::{
    CloudClient, CloudError, HostedRoute, InferenceModelsResponse, validate_hosted_pin,
};
use zero_protocol::model::{HostedCatalogPin, WireApi};
const SECRET: &str = "route-secret-never-retain";
fn client(host: &str) -> CloudClient {
    CloudClient::new(host, SECRET, Duration::from_secs(1), 65536).unwrap()
}
fn model() -> Value {
    json!({"id":"hosted","object":"model","owned_by":"cloud","provider":"fixture-provider","upstream_model":"upstream/private","wire_api":"responses","context_length":32768,"max_output_tokens":8192,"pricing":{"input_per_million_usd":1.25,"cached_input_per_million_usd":0.125,"output_per_million_usd":2.5}})
}
fn catalog(rows: Vec<Value>) -> InferenceModelsResponse {
    serde_json::from_value(json!({"object":"list","data":rows})).unwrap()
}
fn selected(host: &str, row: Value) -> HostedRoute {
    client(host)
        .select_hosted_route(&catalog(vec![row]), "hosted")
        .unwrap()
}

#[test]
fn exact_same_origin_routes_keep_host_prefix_and_explicit_model() {
    for (wire, suffix, expected) in [
        ("responses", "responses", WireApi::Responses),
        (
            "chat_completions",
            "chat/completions",
            WireApi::ChatCompletions,
        ),
    ] {
        let mut row = model();
        row["wire_api"] = json!(wire);
        let route = selected("https://CLOUD.example:443/tenant/v2/", row.clone());
        assert_eq!(
            route.endpoint,
            format!("https://cloud.example/tenant/v2/api/inference/v1/{suffix}")
        );
        assert_eq!(route.model, "hosted");
        assert_eq!(route.wire_api, expected);
        assert_eq!(route.max_output_tokens, 8192);
        assert_eq!(
            (
                route.rates.input,
                route.rates.cached_input,
                route.rates.output
            ),
            (1_250_000, 125_000, 2_500_000)
        );
        assert_eq!(
            route.provenance.catalog_model["upstream_model"],
            "upstream/private"
        );
        assert_eq!(route.provenance.host, "https://cloud.example/tenant/v2");
        validate_hosted_pin(&route.provenance).unwrap();
        assert!(!serde_json::to_string(&route).unwrap().contains(SECRET));
        assert_eq!(
            client("https://cloud.example")
                .select_hosted_route(&catalog(vec![row]), "upstream/private")
                .unwrap_err(),
            CloudError::ModelUnavailable
        );
    }
    let ipv6 = selected("http://[::1]:1234/prefix", model());
    assert_eq!(
        ipv6.endpoint,
        "http://[::1]:1234/prefix/api/inference/v1/responses"
    );
}
#[test]
fn normalized_quote_identity_is_deterministic_and_changes_with_host_or_price() {
    let original = selected("https://cloud.example/prefix", model());
    let mut equivalent = model();
    equivalent["pricing"]["input_per_million_usd"] = serde_json::from_str("1250000e-6").unwrap();
    let same = selected("https://CLOUD.example:443/prefix/", equivalent);
    assert_eq!(
        serde_json::to_value(&original.provenance).unwrap(),
        serde_json::to_value(&same.provenance).unwrap()
    );
    let changed_host = selected("https://other.example/prefix", model());
    assert_ne!(
        serde_json::to_value(&original.provenance).unwrap(),
        serde_json::to_value(&changed_host.provenance).unwrap()
    );
    let mut expensive = model();
    expensive["pricing"]["input_per_million_usd"] = json!(1.250001);
    let expensive = selected("https://cloud.example/prefix", expensive);
    assert_ne!(
        original.provenance.catalog_model_sha256,
        expensive.provenance.catalog_model_sha256
    );
    let mut other = model();
    other["id"] = json!("another");
    let catalog = catalog(vec![other, model()]);
    assert_eq!(
        serde_json::to_value(original.provenance).unwrap(),
        serde_json::to_value(
            client("https://cloud.example/prefix")
                .select_hosted_route(&catalog, "hosted")
                .unwrap()
                .provenance
        )
        .unwrap()
    );
}
#[test]
fn entire_catalog_is_validated_before_explicit_selection() {
    let c = client("https://cloud.example");
    for (path, bad) in [
        ("/id", json!("hosted")),
        ("/owned_by", json!("bad\nowner")),
        ("/context_length", json!(0)),
        ("/max_output_tokens", json!(4294967296u64)),
        ("/pricing/input_per_million_usd", json!(-1)),
        (
            "/pricing/cached_input_per_million_usd",
            serde_json::from_str("0.0000001").unwrap(),
        ),
    ] {
        let mut unselected = model();
        unselected["id"] = json!("other");
        *unselected.pointer_mut(path).unwrap() = bad;
        assert_eq!(
            c.select_hosted_route(&catalog(vec![model(), unselected]), "hosted")
                .unwrap_err(),
            CloudError::InvalidResponse,
            "{path}"
        );
    }
    let mut overflow = catalog(vec![model(), model()]);
    overflow.data[1].id = "other".into();
    overflow.data[1].pricing.output_per_million_usd =
        zero_cloud_client::ExactPrice::from_decimal("18446744073709.551616").unwrap();
    assert_eq!(
        c.select_hosted_route(&overflow, "hosted").unwrap_err(),
        CloudError::InvalidResponse
    );
    let mut rows = Vec::new();
    for i in 0..1025 {
        let mut row = model();
        row["id"] = json!(format!("m{i}"));
        rows.push(row);
    }
    assert_eq!(
        c.select_hosted_route(&catalog(rows), "m0").unwrap_err(),
        CloudError::InvalidResponse
    );
    assert_eq!(
        c.select_hosted_route(&catalog(vec![]), "hosted")
            .unwrap_err(),
        CloudError::ModelUnavailable
    );
}
#[test]
fn portable_pin_rederives_every_field_without_network() {
    let original =
        serde_json::to_value(selected("https://cloud.example/prefix", model()).provenance).unwrap();
    for (path, bad) in [
        ("/schema_version", json!(2)),
        ("/host", json!("https://other.example")),
        ("/endpoint", json!("https://elsewhere.example/responses")),
        ("/model", json!("upstream/private")),
        ("/wire_api", json!("chat_completions")),
        ("/max_output_tokens", json!(9000)),
        ("/rates/input", json!(1)),
        ("/rates/cached_input", json!(1)),
        ("/rates/output", json!(1)),
        (
            "/catalog_model_sha256",
            json!(format!("sha256:{}", "0".repeat(64))),
        ),
        ("/catalog_model/owned_by", json!("changed-owner")),
    ] {
        let mut bad_pin = original.clone();
        *bad_pin.pointer_mut(path).unwrap() = bad;
        let pin: HostedCatalogPin = serde_json::from_value(bad_pin).unwrap();
        assert!(
            validate_hosted_pin(&pin).is_err(),
            "accepted mutation {path}"
        );
    }
    let mut bad = original;
    bad["catalog_model"]["unknown_authority"] = json!(true);
    assert!(validate_hosted_pin(&serde_json::from_value(bad).unwrap()).is_err());
}
async fn response(
    status: u16,
    headers: &str,
    body: String,
) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}/prefix", listener.local_addr().unwrap());
    let headers = headers.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut b = [0; 2048];
            let n = socket.read(&mut b).await.unwrap();
            assert_ne!(n, 0);
            request.extend_from_slice(&b[..n]);
            if request.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{headers}\r\n{body}",body.len()).as_bytes()).await.unwrap();
        drop(socket);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "unexpected second catalog or inference request"
        );
        String::from_utf8(request).unwrap()
    });
    (host, task)
}
#[tokio::test]
async fn hosted_route_fetches_one_catalog_and_preserves_exact_decimal_lexemes() {
    let (host, server) = response(200, "", raw_catalog_price("18446744073709.551615")).await;
    let route = client(&host)
        .hosted_route("hosted", CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(route.rates.input, u64::MAX);
    assert_eq!(route.endpoint, format!("{host}/api/inference/v1/responses"));
    let request = server.await.unwrap();
    assert!(request.starts_with("GET /prefix/api/inference/v1/models HTTP/1.1"));
    assert!(request.contains(&format!("authorization: Bearer {SECRET}")));
    assert!(
        !serde_json::to_string(&route.provenance)
            .unwrap()
            .contains(SECRET)
    );
    let (host, server) = response(200, "", raw_catalog_price("1.00000000000000001")).await;
    assert_eq!(
        client(&host)
            .hosted_route("hosted", CancellationToken::new())
            .await
            .unwrap_err(),
        CloudError::InvalidResponse
    );
    server.await.unwrap();
}
#[tokio::test]
async fn cancelled_selection_and_redirects_never_dispatch_catalog_elsewhere() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert_eq!(
        client(&host)
            .hosted_route("hosted", cancelled)
            .await
            .unwrap_err(),
        CloudError::Cancelled
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    let (host, server) =
        response(307, &format!("Location: {host}/elsewhere\r\n"), "{}".into()).await;
    assert!(matches!(
        client(&host)
            .hosted_route("hosted", CancellationToken::new())
            .await,
        Err(CloudError::Http { status: 307, .. })
    ));
    server.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

fn raw_catalog_price(raw: &str) -> String {
    let mut row = model();
    row["pricing"]["input_per_million_usd"] = json!("EXACT_PRICE");
    json!({"object":"list","data":[row]})
        .to_string()
        .replace("\"EXACT_PRICE\"", raw)
}
#[test]
fn exact_price_pin_survives_ordinary_value_and_json_journal_roundtrips() {
    let catalog: InferenceModelsResponse =
        serde_json::from_str(&raw_catalog_price("18446744073709.551615")).unwrap();
    assert_eq!(
        catalog.data[0].pricing.input_per_million_usd.as_decimal(),
        "18446744073709.551615"
    );
    assert!(
        serde_json::to_string(&catalog)
            .unwrap()
            .contains("18446744073709.551615")
    );
    let route = client("https://cloud.example")
        .select_hosted_route(&catalog, "hosted")
        .unwrap();
    assert_eq!(
        route.provenance.catalog_model["pricing"]["input_per_million_usd"],
        "18446744073709.551615"
    );
    let value = serde_json::to_value(&route.provenance).unwrap();
    let restored: HostedCatalogPin = serde_json::from_value(value.clone()).unwrap();
    validate_hosted_pin(&restored).unwrap();
    assert_eq!(restored.rates.input, u64::MAX);
    let bytes = serde_json::to_vec(&value).unwrap();
    let restored: HostedCatalogPin = serde_json::from_slice(&bytes).unwrap();
    validate_hosted_pin(&restored).unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap(), value);
}
#[test]
fn local_raw_prices_do_not_change_buffered_execution_cpu_decoding() {
    let value = json!({"execution_id":"fixture","image":"local:fixture","snapshot":{"id":"pin","root":"/snapshot","digest":format!("sha256:{}","0".repeat(64)),"files":[]},"argv":["true"],"build_argv":null,"stdin":null,"timeout_ms":1000,"memory_mb":128,"cpus":0.5,"max_output_bytes":1024});
    let execution: zero_protocol::agent::AgentExecution = serde_json::from_value(value).unwrap();
    assert_eq!(execution.sandbox_request().cpus, 0.5);
}
