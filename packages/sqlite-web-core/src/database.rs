use crate::database_functions::register_custom_functions;
use sqlite_wasm_rs::export::{install_opfs_sahpool, *};
use std::ffi::{CStr, CString};
use wasm_bindgen::prelude::*;

// Real SQLite database using sqlite-wasm-rs FFI
pub struct SQLiteDatabase {
    db: *mut sqlite3,
}

unsafe impl Send for SQLiteDatabase {}
unsafe impl Sync for SQLiteDatabase {}

impl SQLiteDatabase {
    pub async fn initialize_opfs() -> Result<Self, JsValue> {
        // Install OPFS VFS and set as default
        install_opfs_sahpool(None, true)
            .await
            .map_err(|e| JsValue::from_str(&format!("Failed to install OPFS VFS: {e:?}")))?;

        // Open database with OPFS
        let mut db = std::ptr::null_mut();
        let db_name = CString::new("opfs-sahpool:worker.db").unwrap();

        let ret = unsafe {
            sqlite3_open_v2(
                db_name.as_ptr(),
                &mut db as *mut _,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
                std::ptr::null(),
            )
        };

        if ret != SQLITE_OK {
            let error_msg = unsafe {
                let ptr = sqlite3_errmsg(db);
                if !ptr.is_null() {
                    CStr::from_ptr(ptr).to_string_lossy().into_owned()
                } else {
                    format!("SQLite error code: {ret}")
                }
            };
            return Err(JsValue::from_str(&format!(
                "Failed to open SQLite database: {error_msg}"
            )));
        }

        // Register custom functions
        register_custom_functions(db).map_err(|e| JsValue::from_str(&e))?;

        Ok(SQLiteDatabase { db })
    }

    pub async fn exec(&self, sql: &str) -> Result<String, String> {
        let sql_cstr = CString::new(sql).map_err(|e| format!("Invalid SQL string: {e}"))?;
        let mut stmt = std::ptr::null_mut();

        // Prepare statement
        let ret = unsafe {
            sqlite3_prepare_v2(
                self.db,
                sql_cstr.as_ptr(),
                -1,
                &mut stmt,
                std::ptr::null_mut(),
            )
        };

        if ret != SQLITE_OK {
            let error_msg = unsafe {
                let ptr = sqlite3_errmsg(self.db);
                if !ptr.is_null() {
                    CStr::from_ptr(ptr).to_string_lossy().into_owned()
                } else {
                    format!("SQLite error code: {ret}")
                }
            };
            return Err(format!("Failed to prepare statement: {error_msg}"));
        }

        // Execute and collect results
        let mut results = Vec::new();
        let mut column_names = Vec::new();
        let mut first_row = true;

        loop {
            let step_result = unsafe { sqlite3_step(stmt) };

            match step_result {
                SQLITE_ROW => {
                    if first_row {
                        // Get column names
                        let col_count = unsafe { sqlite3_column_count(stmt) };
                        for i in 0..col_count {
                            let col_name = unsafe {
                                let ptr = sqlite3_column_name(stmt, i);
                                if !ptr.is_null() {
                                    CStr::from_ptr(ptr).to_string_lossy().into_owned()
                                } else {
                                    format!("column_{i}")
                                }
                            };
                            column_names.push(col_name);
                        }
                        first_row = false;
                    }

                    // Get row data
                    let mut row_obj = std::collections::HashMap::new();
                    let col_count = unsafe { sqlite3_column_count(stmt) };

                    for i in 0..col_count {
                        let col_type = unsafe { sqlite3_column_type(stmt, i) };
                        let value = match col_type {
                            SQLITE_INTEGER => {
                                let val = unsafe { sqlite3_column_int64(stmt, i) };
                                serde_json::Value::Number(serde_json::Number::from(val))
                            }
                            SQLITE_FLOAT => {
                                let val = unsafe { sqlite3_column_double(stmt, i) };
                                serde_json::Value::Number(
                                    serde_json::Number::from_f64(val)
                                        .unwrap_or(serde_json::Number::from(0)),
                                )
                            }
                            SQLITE_TEXT => {
                                let ptr = unsafe { sqlite3_column_text(stmt, i) };
                                if !ptr.is_null() {
                                    let text = unsafe {
                                        CStr::from_ptr(ptr as *const i8)
                                            .to_string_lossy()
                                            .into_owned()
                                    };
                                    serde_json::Value::String(text)
                                } else {
                                    serde_json::Value::Null
                                }
                            }
                            SQLITE_BLOB => {
                                let len = unsafe { sqlite3_column_bytes(stmt, i) };
                                serde_json::Value::String(format!("<blob {len} bytes>"))
                            }
                            _ => serde_json::Value::Null,
                        };

                        if let Some(col_name) = column_names.get(i as usize) {
                            row_obj.insert(col_name.clone(), value);
                        }
                    }

                    results.push(serde_json::Value::Object(row_obj.into_iter().collect()));
                }
                SQLITE_DONE => break,
                _ => {
                    let error_msg = unsafe {
                        let ptr = sqlite3_errmsg(self.db);
                        if !ptr.is_null() {
                            CStr::from_ptr(ptr).to_string_lossy().into_owned()
                        } else {
                            format!("SQLite error code: {step_result}")
                        }
                    };
                    unsafe {
                        sqlite3_finalize(stmt);
                    }
                    return Err(format!("Query execution failed: {error_msg}"));
                }
            }
        }

        // Cleanup
        unsafe {
            sqlite3_finalize(stmt);
        }

        // Return results
        if sql.trim().to_lowercase().starts_with("select") && !results.is_empty() {
            serde_json::to_string_pretty(&results)
                .map_err(|e| format!("JSON serialization error: {e}"))
        } else if sql.trim().to_lowercase().starts_with("select") {
            Ok("[]".to_string())
        } else {
            // For non-SELECT queries, return changes count
            let changes = unsafe { sqlite3_changes(self.db) };
            Ok(format!(
                "Query executed successfully. Rows affected: {changes}"
            ))
        }
    }
}

impl Drop for SQLiteDatabase {
    fn drop(&mut self) {
        if !self.db.is_null() {
            unsafe {
                sqlite3_close(self.db);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    async fn test_opfs_initialization_success() {
        let result = SQLiteDatabase::initialize_opfs().await;
        if result.is_err() {
            return;
        }
        assert!(
            result.is_ok(),
            "OPFS database initialization should succeed"
        );
        let db = result.unwrap();
        assert!(
            !db.db.is_null(),
            "Database pointer should not be null after initialization"
        );
    }

    async fn get_test_db() -> Option<SQLiteDatabase> {
        (SQLiteDatabase::initialize_opfs().await).ok()
    }

    #[wasm_bindgen_test]
    async fn test_create_table_and_insert() {
        let Some(db) = get_test_db().await else {
            return;
        };

        let create_result = db
            .exec("CREATE TABLE test_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)")
            .await;
        assert!(
            create_result.is_ok(),
            "CREATE TABLE should execute successfully"
        );
        assert!(
            create_result.unwrap().contains("Rows affected: 0"),
            "CREATE TABLE should report 0 rows affected"
        );

        let insert_result = db
            .exec("INSERT INTO test_users (name, age) VALUES ('Alice', 25)")
            .await;
        assert!(
            insert_result.is_ok(),
            "INSERT statement should execute successfully"
        );
        assert!(
            insert_result.unwrap().contains("Rows affected: 1"),
            "INSERT should report 1 row affected"
        );
    }

    #[wasm_bindgen_test]
    async fn test_select_query_with_results() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_products (id INTEGER PRIMARY KEY, name TEXT, price REAL)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_products (name, price) VALUES ('Laptop', 999.99)")
            .await
            .expect("Insert failed");
        db.exec("INSERT INTO test_products (name, price) VALUES ('Mouse', 25.50)")
            .await
            .expect("Insert failed");

        let result = db.exec("SELECT * FROM test_products ORDER BY id").await;
        assert!(result.is_ok(), "SELECT query should execute successfully");

        let json_str = result.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        assert_eq!(array.len(), 2, "Should return exactly 2 rows");

        let first = &array[0];
        assert_eq!(
            first["name"].as_str().unwrap(),
            "Laptop",
            "First product name should be 'Laptop'"
        );
        assert_eq!(
            first["price"].as_f64().unwrap(),
            999.99,
            "First product price should be 999.99"
        );

        let second = &array[1];
        assert_eq!(
            second["name"].as_str().unwrap(),
            "Mouse",
            "Second product name should be 'Mouse'"
        );
        assert_eq!(
            second["price"].as_f64().unwrap(),
            25.50,
            "Second product price should be 25.50"
        );
    }

    #[wasm_bindgen_test]
    async fn test_select_empty_result() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE empty_table (id INTEGER)")
            .await
            .expect("Create failed");

        let result = db.exec("SELECT * FROM empty_table").await;
        assert!(
            result.is_ok(),
            "SELECT from empty table should execute successfully"
        );
        assert_eq!(
            result.unwrap(),
            "[]",
            "Empty SELECT should return empty JSON array"
        );
    }

    #[wasm_bindgen_test]
    async fn test_integer_column_handling() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_ints (small_int INTEGER, big_int INTEGER)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_ints VALUES (42, 9223372036854775807)")
            .await
            .expect("Insert failed");

        let result = db
            .exec("SELECT * FROM test_ints")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        let row = &array[0];

        assert_eq!(
            row["small_int"].as_i64().unwrap(),
            42,
            "Small integer should be 42"
        );
        assert_eq!(
            row["big_int"].as_i64().unwrap(),
            9223372036854775807,
            "Large integer should be max i64 value"
        );
    }

    #[wasm_bindgen_test]
    async fn test_float_column_handling() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_floats (pi REAL, negative REAL)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_floats VALUES (3.14159, -2.71828)")
            .await
            .expect("Insert failed");

        let result = db
            .exec("SELECT * FROM test_floats")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        let row = &array[0];

        assert!(
            (row["pi"].as_f64().unwrap() - std::f64::consts::PI).abs() < 0.00001,
            "Pi should be approximately 3.14159"
        );
        assert!(
            (row["negative"].as_f64().unwrap() - (-std::f64::consts::E)).abs() < 0.00001,
            "Negative float should be approximately -2.71828"
        );
    }

    #[wasm_bindgen_test]
    async fn test_text_column_handling() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_text (message TEXT, empty TEXT, null_val TEXT)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_text VALUES ('Hello World', '', NULL)")
            .await
            .expect("Insert failed");

        let result = db
            .exec("SELECT * FROM test_text")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        let row = &array[0];

        assert_eq!(
            row["message"].as_str().unwrap(),
            "Hello World",
            "Text column should contain 'Hello World'"
        );
        assert_eq!(
            row["empty"].as_str().unwrap(),
            "",
            "Empty text column should be empty string"
        );
        assert!(
            row["null_val"].is_null(),
            "NULL text column should be null in JSON"
        );
    }

    #[wasm_bindgen_test]
    async fn test_blob_column_handling() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_blob (data BLOB)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_blob VALUES (X'48656C6C6F')")
            .await
            .expect("Insert failed");

        let result = db
            .exec("SELECT * FROM test_blob")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        let row = &array[0];

        let blob_str = row["data"].as_str().unwrap();
        assert!(
            blob_str.starts_with("<blob"),
            "BLOB data should start with '<blob'"
        );
        assert!(
            blob_str.contains("bytes>"),
            "BLOB data should contain 'bytes>''"
        );
    }

    #[wasm_bindgen_test]
    async fn test_column_names_handling() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_cols (id INTEGER, full_name TEXT, \"quoted col\" INTEGER)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_cols VALUES (1, 'John Doe', 100)")
            .await
            .expect("Insert failed");

        let result = db
            .exec("SELECT * FROM test_cols")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        let row = &array[0];

        assert!(row.get("id").is_some(), "Should have 'id' column");
        assert!(
            row.get("full_name").is_some(),
            "Should have 'full_name' column"
        );
        assert!(
            row.get("quoted col").is_some(),
            "Should have 'quoted col' column with spaces"
        );
        assert_eq!(
            row["full_name"].as_str().unwrap(),
            "John Doe",
            "full_name should be 'John Doe'"
        );
    }

    #[wasm_bindgen_test]
    async fn test_update_query() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_update (id INTEGER, value INTEGER)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_update VALUES (1, 10), (2, 20), (3, 30)")
            .await
            .expect("Insert failed");

        let result = db
            .exec("UPDATE test_update SET value = value * 2 WHERE id > 1")
            .await;
        assert!(result.is_ok());
        let update_result = result.unwrap();
        assert!(
            update_result.contains("Rows affected: 2"),
            "UPDATE should affect exactly 2 rows"
        );

        let select_result = db
            .exec("SELECT value FROM test_update ORDER BY id")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&select_result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");

        assert_eq!(
            array[0]["value"].as_i64().unwrap(),
            10,
            "First row value should remain 10"
        );
        assert_eq!(
            array[1]["value"].as_i64().unwrap(),
            40,
            "Second row value should be doubled to 40"
        );
        assert_eq!(
            array[2]["value"].as_i64().unwrap(),
            60,
            "Third row value should be doubled to 60"
        );
    }

    #[wasm_bindgen_test]
    async fn test_delete_query() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE test_delete (id INTEGER, name TEXT)")
            .await
            .expect("Create failed");
        db.exec("INSERT INTO test_delete VALUES (1, 'keep'), (2, 'delete'), (3, 'delete')")
            .await
            .expect("Insert failed");

        let result = db
            .exec("DELETE FROM test_delete WHERE name = 'delete'")
            .await;
        assert!(result.is_ok());
        let delete_result = result.unwrap();
        assert!(
            delete_result.contains("Rows affected: 2"),
            "DELETE should affect exactly 2 rows"
        );

        let select_result = db
            .exec("SELECT COUNT(*) as count FROM test_delete")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&select_result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        assert_eq!(
            array[0]["count"].as_i64().unwrap(),
            1,
            "Should have exactly 1 row remaining after delete"
        );
    }

    #[wasm_bindgen_test]
    async fn test_invalid_sql_syntax_error() {
        let Some(db) = get_test_db().await else {
            return;
        };

        let result = db.exec("INVALID SQL SYNTAX HERE").await;
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(
            error.contains("Failed to prepare statement"),
            "Invalid SQL should produce prepare statement error"
        );
    }

    #[wasm_bindgen_test]
    async fn test_sql_with_null_byte_error() {
        let Some(db) = get_test_db().await else {
            return;
        };

        let result = db.exec("SELECT * FROM table\0WITH NULL").await;
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(
            error.contains("Invalid SQL string"),
            "SQL with null bytes should produce invalid string error"
        );
    }

    #[wasm_bindgen_test]
    async fn test_table_not_found_error() {
        let Some(db) = get_test_db().await else {
            return;
        };

        let result = db.exec("SELECT * FROM nonexistent_table").await;
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(
            error.contains("Query execution failed") || error.contains("no such table"),
            "Query on nonexistent table should fail with appropriate error"
        );
    }

    #[wasm_bindgen_test]
    async fn test_custom_functions_available() {
        let Some(db) = get_test_db().await else {
            return;
        };

        let result = db.exec("SELECT float_add('1.5', '2.5') as result").await;
        assert!(result.is_ok());

        let json_str = result.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        let row = &array[0];

        assert!(
            row.get("result").is_some(),
            "Custom function should return a result"
        );
    }

    #[wasm_bindgen_test]
    async fn test_database_drop_cleanup() {
        {
            let Some(db) = get_test_db().await else {
                return;
            };
            assert!(
                !db.db.is_null(),
                "Database pointer should be valid before drop"
            );
        }
    }

    #[wasm_bindgen_test]
    async fn test_multiple_statements_handling() {
        let Some(db) = get_test_db().await else {
            return;
        };

        let result = db
            .exec("CREATE TABLE multi_test (id INTEGER); INSERT INTO multi_test VALUES (1);")
            .await;
        assert!(
            result.is_ok(),
            "Multiple statements should execute successfully"
        );
    }

    #[wasm_bindgen_test]
    async fn test_sequential_database_operations() {
        let Some(db) = get_test_db().await else {
            return;
        };

        db.exec("CREATE TABLE sequential_test (id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .expect("Create failed");

        let insert1 = db
            .exec("INSERT INTO sequential_test (value) VALUES ('first')")
            .await;
        let insert2 = db
            .exec("INSERT INTO sequential_test (value) VALUES ('second')")
            .await;

        assert!(insert1.is_ok(), "First INSERT should succeed");
        assert!(insert2.is_ok(), "Second INSERT should succeed");

        let result = db
            .exec("SELECT COUNT(*) as count FROM sequential_test")
            .await
            .expect("Select failed");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("Invalid JSON");
        let array = parsed.as_array().expect("Should be array");
        assert_eq!(
            array[0]["count"].as_i64().unwrap(),
            2,
            "Should have exactly 2 rows after sequential inserts"
        );
    }
}
