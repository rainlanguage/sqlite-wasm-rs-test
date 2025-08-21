use alloy::primitives::U256;
use rain_math_float::Float;
use sqlite_wasm_rs::export::*;
use std::ffi::{c_int, CStr, CString};
use std::ops::Add;
use std::os::raw::c_char;
use std::str::FromStr;

// Custom function using rain-math-float library - sums two Float values
unsafe extern "C" fn rain_math_process(
    context: *mut sqlite3_context,
    argc: c_int,
    argv: *mut *mut sqlite3_value,
) {
    if argc != 2 {
        sqlite3_result_error(
            context,
            c"rain_math_process() requires exactly 2 arguments".as_ptr(),
            -1,
        );
        return;
    }

    // Get first parameter
    let input1 = sqlite3_value_text(*argv);
    if input1.is_null() {
        sqlite3_result_null(context);
        return;
    }
    let input1_str = CStr::from_ptr(input1 as *const c_char).to_string_lossy();

    // Get second parameter
    let input2 = sqlite3_value_text(*argv.offset(1));
    if input2.is_null() {
        sqlite3_result_null(context);
        return;
    }
    let input2_str = CStr::from_ptr(input2 as *const c_char).to_string_lossy();

    let input1_u256 = match U256::from_str(&input1_str) {
        Ok(u) => u,
        Err(e) => {
            let error_msg = format!("Failed to parse first argument as U256: {e}\0");
            sqlite3_result_error(context, error_msg.as_ptr() as *const c_char, -1);
            return;
        }
    };

    // Convert strings to Float using rain-math-float
    let float1 = match Float::from_hex(&format!("{input1_u256:#066x}")) {
        Ok(f) => f,
        Err(e) => {
            let error_msg = format!("Failed to parse first argument as Float: {e}\0");
            sqlite3_result_error(context, error_msg.as_ptr() as *const c_char, -1);
            return;
        }
    };

    let input2_u256 = match U256::from_str(&input2_str) {
        Ok(u) => u,
        Err(e) => {
            let error_msg = format!("Failed to parse second argument as U256: {e}\0");
            sqlite3_result_error(context, error_msg.as_ptr() as *const c_char, -1);
            return;
        }
    };

    let float2 = match Float::from_hex(&format!("{input2_u256:#066x}")) {
        Ok(f) => f,
        Err(e) => {
            let error_msg = format!("Failed to parse second argument as Float: {e}\0");
            sqlite3_result_error(context, error_msg.as_ptr() as *const c_char, -1);
            return;
        }
    };

    // Sum the two Float values
    let result = match float1.add(float2) {
        Ok(r) => r,
        Err(e) => {
            let error_msg = format!("Failed to add Float values: {e}\0");
            sqlite3_result_error(context, error_msg.as_ptr() as *const c_char, -1);
            return;
        }
    };

    // Convert result back to string
    let result_str = match result.format() {
        Ok(s) => s,
        Err(e) => {
            let error_msg = format!("Failed to format result as string: {e}\0");
            sqlite3_result_error(context, error_msg.as_ptr() as *const c_char, -1);
            return;
        }
    };
    let result_cstring = CString::new(result_str).unwrap();

    sqlite3_result_text(
        context,
        result_cstring.as_ptr(),
        result_cstring.as_bytes().len() as c_int,
        Some(std::mem::transmute::<
            isize,
            unsafe extern "C" fn(*mut std::ffi::c_void),
        >(-1isize)), // SQLITE_TRANSIENT
    );
}

/// Register all custom functions with the SQLite database
pub fn register_custom_functions(db: *mut sqlite3) -> Result<(), String> {
    // Register rain_math_process function
    let func_name = CString::new("RAIN_MATH_PROCESS").unwrap();
    let ret = unsafe {
        sqlite3_create_function_v2(
            db,
            func_name.as_ptr(),
            2, // 2 arguments
            SQLITE_UTF8,
            std::ptr::null_mut(),
            Some(rain_math_process),
            None, // No xStep for scalar function
            None, // No xFinal for scalar function
            None, // No destructor
        )
    };

    if ret != SQLITE_OK {
        return Err("Failed to register RAIN_MATH_PROCESS function".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::*;

    wasm_bindgen_test_configure!(run_in_browser);

    #[wasm_bindgen_test]
    fn test_u256_hex_conversion() {
        let test_value = U256::from(12345u64);
        let hex_str = format!("{test_value:#066x}");

        assert_eq!(hex_str.len(), 66);
        assert!(hex_str.starts_with("0x"));
        assert!(hex_str.contains("3039")); // 12345 in hex is 0x3039
    }

    #[wasm_bindgen_test]
    fn test_u256_from_string_valid() {
        let result = U256::from_str("12345");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), U256::from(12345u64));
    }

    #[wasm_bindgen_test]
    fn test_u256_from_string_invalid() {
        let result = U256::from_str("not_a_number");
        assert!(result.is_err());
    }

    #[wasm_bindgen_test]
    fn test_u256_from_hex_string() {
        let result = U256::from_str("0x3039");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), U256::from(12345u64));
    }

    #[wasm_bindgen_test]
    fn test_rain_float_integration_valid_inputs() {
        let u256_val = U256::from(42u64);
        let hex_str = format!("{u256_val:#066x}");

        let float_result = Float::from_hex(&hex_str);
        assert!(
            float_result.is_ok(),
            "Should be able to create Float from valid hex"
        );
    }

    #[wasm_bindgen_test]
    fn test_rain_float_integration_invalid_hex() {
        let invalid_hex = "0xinvalid";
        let float_result = Float::from_hex(invalid_hex);
        assert!(float_result.is_err(), "Should fail for invalid hex string");
    }

    #[wasm_bindgen_test]
    fn test_rain_float_addition() {
        let val1 = U256::from(10u64);
        let val2 = U256::from(20u64);

        let hex1 = format!("{val1:#066x}");
        let hex2 = format!("{val2:#066x}");

        let float1 = Float::from_hex(&hex1).expect("Should create float1");
        let float2 = Float::from_hex(&hex2).expect("Should create float2");

        let result = float1.add(float2);
        assert!(result.is_ok(), "Float addition should succeed");

        let formatted = result.unwrap().format();
        assert!(formatted.is_ok(), "Should be able to format result");
        assert_eq!(formatted.unwrap(), "30", "Result should be 30");
    }

    #[wasm_bindgen_test]
    fn test_error_messages_for_edge_cases() {
        let max_u256 = U256::MAX;
        let hex_str = format!("{max_u256:#066x}");

        let float_result = Float::from_hex(&hex_str);
        assert!(float_result.is_ok(), "MAX U256 should be valid for Float");
    }

    #[wasm_bindgen_test]
    fn test_cstring_conversion() {
        let test_string = "test string with spaces and symbols!@#$%";
        let c_string_result = CString::new(test_string);
        assert!(
            c_string_result.is_ok(),
            "Should be able to convert to CString"
        );

        let c_string = c_string_result.unwrap();
        assert_eq!(c_string.to_string_lossy(), test_string);
    }

    #[wasm_bindgen_test]
    fn test_cstring_with_null_bytes() {
        let string_with_null = "test\0string";
        let c_string_result = CString::new(string_with_null);
        assert!(
            c_string_result.is_err(),
            "Strings with null bytes should fail CString conversion"
        );
    }
}
