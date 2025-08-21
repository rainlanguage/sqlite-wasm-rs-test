use js_sys::Function;
use serde::{Deserialize, Serialize};

// Message types for BroadcastChannel communication
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type")]
pub enum ChannelMessage {
    #[serde(rename = "new-leader")]
    NewLeader {
        #[serde(rename = "leaderId")]
        leader_id: String,
    },
    #[serde(rename = "query-request")]
    QueryRequest {
        #[serde(rename = "queryId")]
        query_id: String,
        sql: String,
    },
    #[serde(rename = "query-response")]
    QueryResponse {
        #[serde(rename = "queryId")]
        query_id: String,
        result: Option<String>,
        error: Option<String>,
    },
}

// Messages from main thread
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum WorkerMessage {
    #[serde(rename = "execute-query")]
    ExecuteQuery { sql: String },
}

// Messages to main thread
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum MainThreadMessage {
    #[serde(rename = "query-result")]
    QueryResult {
        result: Option<String>,
        error: Option<String>,
    },
    #[serde(rename = "worker-ready")]
    WorkerReady,
}

pub struct PendingQuery {
    pub resolve: Function,
    pub reject: Function,
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    fn assert_serialization_roundtrip<
        T: Serialize + for<'a> Deserialize<'a> + PartialEq + std::fmt::Debug,
    >(
        msg: T,
        expected_type: &str,
        additional_checks: impl Fn(&str),
    ) {
        let json = serde_json::to_string(&msg).expect("Should serialize");
        assert!(json.contains(&format!("\"type\":\"{expected_type}\"")));
        additional_checks(&json);

        let deserialized: T = serde_json::from_str(&json).expect("Should deserialize");
        assert_eq!(msg, deserialized);
    }

    #[wasm_bindgen_test]
    fn test_channel_messages_serialization() {
        let new_leader = ChannelMessage::NewLeader {
            leader_id: "test-leader-123".to_string(),
        };
        assert_serialization_roundtrip(new_leader, "new-leader", |json| {
            assert!(json.contains("\"leaderId\":\"test-leader-123\""));
        });

        let query_request = ChannelMessage::QueryRequest {
            query_id: "query-456".to_string(),
            sql: "SELECT * FROM users".to_string(),
        };
        assert_serialization_roundtrip(query_request, "query-request", |json| {
            assert!(json.contains("\"queryId\":\"query-456\""));
            assert!(json.contains("\"sql\":\"SELECT * FROM users\""));
        });

        let query_success = ChannelMessage::QueryResponse {
            query_id: "query-789".to_string(),
            result: Some("[{\"id\": 1, \"name\": \"test\"}]".to_string()),
            error: None,
        };
        assert_serialization_roundtrip(query_success, "query-response", |json| {
            assert!(json.contains("\"queryId\":\"query-789\""));
            assert!(json.contains("\"result\":\""));
            assert!(json.contains("\"error\":null"));
        });

        let query_error = ChannelMessage::QueryResponse {
            query_id: "query-error".to_string(),
            result: None,
            error: Some("SQL syntax error".to_string()),
        };
        assert_serialization_roundtrip(query_error, "query-response", |json| {
            assert!(json.contains("\"error\":\"SQL syntax error\""));
            assert!(json.contains("\"result\":null"));
        });
    }

    #[wasm_bindgen_test]
    fn test_worker_message_execute_query_serialization() {
        let msg = WorkerMessage::ExecuteQuery {
            sql: "INSERT INTO table VALUES (1, 'test')".to_string(),
        };

        let json = serde_json::to_string(&msg).expect("Should serialize");
        assert!(json.contains("\"type\":\"execute-query\""));
        assert!(json.contains("\"sql\":\"INSERT INTO table VALUES (1, 'test')\""));

        let deserialized: WorkerMessage = serde_json::from_str(&json).expect("Should deserialize");
        match deserialized {
            WorkerMessage::ExecuteQuery { sql } => {
                assert_eq!(sql, "INSERT INTO table VALUES (1, 'test')");
            }
        }
    }

    #[wasm_bindgen_test]
    fn test_main_thread_messages_serialization() {
        let success_result = MainThreadMessage::QueryResult {
            result: Some("Success".to_string()),
            error: None,
        };
        assert_serialization_roundtrip(success_result, "query-result", |json| {
            assert!(json.contains("\"result\":\"Success\""));
            assert!(json.contains("\"error\":null"));
        });

        let error_result = MainThreadMessage::QueryResult {
            result: None,
            error: Some("Database error".to_string()),
        };
        assert_serialization_roundtrip(error_result, "query-result", |json| {
            assert!(json.contains("\"error\":\"Database error\""));
            assert!(json.contains("\"result\":null"));
        });

        let worker_ready = MainThreadMessage::WorkerReady;
        assert_serialization_roundtrip(worker_ready, "worker-ready", |_| {});
    }

    #[wasm_bindgen_test]
    fn test_edge_cases() {
        let empty_leader = ChannelMessage::NewLeader {
            leader_id: String::new(),
        };
        assert_serialization_roundtrip(empty_leader, "new-leader", |json| {
            assert!(json.contains("\"leaderId\":\"\""));
        });

        let empty_sql = ChannelMessage::QueryRequest {
            query_id: "test".to_string(),
            sql: String::new(),
        };
        assert_serialization_roundtrip(empty_sql, "query-request", |json| {
            assert!(json.contains("\"sql\":\"\""));
        });

        let special_chars = ChannelMessage::QueryRequest {
            query_id: "query\"with\"quotes".to_string(),
            sql: "SELECT 'test\nwith\nnewlines'".to_string(),
        };
        assert_serialization_roundtrip(special_chars, "query-request", |_| {});
    }

    #[wasm_bindgen_test]
    fn test_invalid_deserialization() {
        let test_cases = vec![
            (
                r#"{"type": "unknown-type", "data": "test"}"#,
                "unknown message type",
            ),
            (r#"{"invalid": "json"}"#, "missing type field"),
            (r#"{"type": "new-leader"}"#, "missing required fields"),
            (r#"invalid json"#, "malformed JSON"),
        ];

        for (invalid_json, _description) in test_cases {
            assert!(serde_json::from_str::<ChannelMessage>(invalid_json).is_err());
            assert!(serde_json::from_str::<WorkerMessage>(invalid_json).is_err());
            assert!(serde_json::from_str::<MainThreadMessage>(invalid_json).is_err());
        }
    }
}
