//! Explicit byte-bounded projection policy; it is not a model token estimate.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ContextPolicy {
    pub schema_version: u32,
    pub max_input_bytes: u32,
    pub keep_recent_rounds: u32,
}
impl ContextPolicy {
    pub fn validate(&self) -> Result<(), crate::ValidationError> {
        if self.schema_version != 1
            || !(1024..=4 * 1024 * 1024).contains(&self.max_input_bytes)
            || !(1..=32).contains(&self.keep_recent_rounds)
        {
            return Err(crate::ValidationError(
                "context policy requires schema 1, 1 KiB..4 MiB and 1..32 recent rounds".into(),
            ));
        }
        Ok(())
    }
}
