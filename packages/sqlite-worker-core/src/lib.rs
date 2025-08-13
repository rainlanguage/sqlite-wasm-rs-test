use wasm_bindgen::prelude::*;

mod coordination;
mod database;
mod database_functions;
mod messages;
mod worker;

// Export the worker entry point
#[wasm_bindgen]
pub fn worker_main() {
    console_error_panic_hook::set_once();
    let _ = worker::main();
}

// Re-export modules that might be needed
pub use coordination::*;
pub use database::*;
pub use messages::*;

#[cfg(test)]
mod tests {
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn worker_main_does_not_panic() {}
}
