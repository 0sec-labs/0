//! Bounded provider transport. Provider replies are data, never tool authority.
mod anthropic;
mod anthropic_stream;
mod chat;
#[cfg(unix)]
mod entra;
mod google;
mod google_stream;
mod progress;
mod responses;
mod sse;
mod transport;
use serde_json::Value;
pub use transport::{Endpoint, ProviderClient, TransportError};
pub use zero_cloud_client::validate_hosted_pin;
pub use zero_protocol::model::*;

pub fn validate_request(request: &ResponsesRequest) -> Result<(), TransportError> {
    request_body(request).map(|_| ())
}

fn request_body(request: &ResponsesRequest) -> Result<Value, TransportError> {
    if request.model.trim().is_empty()
        || request.model.len() > 256
        || request.max_output_tokens == 0
        || request.max_output_tokens > 1_000_000
        || request.input.len() > 10000
        || request.tools.len() > 256
    {
        return Err(TransportError::InvalidRequest);
    }
    let mut names = std::collections::HashSet::new();
    for tool in &request.tools {
        if tool.name.is_empty()
            || tool.name.len() > 64
            || !tool
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !names.insert(&tool.name)
            || !tool.parameters.is_object()
        {
            return Err(TransportError::InvalidRequest);
        }
    }
    let tools: Vec<_> = request
        .tools
        .iter()
        .map(|tool| {
            serde_json::json!({
                "type":"function","name":tool.name,"description":tool.description,
                "parameters":tool.parameters,"strict":false
            })
        })
        .collect();
    let body = serde_json::json!({"model":request.model,"instructions":request.instructions,
            "input":request.input,"tools":tools,"max_output_tokens":request.max_output_tokens,
            "store":false,"stream":true});
    if serde_json::to_vec(&body)
        .map_err(|_| TransportError::InvalidRequest)?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(TransportError::InvalidRequest);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_input_is_not_double_counted_and_overflow_is_not_silent() {
        let rates = Rates {
            input: 1_000_000,
            cached_input: 100_000,
            output: 2_000_000,
        };
        assert_eq!(
            rates.charge(&Usage {
                input_tokens: 10,
                cached_input_tokens: 5,
                output_tokens: 3
            }),
            Some(12)
        );
        assert_eq!(
            rates.charge(&Usage {
                input_tokens: 1,
                cached_input_tokens: 2,
                output_tokens: 0
            }),
            None
        );
        assert_eq!(
            Rates {
                input: u64::MAX,
                cached_input: 0,
                output: 0
            }
            .charge(&Usage {
                input_tokens: u64::MAX,
                cached_input_tokens: 0,
                output_tokens: 0
            }),
            None
        );
    }
}

#[cfg(test)]
mod anthropic_tests;
