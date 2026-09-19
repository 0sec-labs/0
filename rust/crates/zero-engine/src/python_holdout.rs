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

impl Engine {
    pub fn verify_python_search_inference(
        &self,
        session: &str,
        command: &str,
        operation_id: &str,
        request_sha: &str,
    ) -> Result<zero_store::VerifiedPythonSearchInference, EngineError> {
        let control = lock(&self.shared.control)?;
        if control.closing || control.active.contains_key(session) {
            return Err(EngineError::State(
                "Python search requires settled inference and an open owner".into(),
            ));
        }
        Ok(lock(&self.shared.store)?.verify_python_search_inference(
            &self.shared.owner,
            session,
            command,
            operation_id,
            request_sha,
        )?)
    }
}
