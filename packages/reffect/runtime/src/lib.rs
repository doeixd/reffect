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
pub mod js_std;
#[allow(dead_code)]
mod remote_engine;
#[allow(dead_code)]
pub mod schema_binary;
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
    include!("rpc_json.rs");
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
        fn bodies_decode_as_fetch_text_does() {
            // A leading BOM is removed and an invalid byte becomes U+FFFD, in both
            // serializations, as the official server's request.text reads the body (#27).
            let mut json_body = vec![0xEF, 0xBB, 0xBF];
            json_body.extend_from_slice(b"{\"a\":\"");
            json_body.push(0xFF);
            json_body.extend_from_slice(b"\"}");
            let (messages, batched) = read_body_as(&json_body, false).unwrap();
            assert!(!batched);
            assert_eq!(messages, [json!({ "a": "\u{fffd}" })]);
            let mut ndjson_body = vec![0xEF, 0xBB, 0xBF];
            ndjson_body.extend_from_slice(b"{\"b\":1}\n");
            assert_eq!(
                read_body_as(&ndjson_body, true).unwrap().0,
                [json!({ "b": 1 })]
            );
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

/// The RPC server's static items under SchemaBinary: `rpc_binary` in place of `rpc_json`, with
/// the generated transcoders of one procedure, `Echo` (a String payload and answer), as stubs.
#[allow(dead_code)]
pub mod rpc_binary_host {
    use crate::schema_binary;
    use axum::response::{IntoResponse, Response};
    use axum::{body::Bytes, http::StatusCode};
    use serde_json::{json, Value};
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    pub const MAX_BATCH: usize = 64;
    const ENVELOPE_FINGERPRINT: [u8; 8] = [0xcc, 0x32, 0x8a, 0xb0, 0x8f, 0x52, 0x45, 0x25];
    const MAX_FRAME_SIZE: Option<u64> = Some(64);

    fn sb_payload(tag: &str, bytes: &[u8]) -> Result<Value, String> {
        if tag != "Echo" {
            return Ok(Value::Null);
        }
        let value = schema_binary::one_frame(bytes, None)
            .map_err(|invalid| schema_binary::Failure::from(invalid).message())?;
        schema_binary::Reader::new(value)
            .string()
            .map(Value::String)
            .map_err(|invalid| schema_binary::Failure::from(invalid).message())
    }
    fn sb_chunk(_tag: &str, values: &[Value]) -> Result<Vec<u8>, String> {
        let mut value = Vec::new();
        schema_binary::put_uv(&mut value, values.len() as u64);
        for item in values {
            schema_binary::put_sized(&mut value, item.as_str().ok_or("a string")?.as_bytes());
        }
        let mut frame = Vec::new();
        schema_binary::put_frame(&mut frame, None, &value);
        Ok(frame)
    }
    fn sb_exit(_tag: &str, exit: &Value) -> Result<Vec<u8>, String> {
        let mut value = Vec::new();
        match exit["_tag"].as_str() {
            Some("Success") => schema_binary::put_exit_success(
                &mut value,
                exit["value"].as_str().ok_or("a string")?.as_bytes(),
            ),
            _ => schema_binary::put_exit_failure(
                &mut value,
                &[schema_binary::Reason::Die(
                    json_text(&exit["cause"][0]["defect"]).into_bytes(),
                )],
            ),
        }
        let mut frame = Vec::new();
        schema_binary::put_frame(&mut frame, None, &value);
        Ok(frame)
    }

    include!("rpc_args.rs");
    include!("rpc_wire.rs");
    include!("rpc_binary.rs");
    include!("rpc_stream.rs");

    #[cfg(test)]
    mod tests {
        use super::*;

        fn unhex(text: &str) -> Vec<u8> {
            (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
                .collect()
        }
        fn body_of(response: Response) -> (u16, Vec<u8>) {
            let status = response.status().as_u16();
            let body = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(axum::body::to_bytes(response.into_body(), usize::MAX))
                .unwrap();
            (status, body.to_vec())
        }

        /// What the official server answered (`runtime/fixtures/schema-binary.json`): bodies the
        /// reader refuses get the same status and bytes, and Echo's answers the same frames.
        #[test]
        fn bodies_are_answered_as_the_official_server_answers_them() {
            let fixture: Value =
                serde_json::from_str(include_str!("../fixtures/schema-binary.json")).unwrap();
            for case in fixture["server"].as_array().unwrap() {
                let name = case["name"].as_str().unwrap();
                let expected = (
                    case["status"].as_u64().unwrap() as u16,
                    unhex(case["response"].as_str().unwrap()),
                );
                match read_body(&unhex(case["bytes"].as_str().unwrap())) {
                    Err(response) => assert_eq!(body_of(response), expected, "{name}"),
                    Ok((messages, _)) if name.contains("echo") => {
                        // As the server answers them: each request's exit, tagged with its tag.
                        let answers = messages
                            .iter()
                            .map(|message| {
                                let id = &message["id"];
                                let tag = message["tag"].as_str().unwrap();
                                tagged(exit(id, success(message["payload"].clone())), tag)
                            })
                            .collect();
                        assert_eq!(
                            body_of(write_body(StatusCode::OK, answers)),
                            expected,
                            "{name}"
                        );
                    }
                    // A client-sent Pong is refused as the JSON path refuses non-Request messages.
                    Ok((messages, _)) => {
                        assert_eq!(messages, [json!({"_tag":"Pong"})], "{name}")
                    }
                }
            }
        }

        #[test]
        fn a_payload_that_does_not_transcode_is_kept_for_its_request() {
            // Echo with an empty payload region: a frame without its envelope byte.
            let request = schema_binary::Message::Request(schema_binary::Request {
                id: schema_binary::RequestId::Number(0.0),
                tag: "Echo".into(),
                payload: vec![0x00],
                headers: vec![],
                is_notification: None,
                trace_id: Some(None),
                span_id: None,
                sampled: Some(Some(true)),
            });
            let value = message_value(request);
            assert_eq!(value["payload"], Value::Null);
            assert_eq!(
                value["~payloadError"],
                json!("Expected nonzero frame length")
            );
            // A field present as undefined reads as absent.
            assert!(value.get("traceId").is_none());
            assert_eq!(value["sampled"], json!(true));
        }

        #[test]
        fn numbers_keep_their_sign_and_non_finite_spellings() {
            assert!(value_number(&number_value(-0.0))
                .unwrap()
                .is_sign_negative());
            assert_eq!(number_value(f64::NAN), json!("NaN"));
            assert_eq!(value_number(&json!("-Infinity")), Ok(f64::NEG_INFINITY));
            assert_eq!(
                json_text(&json!({"name":"Error", "message":"a\"b\n", "n":-0.0})),
                "{\"name\":\"Error\",\"message\":\"a\\\"b\\n\",\"n\":0}"
            );
        }
    }
}

/// The SQL source, compiled under each dialect as generated crates compile it: `remote_sql`
/// with its `dialect` child module, beside `remote_engine`.
#[allow(dead_code)]
pub mod sql_sqlite {
    use crate::remote_engine;
    pub mod remote_sql {
        include!("remote_sql.rs");
        mod dialect {
            include!("sql_sqlite.rs");
        }

        #[cfg(test)]
        mod tests {
            // Identifiers are quoted per dialect and placeholders numbered (SQLX-009, SQLX-019).
            #[test]
            fn quotes_and_placeholders() {
                assert_eq!(super::quote("a`b"), "`a``b`");
                assert_eq!(super::placeholder(2), "?2");
            }

            // #26: an unset URL is caught at boot, and a value with no wire or column form fails
            // rather than reading or writing as null.
            #[test]
            fn unusable_urls_blobs_and_object_writes_fail() {
                use super::*;
                use serde_json::json;
                static ENTITIES: &[Entity] = &[Entity {
                    name: "Note",
                    table: "notes",
                    id: "id",
                    columns: &[Column {
                        field: "body",
                        column: "body",
                        kind: Kind::Text,
                    }],
                    relations: &[],
                }];
                let sql = |url_env: &'static str| -> &'static Sql {
                    Box::leak(Box::new(Sql {
                        entities: ENTITIES,
                        queries: &[],
                        url_env,
                        pool: std::sync::OnceLock::new(),
                    }))
                };
                assert_eq!(
                    sql("REFFECT_TEST_UNSET_DATABASE_URL").ready(),
                    Err("REFFECT_TEST_UNSET_DATABASE_URL is not set".to_string())
                );
                let path = std::env::temp_dir()
                    .join(format!("reffect-sql-test-{}.db", std::process::id()));
                let _ = std::fs::remove_file(&path);
                std::env::set_var(
                    "REFFECT_TEST_SQLITE_URL",
                    format!(
                        "sqlite:{}?mode=rwc",
                        path.display().to_string().replace('\\', "/")
                    ),
                );
                let store = sql("REFFECT_TEST_SQLITE_URL");
                let failed = || FAILED.to_string();
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(async {
                        // The pool spawns its reaper, so it is made inside the runtime, as at boot.
                        assert_eq!(store.ready(), Ok(()));
                        let pool = store.pool().unwrap();
                        for statement in [
                            "CREATE TABLE notes (id TEXT PRIMARY KEY, body)",
                            "INSERT INTO notes VALUES ('n1', x'00ff'), ('n2', 'text')",
                        ] {
                            sqlx::query(statement).execute(pool).await.unwrap();
                        }
                        let session = store.begin().await.unwrap();
                        assert_eq!(session.get("Note", "n1").await, Err(failed()));
                        assert_eq!(
                            session.get("Note", "n2").await,
                            Ok(Some(json!({ "body": "text" })))
                        );
                        for value in [json!({ "a": 1 }), json!(["a"])] {
                            assert_eq!(
                                session.write("Note", "n3", json!({ "body": value })).await,
                                Err(failed())
                            );
                        }
                        assert_eq!(
                            session.write("Note", "n3", json!({ "body": "x" })).await,
                            Ok(())
                        );
                        session.finish(false).await.unwrap();
                        pool.close().await;
                    });
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
#[allow(dead_code)]
pub mod sql_postgres {
    use crate::remote_engine;
    pub mod remote_sql {
        include!("remote_sql.rs");
        mod dialect {
            include!("sql_postgres.rs");
        }

        #[cfg(test)]
        mod tests {
            // Identifiers are quoted per dialect and placeholders numbered (SQLX-009, SQLX-019).
            #[test]
            fn quotes_and_placeholders() {
                assert_eq!(super::quote("a\"b"), "\"a\"\"b\"");
                assert_eq!(super::placeholder(2), "$2");
            }
        }
    }
}

#[cfg(test)]
mod tests;
