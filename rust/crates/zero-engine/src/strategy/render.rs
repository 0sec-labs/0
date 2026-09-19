use super::*;
pub(super) fn request(
    plan: &StrategyPlan,
    artifact: &StrategyArtifact,
    scenario: &StrategyScenario,
    profile: &str,
) -> Result<AgentRequest, EngineError> {
    plan.validate().map_err(error)?;
    artifact.validate().map_err(error)?;
    zero_protocol::strategy_registry::render_strategy_request(
        &plan.host,
        artifact,
        &scenario.public_task,
        profile,
        None,
    )
    .map_err(error)
}

pub(super) fn profile(
    origin: &str,
    limits: &CampaignLimits,
) -> Result<zero_protocol::http::HttpProfilePolicy, EngineError> {
    let p = serde_json::from_value(
        json!({"schema_version":1,"base_url":origin,"in_scope":["127.0.0.1"],"out_of_scope":[],"denied_hosts":[],"allowed_path_prefixes":[],"denied_path_prefixes":[],"allowed_methods":["GET","POST"],"allowed_headers":["content-type"],"redirect":{"mode":"manual"},"limits":{"timeout_ms":3000,"max_request_body_bytes":16384,"max_response_wire_bytes":65536,"max_response_decoded_bytes":32768,"max_request_header_bytes":16384,"max_request_headers":32,"max_response_header_bytes":16384,"max_response_headers":32,"max_dns_answers":8,"max_dns_cname_depth":4,"max_dns_queries":4},"rate":{"default":{"requests_per_interval":100,"interval_ms":1000,"burst":32},"per_host":{},"jitter_ms":0},"budget":{"max_requests":limits.http_requests.min(128),"max_request_body_bytes":limits.http_request_body_bytes.min(1048576),"max_response_decoded_bytes":limits.http_response_decoded_bytes.min(4194304)}}),
    )?;
    zero_http::normalize_policy(p).map_err(error)
}
#[derive(Clone)]
pub(super) struct Entry {
    pub index: u32,
    pub scenario: usize,
    pub repeat: u32,
    pub variant: CampaignVariant,
}
pub(super) fn schedule(plan: &StrategyPlan) -> Vec<Entry> {
    schedule_cases(&plan.scenarios, plan.repeats)
}
pub(super) fn schedule_cases(scenarios: &[StrategyScenario], repeats: u32) -> Vec<Entry> {
    let mut entries = vec![];
    // Complete development before any protected input exposure.
    for lane in [
        CampaignLane::Development,
        CampaignLane::Final,
        CampaignLane::Canary,
    ] {
        for repeat in 0..repeats {
            for (scenario, c) in scenarios.iter().enumerate().filter(|(_, c)| c.lane == lane) {
                let order = if repeat % 2 == 0 {
                    [CampaignVariant::Baseline, CampaignVariant::Candidate]
                } else {
                    [CampaignVariant::Candidate, CampaignVariant::Baseline]
                };
                for variant in order {
                    entries.push(Entry {
                        index: entries.len() as u32,
                        scenario,
                        repeat,
                        variant,
                    });
                }
                let _ = c;
            }
        }
    }
    entries
}

/// Validate the actual compiled public templates, including native tool descriptions.
/// The private scorer's bytes must not be disclosed by renderer constants or development data.
pub(super) fn validate_public_inputs(plan: &StrategyPlan) -> Result<(), EngineError> {
    validate_templates(
        &plan.host,
        &[&plan.baseline, &plan.candidate],
        &plan.scenarios,
    )?;
    for protected in plan
        .scenarios
        .iter()
        .filter(|s| s.lane == CampaignLane::Final)
    {
        for development in plan
            .scenarios
            .iter()
            .filter(|s| s.lane == CampaignLane::Development)
        {
            for path in [
                "/",
                development.resource_path.as_str(),
                development.control_path.as_str(),
                "/unknown",
            ] {
                if oracle::response(development, path)
                    .1
                    .windows(protected.marker.len())
                    .any(|v| v == protected.marker.as_bytes())
                {
                    return Err(error(
                        "protected fixture marker appears in development response",
                    ));
                }
            }
        }
    }
    Ok(())
}
pub(super) fn has_marker(value: &Value, marker: &str) -> bool {
    match value {
        Value::String(s) => s.contains(marker),
        Value::Array(v) => v.iter().any(|v| has_marker(v, marker)),
        Value::Object(v) => v
            .iter()
            .any(|(k, v)| k.contains(marker) || has_marker(v, marker)),
        _ => false,
    }
}
pub(super) fn validate_templates(
    host: &StrategyHost,
    artifacts: &[&StrategyArtifact],
    scenarios: &[StrategyScenario],
) -> Result<(), EngineError> {
    for scenario in scenarios {
        for artifact in artifacts {
            if scenarios
                .iter()
                .any(|s| artifact.advisory_utf8.contains(&s.marker))
            {
                return Err(error("private fixture marker appears in advisory"));
            }
            let root = zero_protocol::strategy_registry::render_strategy_request(
                host,
                artifact,
                &scenario.public_task,
                "strategy_fixture",
                None,
            )
            .map_err(error)?;
            let mut models = vec![agent::validate_initial(&root)?];
            if let Some(policy) = &root.delegation_policy {
                for role in &policy.roles {
                    models.push(agent::validate_initial(&agent_delegation::child_request(
                        &root,
                        role,
                        &scenario.public_task,
                    ))?);
                }
            }
            for model in models {
                let value = serde_json::to_value(model)?;
                if scenarios.iter().any(|s| has_marker(&value, &s.marker)) {
                    return Err(error(
                        "private fixture marker appears in compiled public model template",
                    ));
                }
            }
        }
    }
    Ok(())
}
