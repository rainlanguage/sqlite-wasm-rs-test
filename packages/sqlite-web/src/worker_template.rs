/// Generate self-contained worker with embedded WASM and JS glue code
pub fn generate_self_contained_worker() -> String {
    // Use the bundled worker template with embedded WASM
    include_str!("embedded_worker.js").to_string()
}
