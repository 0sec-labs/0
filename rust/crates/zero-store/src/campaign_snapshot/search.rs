use super::capture::{raw_identity, strings};
use super::*;
use rusqlite::{Connection, types::Value};

pub(super) fn add_sessions(
    conn: &Connection,
    campaign: &str,
    journal: &str,
    sessions: &mut BTreeSet<String>,
) -> Result<()> {
    let parameter = [Value::Text(campaign.into())];
    let projection = strings(
        conn,
        &format!(
            "SELECT {} FROM strategy_search_proposals WHERE campaign_id=?1 LIMIT 17",
            raw_identity("session_id")
        ),
        &parameter,
        16,
    )?;
    let witnesses = strings(
        conn,
        "SELECT CASE WHEN json_valid(payload) AND length(CAST(json_extract(payload,'$.session_id') AS BLOB))<=256 THEN json_extract(payload,'$.session_id') END FROM events WHERE session_id=?1 AND kind='strategy_search_proposal_admitted' LIMIT 17",
        &[Value::Text(journal.into())],
        16,
    )?;
    let bindings = strings(
        conn,
        &format!(
            "SELECT {} FROM events WHERE kind='strategy_search_proposal_bound' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.campaign_id') END=?1 LIMIT 17",
            raw_identity("session_id")
        ),
        &parameter,
        16,
    )?;
    if projection != witnesses
        || projection != bindings
        || projection.contains(journal)
        || projection.iter().any(|p| sessions.contains(p))
    {
        return Err(invalid(
            "proposal membership projections and witnesses differ",
        ));
    }
    sessions.extend(projection);
    Ok(())
}

/// Candidate advice is retained by pair registration, not necessarily attached
/// to an operation. Preserve it even for a losing or never-dispatched pair.
pub(super) fn artifacts(conn: &Connection, campaign: &str) -> Result<BTreeSet<String>> {
    let mut digests = BTreeSet::new();
    for (table, field, limit) in [
        ("strategy_search_evaluations", "candidate_sha256", 16),
        ("strategy_search_evaluations", "baseline_sha256", 1),
        ("strategy_search_selections", "development_matrix_sha256", 1),
    ] {
        let query = format!(
            "SELECT DISTINCT CASE WHEN json_valid(record) AND length(CAST(json_extract(record,'$.{field}') AS BLOB))=71 THEN json_extract(record,'$.{field}') END FROM {table} WHERE campaign_id=?1 LIMIT {}",
            limit + 1
        );
        for digest in strings(conn, &query, &[Value::Text(campaign.into())], limit)? {
            if !zero_protocol::is_sha256(&digest) {
                return Err(invalid("invalid search artifact digest"));
            }
            digests.insert(digest);
        }
    }
    Ok(digests)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use zero_protocol::strategy_search::*;
    fn hash(v: &Value) -> String {
        zero_web_verification::hash(v).unwrap()
    }
    fn config() -> StrategySearchConfiguration {
        let digest = hash(&json!("host"));
        let baseline = json!({"schema_version":1,"advisory_utf8":"Check public controls"});
        let limits = json!({"model_micro_usd":100,"model_calls":20,"http_requests":10,"http_request_body_bytes":1000,"http_response_decoded_bytes":1000,"experiments":2,"runs":16,"max_parallel_runs":1});
        let providers = json!({"p":{"endpoint":"http://localhost:9090/responses","wire_api":"responses","rates":{"input":1,"cached_input":1,"output":1}}});
        let policy = search_fixture_profile(
            "http://127.0.0.1:8080/",
            &serde_json::from_value(limits.clone()).unwrap(),
        )
        .unwrap();
        let authority = json!({"schema_version":1,"host":{"provider":"p","model":"m","instructions":"Host fixed","max_turns":2,"reservation_per_turn":10,"max_hypotheses":2},"provider_context":providers,"http_profile_name":"runtime","http_policy":policy,"campaign_limits":limits,"accepted_suite_sha256":[digest],"minimum_development_gain":1,"minimum_final_gain":1,"canary_required":true});
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 600000;
        serde_json::from_value(json!({"kind":"strategy_search","schema_version":1,"capture":{"registry":{"schema_version":1,"registry_id":"00000000-0000-4000-8000-000000000001","genesis_sha256":digest},"generation":digest,"epoch":1,"state_sha256":digest,"advisory_sha256":hash(&baseline),"advisory":baseline,"host_policy_sha256":digest,"authority":authority},"plan":{"schema_version":1,"objective":"Improve control checks","proposer":{"provider":"p","model":"proposer","instructions":"Propose bounded advice","reservation_micro_usd":60,"max_output_tokens":1000},"scenarios":[{"id":"positive","family":"p","lane":"development","public_task":"Inspect resource","resource_path":"/secret","control_path":"/control","marker":"PRIVATE_positive_123456","positive":true},{"id":"negative","family":"n","lane":"development","public_task":"Inspect control","resource_path":"/resource","control_path":"/control","marker":"PRIVATE_negative_123456","positive":false}],"repeats":2,"max_proposals":4,"max_candidates":3,"limits":limits,"expires_at_ms":expiry,"minimum_development_gain":1},"proposer_context":providers["p"]})).unwrap()
    }

    fn fixture() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("db")).unwrap();
        store.claim_engine_epoch("owner").unwrap();
        let cfg = config();
        let campaign = store.create_strategy_search("create", &cfg).unwrap().0;
        let request = render_search_proposal(&cfg, 0, None).unwrap();
        store
            .admit_search_proposal(&campaign.id, "owner", 0, &request, None)
            .unwrap();
        (dir, store, campaign.id)
    }
    #[test]
    fn search_capture_pins_proposal_state_before_concurrent_writer() {
        let (dir, store, id) = fixture();
        store
            .conn
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        let before = store.freeze_strategy_search(&id).unwrap();
        let writer = Connection::open(dir.path().join("db")).unwrap();
        let pinned = store
            .freeze_layout(&id, Layout::Search, || {
                writer
                    .execute("UPDATE campaigns SET last_ms=last_ms+1 WHERE id=?1", [&id])
                    .unwrap();
            })
            .unwrap();
        assert_eq!(before.digest(), pinned.digest());
        assert_ne!(
            before.digest(),
            store.freeze_strategy_search(&id).unwrap().digest()
        );
        Store::hydrate_campaign_snapshot(&pinned).unwrap();
    }
    #[test]
    fn proposal_hold_survives_portable_search_reconstruction() {
        let (dir, store, id) = fixture();
        let data = store.freeze_strategy_search(&id).unwrap();
        assert_eq!(data.manifest.schema_version, 2);
        assert_eq!(data.manifest.store_schema, 16);
        assert!(store.freeze_campaign(&id).is_err());
        drop(store);
        drop(dir);
        let restored = Store::hydrate_campaign_snapshot(&data).unwrap();
        assert_eq!(restored.search_proposals(&id).unwrap().len(), 1);
        assert_eq!(
            restored
                .campaign(&id)
                .unwrap()
                .usage
                .model_reserved_micro_usd,
            60
        );
        assert_eq!(
            restored.freeze_strategy_search(&id).unwrap().digest(),
            data.digest()
        );
    }
    #[test]
    fn rehashed_packages_cannot_omit_proposal_projection_or_paid_debit() {
        let (_dir, store, id) = fixture();
        let data = store.freeze_strategy_search(&id).unwrap();
        for omitted in ["strategy_search_proposals", "campaign_debits"] {
            let mut manifest = data.manifest.clone();
            let mut values = Vec::new();
            for table in &manifest.tables {
                let rows = if table.name == omitted {
                    vec![]
                } else {
                    table
                        .rows
                        .iter()
                        .map(|r| {
                            serde_json::from_slice::<Vec<Cell>>(&data.join(r).unwrap()).unwrap()
                        })
                        .collect()
                };
                values.push((table.name.clone(), rows));
            }
            manifest.record_count = values.iter().map(|(_, rows)| rows.len() as u32).sum();
            manifest.tables.clear();
            let artifacts = manifest
                .artifacts
                .iter()
                .map(|(digest, r)| (digest.clone(), data.join(r).unwrap()))
                .collect();
            manifest.artifacts.clear();
            let altered = CampaignSnapshotData::assemble(manifest, values, artifacts).unwrap();
            assert_ne!(altered.digest(), data.digest());
            assert!(
                Store::hydrate_campaign_snapshot(&altered).is_err(),
                "omitted {omitted}"
            );
        }
    }
}
