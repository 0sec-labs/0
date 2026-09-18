//! Inert presentation of validated journal exports; rendering is not an oracle.
use crate::{
    Error, MAX_REPORT_BYTES, Result, bounded_pretty,
    html::Html,
    markdown::{Lines, escape},
};
use std::collections::{BTreeMap, BTreeSet};
use zero_protocol::{OperationStatus, is_sha256, web::*};
#[derive(Debug, Clone, Copy)]
pub enum WebReportFormat {
    Json,
    Markdown,
    Html,
}
const NOTICE: &str = "Web hypotheses remain unverified. Security conclusion: not established. HTTP responses and operator acceptance are not vulnerability proof. Linked assessments apply only to their frozen plan under the same static identity and existing target state; no target reset or cross-principal test is claimed.";
pub fn render_web_report(report: &WebWorkflowReport, format: WebReportFormat) -> Result<String> {
    validate(report)?;
    if matches!(format, WebReportFormat::Json) {
        return bounded_pretty(
            &serde_json::to_value(report).map_err(|_| Error::Json)?,
            4 * MAX_REPORT_BYTES,
        );
    }
    let sections = sections(report)?;
    match format {
        WebReportFormat::Markdown => {
            let mut out = Lines(String::new());
            out.line("# 0sec Web Observation Report")?;
            out.line("")?;
            out.line(NOTICE)?;
            for (title, fields) in sections {
                out.line("")?;
                out.line(&format!("## {}", inert(&title)))?;
                out.line("")?;
                for (name, value) in fields {
                    out.line(&format!("- **{}:** {}", inert(&name), inert(&value)))?;
                }
            }
            Ok(out.0)
        }
        WebReportFormat::Html => {
            let mut out = Html(String::new());
            out.raw("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>0sec Web Observation Report</title><style>")?;
            out.raw(include_str!("report.css"))?;
            out.raw("</style></head><body><h1>0sec Web Observation Report</h1>")?;
            out.field("<p>", NOTICE, "</p>")?;
            for (title, fields) in sections {
                out.field("<section><h2>", &title, "</h2><dl>")?;
                for (name, value) in fields {
                    out.field("<dt>", &name, "</dt>")?;
                    out.field("<dd>", &value, "</dd>")?;
                }
                out.raw("</dl></section>")?;
            }
            out.raw("</body></html>")?;
            Ok(out.0)
        }
        WebReportFormat::Json => unreachable!(),
    }
}
fn inert(value: &str) -> String {
    escape(value).replace(':', "\\:")
}
fn text(value: &str, max: usize) -> Result<()> {
    if value.is_empty() || value.len() > max {
        Err(Error::Field("web text bound"))
    } else {
        Ok(())
    }
}
fn digest(value: &str) -> Result<()> {
    if is_sha256(value) {
        Ok(())
    } else {
        Err(Error::Field("web digest"))
    }
}
fn artifacts(values: &BTreeMap<String, String>) -> Result<()> {
    if values.len() > 256 {
        return Err(Error::Limit);
    }
    for (name, hash) in values {
        text(name, 256)?;
        digest(hash)?;
    }
    Ok(())
}
fn wire(value: serde_json::Value) -> Result<String> {
    serde_json::to_string(&value).map_err(|_| Error::Json)
}
fn validate(report: &WebWorkflowReport) -> Result<()> {
    if report.schema_version != 1 {
        return Err(Error::Field("web report version"));
    }
    if serde_json::to_vec(report).map_err(|_| Error::Json)?.len() > MAX_REPORT_BYTES
        || report.observations.len() > 128
        || report
            .verifications
            .len()
            .saturating_add(report.experiments.len())
            > 32
    {
        return Err(Error::Limit);
    }
    let run = &report.run;
    text(&run.session_id, 4096)?;
    text(&run.operation_id, 4096)?;
    text(&run.command_id, 4096)?;
    text(&run.authority.profile_name, 128)?;
    digest(&run.authority.profile_sha256)?;
    digest(&run.authority.account_id)?;
    run.authority
        .profile
        .validate()
        .map_err(|_| Error::Field("HTTP policy"))?;
    artifacts(&run.artifacts)?;
    let mut hypotheses = BTreeSet::new();
    if let Some(review) = &run.review {
        if review.schema_version != 1
            || run.operation_status != OperationStatus::Succeeded
            || !matches!(
                run.agent_status,
                Some(zero_protocol::agent::AgentStatus::Completed)
            )
            || run.error.is_some()
        {
            return Err(Error::Field("web submission lifecycle"));
        }
        if review.hypotheses.len() > 32 || review.evidence.len() > 1024 {
            return Err(Error::Limit);
        }
        digest(&review.request_sha256)?;
        digest(&review.completion_sha256)?;
        text(&review.model, 512)?;
        text(&review.submission_call_id, 4096)?;
        if run.artifacts.get("web.request") != Some(&review.request_sha256)
            || run.artifacts.get("web.completion") != Some(&review.completion_sha256)
            || !run.artifacts.contains_key("web.review")
        {
            return Err(Error::Field("web submission artifacts"));
        }
        let mut evidence = BTreeMap::new();
        for e in &review.evidence {
            text(&e.operation_id, 4096)?;
            digest(&e.response_manifest_sha256)?;
            digest(&e.retained_body_sha256)?;
            if e.retained_bytes > 16 * 1024 * 1024
                || !(100..=599).contains(&e.status)
                || evidence.insert(&e.operation_id, e).is_some()
            {
                return Err(Error::Field("web evidence identity"));
            }
        }
        for h in &review.hypotheses {
            text(&h.id, 512)?;
            if !hypotheses.insert(&h.id) {
                return Err(Error::Field("duplicate web hypothesis"));
            }
            text(&h.claim.title, 1024)?;
            text(&h.claim.category, 128)?;
            text(&h.claim.explanation, 16384)?;
            text(&h.claim.claimed_impact, 16384)?;
            if h.claim.citations.is_empty() || h.claim.citations.len() > 32 {
                return Err(Error::Field("web citations"));
            }
            for c in &h.claim.citations {
                let e = evidence
                    .get(&c.operation_id)
                    .ok_or(Error::Field("citation membership"))?;
                if e.response_manifest_sha256 != c.response_manifest_sha256 {
                    return Err(Error::Field("citation manifest"));
                }
                match &c.part {
                    WebCitationPart::Status => {}
                    WebCitationPart::Header {
                        index,
                        expected_name,
                    } => {
                        if *index >= 128 || !zero_protocol::http::valid_header_name(expected_name) {
                            return Err(Error::Field("citation header"));
                        }
                    }
                    WebCitationPart::Body { offset, length } => {
                        if *length == 0
                            || *length > 65536
                            || offset
                                .checked_add(u64::from(*length))
                                .is_none_or(|n| n > e.retained_bytes)
                        {
                            return Err(Error::Field("citation body range"));
                        }
                    }
                }
            }
        }
    }
    let mut operations = BTreeSet::new();
    for observation in &report.observations {
        let op = &observation.operation;
        text(&op.operation_id, 4096)?;
        text(&op.actor_operation_id, 4096)?;
        if !operations.insert(op.operation_id.clone()) {
            return Err(Error::Field("duplicate HTTP observation"));
        }
        if let Some(e) = &observation.evidence {
            if e.session_id != run.session_id
                || e.operation_id != op.operation_id
                || e.operation_status != op.operation_status
                || op.response_manifest_sha256.as_ref() != Some(&e.response_manifest_sha256)
                || e.retained_bytes > 16 * 1024 * 1024
                || e.headers.len() > 128
                || e.headers
                    .iter()
                    .map(|(k, v)| k.len() + v.len())
                    .sum::<usize>()
                    > 65536
                || (e.complete && op.operation_status != OperationStatus::Succeeded)
            {
                return Err(Error::Field("HTTP observation correlation"));
            }
            digest(&e.response_manifest_sha256)?;
            digest(&e.retained_body_sha256)?;
            artifacts(&e.artifacts)?;
        }
    }
    let mut links = BTreeSet::new();
    for v in &report.verifications {
        let p = &v.plan;
        let a = &v.outcome.assessment;
        if !links.insert(&v.operation_id)
            || !hypotheses.contains(&p.hypothesis_id)
            || p.web_operation_id != run.operation_id
            || run.artifacts.get("web.review") != Some(&p.web_review_sha256)
            || v.operation_status == OperationStatus::Running
            || p.oracle_version != "zero-web-exact-response-v1"
            || a.vulnerability_reportable
            || a.schema_version != 1
            || p.schema_version != 1
            || p.oracle_version != a.oracle_version
            || !(2..=3).contains(&p.repeats)
            || !(2..=8).contains(&p.cases.len())
            || a.expected_attempts != p.repeats * p.cases.len() as u32
            || a.completed_attempts > a.expected_attempts
            || a.completed_attempts as usize
                != v.outcome
                    .attempts
                    .iter()
                    .filter(|t| {
                        t.complete
                            && t.operation_status == OperationStatus::Succeeded
                            && t.possible_dispatch
                    })
                    .count()
            || a.observed_attempts > a.completed_attempts
            || a.control_attempts > a.expected_attempts
            || v.outcome.attempts.len() > 24
            || v.outcome.children.len() != v.outcome.attempts.len()
        {
            return Err(Error::Field("web verification linkage"));
        }
        digest(&a.plan_sha256)?;
        digest(&v.intent_sha256)?;
        artifacts(&v.outcome.artifacts)?;
        if v.approved_intent_sha256
            .as_ref()
            .is_some_and(|d| d != &v.intent_sha256)
        {
            return Err(Error::Field("web plan approval identity"));
        }
        let mut names = BTreeSet::new();
        let mut attack = false;
        let mut control = false;
        for c in &p.cases {
            text(&c.name, 128)?;
            if !names.insert(&c.name) || !(100..=599).contains(&c.expected.status) {
                return Err(Error::Field("web oracle case"));
            }
            digest(&c.expected.body_sha256)?;
            c.request
                .validate()
                .map_err(|_| Error::Field("web oracle request"))?;
            attack |= c.role == WebCaseRole::Attack;
            control |= c.role == WebCaseRole::LegitimateControl;
        }
        if !attack || !control {
            return Err(Error::Field("web oracle controls"));
        }
        let mut matrix = BTreeSet::new();
        for (index, t) in v.outcome.attempts.iter().enumerate() {
            if !names.contains(&t.case_name)
                || t.repeat_index >= p.repeats
                || !matrix.insert((&t.case_name, t.repeat_index))
                || !operations.insert(t.operation_id.clone())
                || v.outcome.children[index] != t.operation_id
            {
                return Err(Error::Field("web oracle attempts"));
            }
            digest(&t.request_sha256)?;
            if let Some(d) = &t.response_manifest_sha256 {
                digest(d)?;
            }
            if let Some(d) = &t.body_sha256 {
                digest(d)?;
            }
            if t.complete
                && (t.operation_status != OperationStatus::Succeeded
                    || t.response_manifest_sha256.is_none()
                    || t.body_sha256.is_none()
                    || !t.status.is_some_and(|status| (100..=599).contains(&status))
                    || !t.possible_dispatch)
            {
                return Err(Error::Field("web oracle complete attempt"));
            }
        }
        if v.operation_status == OperationStatus::Succeeded
            && (!matches!(
                a.disposition,
                zero_protocol::verification::Disposition::ObservedForPlan
                    | zero_protocol::verification::Disposition::NotObserved
            ) || v.outcome.stop.is_some()
                || v.outcome.error.is_some()
                || a.completed_attempts != a.expected_attempts)
        {
            return Err(Error::Field("web oracle success"));
        }
    }
    let mut experiment_children = BTreeSet::new();
    for e in &report.experiments {
        if !links.insert(&e.operation_id)
            || e.schema_version != 1
            || e.session_id != run.session_id
            || e.web_operation_id != run.operation_id
        {
            return Err(Error::Field("experiment linkage"));
        }
        for id in [
            &e.operation_id,
            &e.actor_operation_id,
            &e.inference_operation_id,
            &e.call_id,
        ] {
            text(id, 4096)?;
        }
        e.policy
            .validate()
            .map_err(|_| Error::Field("experiment host policy"))?;
        e.proposal
            .validate()
            .map_err(|_| Error::Field("experiment model proposal"))?;
        if e.proposal.cases.len() > e.policy.max_cases as usize
            || e.proposal.repeats > e.policy.max_repeats
            || e.hypothesis.title != e.proposal.hypothesis.title
            || e.hypothesis.explanation != e.proposal.hypothesis.explanation
            || e.hypothesis.prior_revision != e.proposal.hypothesis.prior_revision
        {
            return Err(Error::Field("experiment conjecture/policy"));
        }
        if let Some(prior) = &e.hypothesis.prior_revision {
            if prior.operation_id == e.operation_id
                || report
                    .experiments
                    .iter()
                    .find(|other| other.operation_id == prior.operation_id)
                    .is_some_and(|other| {
                        other.hypothesis.hypothesis_sha256 != prior.hypothesis_sha256
                    })
            {
                return Err(Error::Field("experiment prior revision identity"));
            }
        }
        for d in [
            &e.intent_sha256,
            &e.matrix_sha256,
            &e.hypothesis.hypothesis_sha256,
        ] {
            digest(d)?;
        }
        artifacts(&e.artifacts)?;
        // Hypothesis and measured-matrix artifacts wrap data; their byte hashes are
        // distinct from the conjecture identity and frozen prediction matrix hash.
        if e.artifacts
            .get("experiment.intent")
            .is_some_and(|d| d != &e.intent_sha256)
        {
            return Err(Error::Field("experiment intent artifact identity"));
        }
        let Some(o) = &e.outcome else {
            if !matches!(
                e.operation_status,
                OperationStatus::Running | OperationStatus::Admitted
            ) {
                return Err(Error::Field("terminal experiment feedback missing"));
            }
            continue;
        };
        let a = &o.assessment;
        if matches!(
            e.operation_status,
            OperationStatus::Running | OperationStatus::Admitted
        ) || a.schema_version != 1
            || a.oracle_version != "zero-web-exact-response-v1"
            || a.plan_sha256 != e.matrix_sha256
            || a.vulnerability_reportable
            || a.expected_attempts != e.proposal.repeats * e.proposal.cases.len() as u32
            || a.completed_attempts > a.expected_attempts
            || a.observed_attempts > a.completed_attempts
            || a.control_attempts > a.expected_attempts
            || o.attempts.len() > a.expected_attempts as usize
            || o.children.len() != o.attempts.len()
            || a.completed_attempts as usize
                != o.attempts
                    .iter()
                    .filter(|t| {
                        t.complete
                            && t.possible_dispatch
                            && t.operation_status == OperationStatus::Succeeded
                    })
                    .count()
        {
            return Err(Error::Field("experiment independent measurement"));
        }
        use zero_protocol::verification::Disposition;
        let expected_status = match a.disposition {
            Disposition::ObservedForPlan | Disposition::NotObserved => OperationStatus::Succeeded,
            Disposition::Unknown => OperationStatus::Unknown,
            Disposition::Cancelled => OperationStatus::Cancelled,
            Disposition::Inconclusive => OperationStatus::Failed,
        };
        if e.operation_status != expected_status {
            return Err(Error::Field("experiment assessment lifecycle"));
        }
        let mut measured_attacks = 0;
        let mut measured_controls = 0;
        artifacts(&o.artifacts)?;
        for (i, t) in o.attempts.iter().enumerate() {
            let case = &e.proposal.cases[i % e.proposal.cases.len()];
            if t.case_name != case.name
                || t.repeat_index != i as u32 / e.proposal.cases.len() as u32
                || o.children[i] != t.operation_id
                || !experiment_children.insert(t.operation_id.clone())
                || report
                    .verifications
                    .iter()
                    .any(|v| v.outcome.children.contains(&t.operation_id))
            {
                return Err(Error::Field("experiment attempt ordering"));
            }
            if let Some(observation) = report
                .observations
                .iter()
                .find(|o| o.operation.operation_id == t.operation_id)
            {
                if observation.operation.operation_status != t.operation_status
                    || observation.operation.response_manifest_sha256 != t.response_manifest_sha256
                    || observation.evidence.as_ref().is_some_and(|e| {
                        Some(&e.retained_body_sha256) != t.body_sha256.as_ref()
                            || e.status != t.status
                            || e.complete != t.complete
                    })
                {
                    return Err(Error::Field("experiment observation correlation"));
                }
            }
            if t.complete
                && t.possible_dispatch
                && t.operation_status == OperationStatus::Succeeded
                && t.status == Some(case.expected.status)
                && t.body_sha256.as_ref() == Some(&case.expected.body_sha256)
            {
                match case.role {
                    WebCaseRole::Attack => measured_attacks += 1,
                    WebCaseRole::LegitimateControl => measured_controls += 1,
                }
            }
            digest(&t.request_sha256)?;
            if let Some(d) = &t.response_manifest_sha256 {
                digest(d)?;
            }
            if let Some(d) = &t.body_sha256 {
                digest(d)?;
            }
            if t.complete
                && (t.operation_status != OperationStatus::Succeeded
                    || !t.possible_dispatch
                    || t.response_manifest_sha256.is_none()
                    || t.body_sha256.is_none()
                    || !t.status.is_some_and(|s| (100..=599).contains(&s)))
            {
                return Err(Error::Field("experiment complete attempt"));
            }
        }
        if a.observed_attempts != measured_attacks || a.control_attempts != measured_controls {
            return Err(Error::Field("experiment measured counts"));
        }
        if e.operation_status == OperationStatus::Succeeded {
            let required_controls = e
                .proposal
                .cases
                .iter()
                .filter(|c| c.role == WebCaseRole::LegitimateControl)
                .count() as u32
                * e.proposal.repeats;
            let required_attacks = a.expected_attempts - required_controls;
            let mut repeated = BTreeMap::new();
            if measured_controls != required_controls
                || (a.disposition == Disposition::ObservedForPlan
                    && measured_attacks != required_attacks)
                || (a.disposition == Disposition::NotObserved
                    && measured_attacks == required_attacks)
                || o.attempts.iter().any(|t| {
                    repeated
                        .insert(&t.case_name, (t.status, t.body_sha256.as_ref()))
                        .is_some_and(|old| old != (t.status, t.body_sha256.as_ref()))
                })
            {
                return Err(Error::Field("experiment stable attack/control outcome"));
            }
        }
        if e.operation_status == OperationStatus::Succeeded
            && (o.stop.is_some()
                || o.error.is_some()
                || a.completed_attempts != a.expected_attempts
                || !matches!(
                    a.disposition,
                    zero_protocol::verification::Disposition::ObservedForPlan
                        | zero_protocol::verification::Disposition::NotObserved
                ))
        {
            return Err(Error::Field("experiment success"));
        }
    }
    Ok(())
}
type Section = (String, Vec<(String, String)>);
fn sections(report: &WebWorkflowReport) -> Result<Vec<Section>> {
    let r = &report.run;
    let mut sections = vec![(
        "Execution and authority".into(),
        vec![
            ("Session".into(), r.session_id.clone()),
            ("Operation".into(), r.operation_id.clone()),
            ("Command".into(), r.command_id.clone()),
            (
                "Execution status".into(),
                wire(serde_json::to_value(r.operation_status).map_err(|_| Error::Json)?)?,
            ),
            (
                "Error".into(),
                r.error.clone().unwrap_or_else(|| "none retained".into()),
            ),
            ("HTTP profile".into(), r.authority.profile_name.clone()),
            ("Profile SHA256".into(), r.authority.profile_sha256.clone()),
            ("Shared HTTP account".into(), r.authority.account_id.clone()),
            (
                "Captured host policy".into(),
                wire(serde_json::to_value(&r.authority.profile).map_err(|_| Error::Json)?)?,
            ),
        ],
    )];
    match &r.review{
        None=>sections.push(("Hypotheses".into(),vec![("Submission".into(),"No validated terminal submission is available. Retained observations below are partial workflow evidence; absence of hypotheses does not establish safety.".into())])),
        Some(review)=>{
            sections.push(("Submission provenance".into(),vec![("Model".into(),review.model.clone()),("Provider response".into(),review.provider_response_id.clone().unwrap_or_else(||"not supplied".into())),("Submission call".into(),review.submission_call_id.clone()),("Request SHA256".into(),review.request_sha256.clone()),("Completion SHA256".into(),review.completion_sha256.clone())]));
            if review.hypotheses.is_empty(){sections.push(("Hypotheses".into(),vec![("Submission".into(),"Zero hypotheses submitted. Security conclusion remains not established; coverage and safety are not proven.".into())]));}
            for h in &review.hypotheses{
                let mut fields=vec![("ID".into(),h.id.clone()),("State".into(),"unverified".into()),("Claimed severity".into(),wire(serde_json::to_value(&h.claim.claimed_severity).map_err(|_|Error::Json)?)?),("Category".into(),h.claim.category.clone()),("Explanation".into(),h.claim.explanation.clone()),("Claimed impact".into(),h.claim.claimed_impact.clone())];
                for c in &h.claim.citations{let part=match &c.part{WebCitationPart::Status=>"response status".into(),WebCitationPart::Header{index,expected_name}=>format!("header {index}: {expected_name}"),WebCitationPart::Body{offset,length}=>format!("redacted decoded body bytes {offset}..{}",offset+u64::from(*length))};fields.push(("Citation".into(),format!("{} · manifest {} · {part}",c.operation_id,c.response_manifest_sha256)));}
                sections.push((h.claim.title.clone(),fields));
            }
        }
    }
    sections.push((
        "Retained artifacts".into(),
        r.artifacts
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    ));
    sections.push(("HTTP observation coverage".into(),vec![("Catalog".into(),if report.observations_truncated{"Bounded prefix only; more retained observations may exist."}else{"All observations available to this bounded catalog read are listed."}.into()),("Representation".into(),"Evidence bodies are retained redacted decoded bytes; hashes do not identify raw network secrets.".into())]));
    for observation in &report.observations {
        let mut fields = vec![
            (
                "Operation".into(),
                observation.operation.operation_id.clone(),
            ),
            (
                "Actor".into(),
                observation.operation.actor_operation_id.clone(),
            ),
            (
                "Execution status".into(),
                wire(
                    serde_json::to_value(observation.operation.operation_status)
                        .map_err(|_| Error::Json)?,
                )?,
            ),
        ];
        if let Some(e) = &observation.evidence {
            fields.extend([
                (
                    "URL".into(),
                    e.url.clone().unwrap_or_else(|| "unavailable".into()),
                ),
                (
                    "HTTP status".into(),
                    e.status
                        .map_or_else(|| "unavailable".into(), |n| n.to_string()),
                ),
                ("Complete".into(), e.complete.to_string()),
                ("Manifest SHA256".into(), e.response_manifest_sha256.clone()),
                (
                    "Retained body SHA256".into(),
                    e.retained_body_sha256.clone(),
                ),
                (
                    "Wire / decoded / retained bytes".into(),
                    format!(
                        "{} / {} / {}",
                        e.wire_bytes, e.decoded_bytes, e.retained_bytes
                    ),
                ),
                (
                    "Redacted headers".into(),
                    wire(serde_json::to_value(&e.headers).map_err(|_| Error::Json)?)?,
                ),
            ]);
        } else {
            fields.push((
                "Evidence".into(),
                observation
                    .error
                    .clone()
                    .unwrap_or_else(|| "Retained validated response unavailable.".into()),
            ));
        }
        sections.push(("HTTP observation".into(), fields));
    }
    for v in &report.verifications {
        let mut fields=vec![("Operation".into(),v.operation_id.clone()),("Execution status".into(),wire(serde_json::to_value(v.operation_status).map_err(|_|Error::Json)?)?),("Plan qualification".into(),"Only this exact frozen request/expectation matrix under the same static identity and existing target state. Not generic vulnerability verification.".into()),("Intent SHA256".into(),v.intent_sha256.clone()),("Approved intent SHA256".into(),v.approved_intent_sha256.clone().unwrap_or_else(||"not required or not supplied".into())),("Frozen plan".into(),wire(serde_json::to_value(&v.plan).map_err(|_|Error::Json)?)?),("Assessment".into(),wire(serde_json::to_value(&v.outcome.assessment).map_err(|_|Error::Json)?)?),("Stop".into(),wire(serde_json::to_value(v.outcome.stop).map_err(|_|Error::Json)?)?),("Error".into(),v.outcome.error.clone().unwrap_or_else(||"none retained".into()))];
        for t in &v.outcome.attempts {
            fields.push((
                format!("{} repeat {}", t.case_name, t.repeat_index),
                wire(serde_json::to_value(t).map_err(|_| Error::Json)?)?,
            ));
        }
        fields.extend(
            v.outcome
                .artifacts
                .iter()
                .map(|(k, v)| (k.clone(), v.clone())),
        );
        sections.push(("Independent frozen-plan observations".into(), fields));
    }
    for e in &report.experiments {
        let mut fields=vec![
            ("Operation / actor / inference".into(),format!("{} / {} / {}",e.operation_id,e.actor_operation_id,e.inference_operation_id)),
            ("Execution status".into(),format!("{:?}",e.operation_status)),
            ("Model conjecture — Unverified".into(),e.hypothesis.title.clone()),
            ("Model explanation".into(),e.hypothesis.explanation.clone()),
            ("Model experiment purpose".into(),e.proposal.purpose.clone()),
            ("Hypothesis revision SHA256".into(),e.hypothesis.hypothesis_sha256.clone()),
            ("Prior revision".into(),wire(serde_json::to_value(&e.hypothesis.prior_revision).map_err(|_|Error::Json)?)?),
            ("Intent SHA256".into(),e.intent_sha256.clone()),
            ("Matrix SHA256".into(),e.matrix_sha256.clone()),
            ("Captured host limits".into(),wire(serde_json::to_value(&e.policy).map_err(|_|Error::Json)?)?),
            ("Model predictions — not a security oracle".into(),wire(serde_json::to_value(&e.proposal.cases).map_err(|_|Error::Json)?)?),
            ("Measurement limits".into(),"Exact response matching under the same static identity and existing target state. No target reset, cross-principal proof, generic verification, or evolution promotion. Assessment plan_sha256 identifies this experiment matrix.".into()),
        ];
        if let Some(o) = &e.outcome {
            fields.push((
                "Independent measured feedback".into(),
                wire(serde_json::to_value(&o.assessment).map_err(|_| Error::Json)?)?,
            ));
            fields.push((
                "Stop / error".into(),
                format!(
                    "{:?} / {}",
                    o.stop,
                    o.error.as_deref().unwrap_or("none retained")
                ),
            ));
            for t in &o.attempts {
                fields.push((
                    format!("Measured {} repeat {}", t.case_name, t.repeat_index),
                    wire(serde_json::to_value(t).map_err(|_| Error::Json)?)?,
                ));
            }
        } else {
            fields.push((
                "Independent measured feedback".into(),
                "Experiment remains active; no terminal assessment is asserted.".into(),
            ));
        }
        fields.extend(e.artifacts.iter().map(|(k, v)| (k.clone(), v.clone())));
        sections.push((
            "Agent-chosen experiment — predictions and measurements".into(),
            fields,
        ));
    }
    Ok(sections)
}
