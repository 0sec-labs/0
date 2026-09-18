//! Operator answers are information only; they never change actor authority.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperatorQuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub recommended: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperatorQuestionSpec {
    pub header: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<OperatorQuestionOption>>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub multi_select: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_custom: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperatorQuestionRequest {
    pub questions: Vec<OperatorQuestionSpec>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperatorAnswer {
    pub question_index: u32,
    #[serde(default)]
    pub selected_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperatorDecision {
    Answer { answers: Vec<OperatorAnswer> },
    Dismiss,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperatorQuestionStatus {
    Pending,
    Answered,
    Dismissed,
    Cancelled,
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperatorQuestionDecisionReceipt {
    pub id: String,
    pub session_id: String,
    pub command_id: String,
    pub question_operation_id: String,
    pub request_sha256: String,
    pub decision: OperatorDecision,
    pub sequence: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperatorQuestionRecord {
    pub operation_id: String,
    pub session_id: String,
    pub actor_operation_id: String,
    pub root_operation_id: String,
    pub sequence: u64,
    pub request_sha256: String,
    pub request: OperatorQuestionRequest,
    pub status: OperatorQuestionStatus,
    pub decision: Option<OperatorQuestionDecisionReceipt>,
}
fn invalid(reason: &str) -> crate::ValidationError {
    crate::ValidationError(reason.into())
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}
impl OperatorQuestionRequest {
    pub fn validate(&self) -> Result<(), crate::ValidationError> {
        if !(1..=4).contains(&self.questions.len()) {
            return Err(invalid("operator request requires 1..4 questions"));
        }
        let mut headers = BTreeSet::new();
        for question in &self.questions {
            if !text(&question.header, 128)
                || !headers.insert(question.header.trim())
                || !text(&question.question, 4096)
            {
                return Err(invalid(
                    "invalid or duplicate question header or bounded question text",
                ));
            }
            if question.options.is_none() && !question.allow_custom {
                return Err(invalid("question must allow options or custom input"));
            }
            if let Some(options) = &question.options {
                if !(2..=4).contains(&options.len()) {
                    return Err(invalid("operator choices require 2..4 options"));
                }
                let mut labels = BTreeSet::new();
                for option in options {
                    if !text(&option.label, 256)
                        || !labels.insert(option.label.trim())
                        || option.description.as_ref().is_some_and(|d| !text(d, 1024))
                    {
                        return Err(invalid("invalid or duplicate bounded option text"));
                    }
                }
            }
        }
        if serde_json::to_vec(self)
            .map_err(|e| invalid(&e.to_string()))?
            .len()
            > 65536
        {
            return Err(invalid("operator request exceeds 64 KiB serialized"));
        }
        Ok(())
    }
}
impl OperatorDecision {
    pub fn validate(
        &self,
        request: &OperatorQuestionRequest,
    ) -> Result<(), crate::ValidationError> {
        request.validate()?;
        if let Self::Answer { answers } = self {
            if answers.len() != request.questions.len() {
                return Err(invalid("answer must cover every question exactly once"));
            }
            let mut questions = BTreeSet::new();
            for answer in answers {
                let question = request
                    .questions
                    .get(answer.question_index as usize)
                    .ok_or_else(|| invalid("answer question index is not offered"))?;
                if !questions.insert(answer.question_index)
                    || answer.selected_indices.len() > 4
                    || (!question.multi_select && answer.selected_indices.len() > 1)
                {
                    return Err(invalid("duplicate question or invalid selection count"));
                }
                let mut indices = BTreeSet::new();
                for index in &answer.selected_indices {
                    if !indices.insert(index)
                        || question
                            .options
                            .as_ref()
                            .and_then(|v| v.get(*index as usize))
                            .is_none()
                    {
                        return Err(invalid("answer option index is duplicate or not offered"));
                    }
                }
                if let Some(custom) = &answer.custom_text {
                    if !question.allow_custom || !text(custom, 16384) {
                        return Err(invalid("custom answer not allowed or exceeds 16 KiB"));
                    }
                }
                if answer.selected_indices.is_empty() && answer.custom_text.is_none() {
                    return Err(invalid("empty answer; explicitly dismiss instead"));
                }
            }
        }
        if serde_json::to_vec(self)
            .map_err(|e| invalid(&e.to_string()))?
            .len()
            > 65536
        {
            return Err(invalid("operator decision exceeds 64 KiB serialized"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request() -> OperatorQuestionRequest {
        serde_json::from_value(json!({"questions":[{"header":"Scope","question":"Which?","options":[{"label":"A"},{"label":"B"}]}]})).unwrap()
    }
    #[test]
    fn strict_question_and_answer_bounds_preserve_explicit_choice_authority() {
        let request = request();
        request.validate().unwrap();
        for value in [
            json!({"type":"answer","answers":[]}),
            json!({"type":"answer","answers":[{"question_index":1,"selected_indices":[0]}]}),
            json!({"type":"answer","answers":[{"question_index":0,"selected_indices":[2]}]}),
            json!({"type":"answer","answers":[{"question_index":0,"selected_indices":[0,1]}]}),
            json!({"type":"answer","answers":[{"question_index":0,"custom_text":"unoffered"}]}),
            json!({"type":"answer","answers":[{"question_index":0}]}),
        ] {
            let decision: OperatorDecision = serde_json::from_value(value).unwrap();
            assert!(decision.validate(&request).is_err());
        }
        OperatorDecision::Dismiss.validate(&request).unwrap();
        let valid: OperatorDecision = serde_json::from_value(
            json!({"type":"answer","answers":[{"question_index":0,"selected_indices":[1]}]}),
        )
        .unwrap();
        valid.validate(&request).unwrap();
        let mut duplicate = request.clone();
        duplicate.questions.push(duplicate.questions[0].clone());
        assert!(duplicate.validate().is_err());
        let mut duplicate = request.clone();
        duplicate.questions[0].options.as_mut().unwrap()[1].label = " A ".into();
        assert!(duplicate.validate().is_err());
        let mut long = request.clone();
        long.questions[0].header = "é".repeat(65);
        assert!(long.validate().is_err());
        let mut none = request.clone();
        none.questions[0].options = None;
        assert!(none.validate().is_err());
        none.questions[0].allow_custom = true;
        none.validate().unwrap();
        let custom:OperatorDecision=serde_json::from_value(json!({"type":"answer","answers":[{"question_index":0,"custom_text":"é".repeat(8193)}]})).unwrap();
        assert!(custom.validate(&none).is_err());
        assert!(
            serde_json::from_value::<OperatorQuestionRequest>(json!({"questions":[],"grant":true}))
                .is_err()
        );
    }
    #[test]
    fn multiple_answers_reject_duplicates_and_serialized_expansion() {
        let mut r = request();
        r.questions[0].allow_custom = true;
        r.questions[0].multi_select = true;
        let d: OperatorDecision = serde_json::from_value(
            json!({"type":"answer","answers":[{"question_index":0,"selected_indices":[0,0]}]}),
        )
        .unwrap();
        assert!(d.validate(&r).is_err());
        let d:OperatorDecision=serde_json::from_value(json!({"type":"answer","answers":[{"question_index":0,"custom_text":"\u{0001}".repeat(16384)}]})).unwrap();
        assert!(d.validate(&r).is_err());
        let d:OperatorDecision=serde_json::from_value(json!({"type":"answer","answers":[{"question_index":0,"selected_indices":[0,1],"custom_text":"both"}]})).unwrap();
        d.validate(&r).unwrap();
        let q = serde_json::to_value(request()).unwrap();
        assert!(q["questions"][0].get("multi_select").is_none());
        assert!(q["questions"][0].get("allow_custom").is_none());
    }
}
