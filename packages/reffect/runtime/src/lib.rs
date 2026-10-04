//! The static runtime modules generated crates inline, as siblings at the crate root so their
//! `super::` paths resolve as they do there. Each file is a module body; the emitters wrap it.

#[allow(dead_code)]
pub mod foldkit_eval;
#[allow(dead_code)]
pub mod foldkit_html;
#[allow(dead_code)]
pub mod foldkit_json;
#[allow(dead_code)]
mod foldkit_ssr;
#[allow(dead_code)]
mod remote_engine;
#[allow(dead_code)]
pub mod ssr_host;

/// The RPC server's static items (#37). Generated `main.rs` files inline these lists at their
/// root, where the imports below and the constants (generated from the server's options) live;
/// here they are included into a host module that provides the same names.
#[allow(dead_code)]
pub mod rpc_host {
    use axum::response::{IntoResponse, Response};
    use axum::{body::Bytes, http::StatusCode, Router};
    use serde_json::{json, Value};
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    pub const NDJSON: bool = true;
    pub const MAX_BATCH: usize = 64;
    pub const HEADER_TIMEOUT_MS: u64 = 30_000;
    pub const MAX_CONNECTIONS: usize = 1024;

    include!("rpc_args.rs");
    include!("rpc_wire.rs");
    include!("rpc_stream.rs");
    include!("rpc_serve.rs");

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn ndjson_bodies_read_complete_lines_only() {
            let (messages, batched) = read_body(
                b"{\"a\":1}
not json
{\"b\":2}
{\"partial\"",
            )
            .unwrap();
            assert!(batched);
            assert_eq!(messages, [json!({ "a": 1 }), json!({ "b": 2 })]);
            // A body without a complete message is the official server's empty 500.
            let response = read_body(b"{\"partial\"").err().unwrap();
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        }

        #[test]
        fn batches_over_the_limit_or_with_repeated_ids_are_refused() {
            let request = |id: Value| json!({ "_tag": "Request", "id": id });
            assert!(validate_batch(&[request(json!("1")), request(json!("2"))]).is_none());
            let repeated = validate_batch(&[request(json!(1)), request(json!(1.0))]).unwrap();
            assert_eq!(repeated.status(), StatusCode::OK);
            let many: Vec<Value> = (0..=MAX_BATCH).map(|i| request(json!(i))).collect();
            assert_eq!(
                validate_batch(&many).unwrap().status(),
                StatusCode::PAYLOAD_TOO_LARGE
            );
        }

        #[test]
        fn u64_arguments_answer_with_the_official_messages() {
            assert_eq!(u64_arg(&json!("18446744073709551615"), None), Ok(u64::MAX));
            assert_eq!(u64_arg(&json!("007"), None), Ok(7));
            assert_eq!(
                u64_arg(&json!("18446744073709551616"), Some("n")).unwrap_err(),
                "Expected a value less than or equal to 18446744073709551615n
  at [\"n\"]"
            );
            assert_eq!(
                u64_arg(&json!("-1"), None).unwrap_err(),
                "Expected a value greater than or equal to 0n"
            );
            assert_eq!(u64_arg(&json!(1), None).unwrap_err(), "Expected string");
        }
    }
}

#[cfg(test)]
mod tests;
