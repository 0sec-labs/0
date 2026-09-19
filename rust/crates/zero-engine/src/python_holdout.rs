//! Explicit host bridge; this authority is not exposed through model tools.
use super::*;
impl Engine {
    pub fn claim_python_holdout(
        &self,
        claim: &zero_store::PythonHoldoutClaim,
    ) -> Result<zero_store::VerifiedPythonHoldout, EngineError> {
        let control = lock(&self.shared.control)?;
        if control.closing || control.active.contains_key(&claim.session_id) {
            return Err(EngineError::State(
                "Python holdout requires settled inference and an open owner".into(),
            ));
        }
        Ok(lock(&self.shared.store)?.claim_python_holdout(&self.shared.owner, claim)?)
    }
}
