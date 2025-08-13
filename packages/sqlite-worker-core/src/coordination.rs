use js_sys::{Function, Object, Promise, Reflect};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use uuid::Uuid;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::BroadcastChannel;

use crate::database::SQLiteDatabase;
use crate::messages::{ChannelMessage, PendingQuery};

// Worker state
pub struct WorkerState {
    pub worker_id: String,
    pub is_leader: Rc<RefCell<bool>>,
    pub db: Rc<RefCell<Option<Rc<SQLiteDatabase>>>>,
    pub channel: BroadcastChannel,
    pub pending_queries: Rc<RefCell<HashMap<String, PendingQuery>>>,
}

impl WorkerState {
    pub fn new() -> Result<Self, JsValue> {
        let worker_id = Uuid::new_v4().to_string();
        let channel = BroadcastChannel::new("sqlite-queries")?;

        Ok(WorkerState {
            worker_id,
            is_leader: Rc::new(RefCell::new(false)),
            db: Rc::new(RefCell::new(None)),
            channel,
            pending_queries: Rc::new(RefCell::new(HashMap::new())),
        })
    }

    pub fn setup_channel_listener(&self) {
        let is_leader = Rc::clone(&self.is_leader);
        let db = Rc::clone(&self.db);
        let pending_queries = Rc::clone(&self.pending_queries);
        let channel = self.channel.clone();

        let onmessage = Closure::wrap(Box::new(move |event: web_sys::MessageEvent| {
            let data = event.data();

            if let Ok(msg) = serde_wasm_bindgen::from_value::<ChannelMessage>(data) {
                match msg {
                    ChannelMessage::QueryRequest { query_id, sql } => {
                        if *is_leader.borrow() {
                            let db = Rc::clone(&db);
                            let channel = channel.clone();

                            spawn_local(async move {
                                let database = db.borrow().clone();
                                let result = if let Some(database) = database {
                                    database.exec(&sql).await
                                } else {
                                    Err("Database not initialized".to_string())
                                };

                                let response = match result {
                                    Ok(res) => ChannelMessage::QueryResponse {
                                        query_id,
                                        result: Some(res),
                                        error: None,
                                    },
                                    Err(err) => ChannelMessage::QueryResponse {
                                        query_id,
                                        result: None,
                                        error: Some(err),
                                    },
                                };

                                let msg_js = serde_wasm_bindgen::to_value(&response).unwrap();
                                let _ = channel.post_message(&msg_js);
                            });
                        }
                    }
                    ChannelMessage::QueryResponse {
                        query_id,
                        result,
                        error,
                    } => {
                        if let Some(pending) = pending_queries.borrow_mut().remove(&query_id) {
                            if let Some(err) = error {
                                let _ = pending
                                    .reject
                                    .call1(&JsValue::NULL, &JsValue::from_str(&err));
                            } else if let Some(res) = result {
                                let _ = pending
                                    .resolve
                                    .call1(&JsValue::NULL, &JsValue::from_str(&res));
                            }
                        }
                    }
                    ChannelMessage::NewLeader { leader_id: _ } => {}
                }
            }
        }) as Box<dyn FnMut(web_sys::MessageEvent)>);

        self.channel
            .set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
        onmessage.forget();
    }

    pub async fn attempt_leadership(&self) {
        let worker_id = self.worker_id.clone();
        let is_leader = Rc::clone(&self.is_leader);
        let db = Rc::clone(&self.db);
        let channel = self.channel.clone();

        // Get navigator.locks from WorkerGlobalScope
        let global = js_sys::global();
        let navigator = Reflect::get(&global, &JsValue::from_str("navigator")).unwrap();
        let locks = Reflect::get(&navigator, &JsValue::from_str("locks")).unwrap();

        let options = Object::new();
        Reflect::set(
            &options,
            &JsValue::from_str("mode"),
            &JsValue::from_str("exclusive"),
        )
        .unwrap();

        let handler = Closure::once(move |_lock: JsValue| -> Promise {
            *is_leader.borrow_mut() = true;

            let db = Rc::clone(&db);
            let channel = channel.clone();
            let worker_id = worker_id.clone();

            spawn_local(async move {
                match SQLiteDatabase::initialize_opfs().await {
                    Ok(database) => {
                        *db.borrow_mut() = Some(Rc::new(database));

                        let msg = ChannelMessage::NewLeader {
                            leader_id: worker_id.clone(),
                        };
                        let msg_js = serde_wasm_bindgen::to_value(&msg).unwrap();
                        let _ = channel.post_message(&msg_js);
                    }
                    Err(_e) => {}
                }
            });

            // Never resolve = hold lock forever
            Promise::new(&mut |_, _| {})
        });

        let request_fn = Reflect::get(&locks, &JsValue::from_str("request")).unwrap();
        let request_fn = request_fn.dyn_ref::<Function>().unwrap();

        let _ = request_fn.call3(
            &locks,
            &JsValue::from_str("sqlite-database"),
            &options,
            handler.as_ref().unchecked_ref(),
        );

        handler.forget();
    }

    pub async fn execute_query(&self, sql: String) -> Result<String, String> {
        if *self.is_leader.borrow() {
            let database = self.db.borrow().clone();
            if let Some(database) = database {
                database.exec(&sql).await
            } else {
                Err("Database not initialized".to_string())
            }
        } else {
            let query_id = Uuid::new_v4().to_string();

            let promise = Promise::new(&mut |resolve, reject| {
                self.pending_queries
                    .borrow_mut()
                    .insert(query_id.clone(), PendingQuery { resolve, reject });
            });

            let msg = ChannelMessage::QueryRequest {
                query_id: query_id.clone(),
                sql,
            };
            let msg_js = serde_wasm_bindgen::to_value(&msg).unwrap();
            let _ = self.channel.post_message(&msg_js);

            // Timeout handling
            let timeout_promise = Promise::new(&mut |_, reject| {
                let query_id = query_id.clone();
                let pending_queries = Rc::clone(&self.pending_queries);

                let callback = Closure::once(move || {
                    if pending_queries.borrow_mut().remove(&query_id).is_some() {
                        let _ = reject.call1(&JsValue::NULL, &JsValue::from_str("Query timeout"));
                    }
                });

                let global = js_sys::global();
                let set_timeout = Reflect::get(&global, &JsValue::from_str("setTimeout")).unwrap();
                let set_timeout = set_timeout.dyn_ref::<Function>().unwrap();
                set_timeout
                    .call2(
                        &JsValue::NULL,
                        callback.as_ref().unchecked_ref(),
                        &JsValue::from_f64(5000.0),
                    )
                    .unwrap();
                callback.forget();
            });

            let result = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::race(
                &js_sys::Array::of2(&promise, &timeout_promise),
            ))
            .await;

            match result {
                Ok(val) => {
                    if let Some(s) = val.as_string() {
                        Ok(s)
                    } else {
                        Err("Invalid response".to_string())
                    }
                }
                Err(e) => Err(format!("{e:?}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use js_sys::Function;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn test_worker_state_creation_and_uniqueness() {
        let results: Vec<_> = (0..5).map(|_| WorkerState::new()).collect();
        let workers: Vec<_> = results.into_iter().filter_map(Result::ok).collect();

        assert!(!workers.is_empty(), "Should create at least one worker");

        let state = &workers[0];
        assert!(!state.worker_id.is_empty(), "Worker ID should not be empty");
        assert!(
            state.worker_id.contains('-'),
            "Worker ID should be valid UUID format"
        );
        assert!(
            !*state.is_leader.borrow(),
            "New workers should not start as leader"
        );
        assert!(
            state.db.borrow().is_none(),
            "Database should be uninitialized"
        );
        assert!(
            state.pending_queries.borrow().is_empty(),
            "Should have no pending queries"
        );

        if workers.len() >= 2 {
            let mut ids = std::collections::HashSet::new();
            for worker in &workers {
                assert!(
                    ids.insert(worker.worker_id.clone()),
                    "Worker ID {} should be unique",
                    worker.worker_id
                );
                assert_eq!(worker.worker_id.len(), 36, "UUID should be 36 characters");
                assert_eq!(
                    worker.worker_id.chars().filter(|&c| c == '-').count(),
                    4,
                    "UUID should have 4 dashes"
                );
            }
            assert_eq!(ids.len(), workers.len(), "All worker IDs should be unique");
        }
    }

    #[wasm_bindgen_test]
    fn test_leadership_state_management() {
        if let Ok(state) = WorkerState::new() {
            assert!(!*state.is_leader.borrow(), "Should start as follower");

            *state.is_leader.borrow_mut() = true;
            assert!(*state.is_leader.borrow(), "Should become leader");

            *state.is_leader.borrow_mut() = false;
            assert!(!*state.is_leader.borrow(), "Should become follower again");
        }
    }

    #[wasm_bindgen_test]
    fn test_pending_queries_management() {
        if let Ok(state) = WorkerState::new() {
            let pending_queries = Rc::clone(&state.pending_queries);

            assert_eq!(pending_queries.borrow().len(), 0);

            let test_queries = vec!["query-a", "query-b", "query-c", "query-d", "query-e"];
            {
                let mut queries = pending_queries.borrow_mut();
                for query_id in &test_queries {
                    let resolve =
                        Function::new_no_args(&format!("return 'resolved-{}';", query_id));
                    let reject = Function::new_no_args(&format!("return 'rejected-{}';", query_id));
                    queries.insert(query_id.to_string(), PendingQuery { resolve, reject });
                }
            }

            assert_eq!(pending_queries.borrow().len(), test_queries.len());
            for query_id in &test_queries {
                assert!(pending_queries.borrow().contains_key(*query_id));
            }

            for (i, query_id) in test_queries.iter().enumerate() {
                if i % 2 == 0 {
                    let removed = pending_queries.borrow_mut().remove(*query_id);
                    assert!(removed.is_some(), "Should remove query {}", query_id);
                }
            }

            let remaining_count = test_queries.len() - test_queries.len().div_ceil(2);
            assert_eq!(pending_queries.borrow().len(), remaining_count);

            pending_queries.borrow_mut().clear();
            assert_eq!(pending_queries.borrow().len(), 0);

            {
                let mut queries = pending_queries.borrow_mut();
                let resolve = Function::new_no_args("return 'post-cleanup';");
                let reject = Function::new_no_args("return 'rejected';");
                queries.insert(
                    "post-cleanup-test".to_string(),
                    PendingQuery { resolve, reject },
                );
            }
            assert_eq!(pending_queries.borrow().len(), 1);
            assert!(pending_queries.borrow().contains_key("post-cleanup-test"));
        }
    }

    #[wasm_bindgen_test]
    fn test_message_deserialization_error_handling() {
        let invalid_json = JsValue::from_str("invalid json");
        let result = serde_wasm_bindgen::from_value::<ChannelMessage>(invalid_json);
        assert!(result.is_err(), "Should fail to deserialize invalid JSON");
    }

    #[wasm_bindgen_test]
    async fn test_execute_query_leader_vs_follower_paths() {
        if let Ok(leader_state) = WorkerState::new() {
            *leader_state.is_leader.borrow_mut() = true;

            let test_queries = vec![
                "",
                "SELECT 1",
                "INSERT INTO test VALUES (1, 'hello')",
                "SELECT 'test with spaces and symbols: !@#$%^&*()'",
                "SELECT 'Hello 世界 🌍'",
            ];

            for query in test_queries {
                let result = leader_state.execute_query(query.to_string()).await;
                match result {
                    Err(msg) => assert_eq!(
                        msg, "Database not initialized",
                        "Leader should get DB init error for query: {}",
                        query
                    ),
                    Ok(_) => panic!(
                        "Expected database not initialized error for query: {}",
                        query
                    ),
                }
            }
        }

        if let Ok(follower_state) = WorkerState::new() {
            assert!(
                !*follower_state.is_leader.borrow(),
                "Should start as follower"
            );

            let result = follower_state.execute_query("SELECT 1".to_string()).await;
            match result {
                Err(msg) => assert!(
                    msg.contains("timeout") || msg.contains("Query timeout"),
                    "Follower should timeout, got: {}",
                    msg
                ),
                Ok(_) => panic!("Expected timeout error for follower"),
            }
        }
    }

    #[wasm_bindgen_test]
    fn test_setup_channel_listener() {
        if let Ok(state) = WorkerState::new() {
            state.setup_channel_listener();
        }
    }

    #[wasm_bindgen_test]
    async fn test_attempt_leadership_behavior() {
        if let Ok(state) = WorkerState::new() {
            assert!(!*state.is_leader.borrow(), "Should start as follower");
            assert!(
                state.db.borrow().is_none(),
                "Database should be uninitialized"
            );

            state.attempt_leadership().await;
        }

        let workers: Vec<_> = (0..3).filter_map(|_| WorkerState::new().ok()).collect();
        if workers.len() >= 2 {
            for worker in &workers {
                assert!(!*worker.is_leader.borrow(), "All should start as followers");
            }

            for worker in &workers {
                worker.attempt_leadership().await;
            }
        }
    }

    #[wasm_bindgen_test]
    fn test_worker_state_rc_shared_references() {
        if let Ok(state) = WorkerState::new() {
            let is_leader_clone = Rc::clone(&state.is_leader);
            let pending_clone = Rc::clone(&state.pending_queries);

            assert_eq!(*state.is_leader.borrow(), *is_leader_clone.borrow());
            assert_eq!(
                state.pending_queries.borrow().len(),
                pending_clone.borrow().len()
            );

            *state.is_leader.borrow_mut() = true;
            assert!(
                *is_leader_clone.borrow(),
                "Changes should be visible through cloned Rc"
            );

            {
                let resolve = Function::new_no_args("return 'resolved';");
                let reject = Function::new_no_args("return 'rejected';");
                pending_clone
                    .borrow_mut()
                    .insert("test-ref".to_string(), PendingQuery { resolve, reject });
            }
            assert_eq!(
                state.pending_queries.borrow().len(),
                1,
                "Should see changes through original Rc"
            );
        }
    }
}
