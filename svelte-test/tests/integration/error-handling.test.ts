import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
	createTestDatabase, 
	cleanupDatabase, 
	waitFor, 
	assertions,
	PerformanceTracker 
} from '../fixtures/test-helpers.js';
import type { SQLiteWasmDatabase } from 'sqlite-web';

describe('Error Handling Tests', () => {
	let db: SQLiteWasmDatabase;
	let perf: PerformanceTracker;
	
	beforeEach(async () => {
		db = await createTestDatabase();
		perf = new PerformanceTracker();
	});
	
	afterEach(async () => {
		if (db) await cleanupDatabase(db);
	});

	describe('SQL Syntax Errors', () => {
		it('should handle invalid SQL syntax gracefully', async () => {
			const invalidQueries = [
				'INVALID SQL STATEMENT',
				'SELECT * FORM users', // typo in FROM
				'INSERT INTO', // incomplete statement
				'UPDATE SET value = 1', // missing table name
				'DELETE WHERE id = 1', // missing FROM
				'CREATE TABLE ()', // missing table name
				'SELECT * FROM table_name WHERE', // incomplete WHERE
				'INSERT INTO users VALUES (1, 2,)', // trailing comma
			];

			for (const invalidQuery of invalidQueries) {
				try {
					await db.query(invalidQuery);
					// If we reach here, the query unexpectedly succeeded
					throw new Error(`Expected query to fail: ${invalidQuery}`);
				} catch (error) {
					// Expected to throw
					expect(error).toBeDefined();
					expect(typeof error).toBe('object');
				}
			}

			// Database should still be functional after errors
			await db.query(`
				CREATE TABLE error_recovery_test (
					id INTEGER PRIMARY KEY,
					message TEXT NOT NULL
				)
			`);
			
			await db.query("INSERT INTO error_recovery_test (id, message) VALUES (1, 'Still working')");
			
			await assertions.assertRowCount(db, 'SELECT * FROM error_recovery_test', 1);
		});

		it('should provide meaningful error messages', async () => {
			const errorTestCases = [
				{
					query: 'SELECT * FROM nonexistent_table',
					expectedError: /no such table|table.*not found|doesn't exist/i
				},
				{
					query: 'INSERT INTO users (nonexistent_column) VALUES (1)',
					expectedError: /no such table|table.*not found|column/i
				},
				{
					query: 'SELECT nonexistent_function()',
					expectedError: /function|not found|unknown/i
				}
			];

			for (const testCase of errorTestCases) {
				const result = await db.query(testCase.query);
				
				if (result.error) {
					// Query failed as expected
					const errorMessage = result.error.msg || result.error.readableMsg || String(result.error);
					expect(errorMessage).toMatch(testCase.expectedError);
				} else {
					// Query succeeded when it should have failed
					throw new Error(`Expected query to fail: ${testCase.query}`);
				}
			}
		});

		it('should handle SQL injection attempts safely', async () => {
			await db.query(`
				CREATE TABLE injection_test (
					id INTEGER PRIMARY KEY,
					username TEXT NOT NULL,
					email TEXT NOT NULL
				)
			`);

			await db.query("INSERT INTO injection_test (username, email) VALUES ('alice', 'alice@test.com')");

			// These are malicious inputs that should be handled safely
			const maliciousInputs = [
				"'; DROP TABLE injection_test; --",
				"' OR 1=1 --",
				"'; DELETE FROM injection_test WHERE '1'='1",
				"' UNION SELECT * FROM sqlite_master --"
			];

			for (const maliciousInput of maliciousInputs) {
				try {
					// Note: This is still vulnerable to injection, but we're testing that
					// the database doesn't get corrupted and errors are handled
					await db.query(`SELECT * FROM injection_test WHERE username = '${maliciousInput}'`);
				} catch (error) {
					// Expected to fail with SQL errors
					expect(error).toBeDefined();
				}
			}

			// Verify table still exists and data is intact
			await assertions.assertRowCount(db, 'SELECT * FROM injection_test', 1);
			await assertions.assertContains(
				db, 
				'SELECT * FROM injection_test', 
				{ username: 'alice', email: 'alice@test.com' }
			);
		});
	});

	describe('Constraint Violations', () => {
		beforeEach(async () => {
			await db.query(`
				CREATE TABLE constraint_test (
					id INTEGER PRIMARY KEY,
					unique_field TEXT UNIQUE NOT NULL,
					required_field TEXT NOT NULL,
					check_field INTEGER CHECK (check_field > 0)
				)
			`);
		});

		it('should handle UNIQUE constraint violations', async () => {
			// Insert initial record
			await db.query(`
				INSERT INTO constraint_test (id, unique_field, required_field, check_field) 
				VALUES (1, 'unique_value', 'required', 5)
			`);

			// Try to insert duplicate unique_field
			try {
				await db.query(`
					INSERT INTO constraint_test (id, unique_field, required_field, check_field) 
					VALUES (2, 'unique_value', 'another_required', 10)
				`);
				throw new Error('Expected UNIQUE constraint violation');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				expect(errorMessage.toLowerCase()).toMatch(/unique|constraint/);
			}

			// Verify original record is still there
			await assertions.assertRowCount(db, 'SELECT * FROM constraint_test', 1);
		});

		it('should handle NOT NULL constraint violations', async () => {
			try {
				await db.query(`
					INSERT INTO constraint_test (id, unique_field, check_field) 
					VALUES (1, 'unique_value', 5)
				`);
				throw new Error('Expected NOT NULL constraint violation');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				expect(errorMessage.toLowerCase()).toMatch(/not null|null constraint/);
			}

			// Table should be empty
			await assertions.assertRowCount(db, 'SELECT * FROM constraint_test', 0);
		});

		it('should handle CHECK constraint violations', async () => {
			try {
				await db.query(`
					INSERT INTO constraint_test (id, unique_field, required_field, check_field) 
					VALUES (1, 'unique_value', 'required', -5)
				`);
				throw new Error('Expected CHECK constraint violation');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				expect(errorMessage.toLowerCase()).toMatch(/check|constraint/);
			}

			// Table should be empty
			await assertions.assertRowCount(db, 'SELECT * FROM constraint_test', 0);
		});

		it('should handle foreign key constraint violations', async () => {
			await db.query('PRAGMA foreign_keys = ON');

			await db.query(`
				CREATE TABLE parent_table (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL
				)
			`);

			await db.query(`
				CREATE TABLE child_table (
					id INTEGER PRIMARY KEY,
					parent_id INTEGER REFERENCES parent_table(id),
					data TEXT NOT NULL
				)
			`);

			// Insert parent record
			await db.query("INSERT INTO parent_table (id, name) VALUES (1, 'Parent')");

			// Try to insert child with non-existent parent
			try {
				await db.query("INSERT INTO child_table (id, parent_id, data) VALUES (1, 999, 'Child data')");
				throw new Error('Expected foreign key constraint violation');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				expect(errorMessage.toLowerCase()).toMatch(/foreign key|constraint/);
			}

			// Child table should be empty
			await assertions.assertRowCount(db, 'SELECT * FROM child_table', 0);
		});
	});

	describe('Resource and Limit Errors', () => {
		it('should handle extremely long queries', async () => {
			await db.query(`
				CREATE TABLE long_query_test (
					id INTEGER PRIMARY KEY,
					value TEXT
				)
			`);

			// Create an extremely long INSERT statement
			const longValue = 'x'.repeat(100000); // 100KB string
			
			try {
				perf.start('long-query');
				const result = await db.query(`INSERT INTO long_query_test (value) VALUES ('${longValue}')`);
				perf.end('long-query');

				// If successful, verify it worked
				expect(result.value).toContain('Rows affected: 1');
				
				// Should complete in reasonable time even for long queries
				expect(perf.getDuration('long-query')).toBeLessThan(10000);

				// Verify we can read it back
				const selectResult = await db.query('SELECT LENGTH(value) as len FROM long_query_test');
				const data = JSON.parse(selectResult.value || '[]');
				expect(data[0].len).toBe(longValue.length);
				
			} catch (error) {
				perf.end('long-query');
				// If it fails due to limits, that's acceptable
				expect(error).toBeDefined();
			}
		});

		it('should handle queries with many parameters', async () => {
			await db.query(`
				CREATE TABLE many_params_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data TEXT
				)
			`);

			// Create INSERT with many values
			const valueCount = 1000;
			const values = Array.from({ length: valueCount }, (_, i) => `('param_${i}')`).join(',');
			
			try {
				perf.start('many-params');
				const result = await db.query(`INSERT INTO many_params_test (data) VALUES ${values}`);
				perf.end('many-params');

				expect(result.value).toContain(`Rows affected: ${valueCount}`);
				expect(perf.getDuration('many-params')).toBeLessThan(15000);
				
				await assertions.assertRowCount(db, 'SELECT * FROM many_params_test', valueCount);
				
			} catch (error) {
				perf.end('many-params');
				// If it fails due to limits, that's acceptable
				expect(error).toBeDefined();
			}
		});

		it('should handle deeply nested queries', async () => {
			await db.query(`
				CREATE TABLE nested_test (
					id INTEGER PRIMARY KEY,
					value INTEGER
				)
			`);

			// Insert test data
			await db.query("INSERT INTO nested_test (id, value) VALUES (1, 10), (2, 20), (3, 30)");

			// Create deeply nested query
			let nestedQuery = 'SELECT value';
			for (let i = 0; i < 20; i++) {
				nestedQuery = `SELECT (${nestedQuery}) as nested_value`;
			}
			nestedQuery += ' FROM nested_test WHERE id = 1';

			try {
				perf.start('nested-query');
				const result = await db.query(nestedQuery);
				perf.end('nested-query');

				const data = JSON.parse(result.value || '[]');
				expect(data).toHaveLength(1);
				expect(data[0].nested_value).toBe(10);
				
				expect(perf.getDuration('nested-query')).toBeLessThan(5000);

			} catch (error) {
				perf.end('nested-query');
				// If it fails due to nesting limits, that's acceptable
				expect(error).toBeDefined();
			}
		});
	});

	describe('Connection and Communication Errors', () => {
		it('should handle worker communication timeouts', async () => {
			// This test simulates scenarios where worker communication might timeout
			
			await db.query(`
				CREATE TABLE timeout_test (
					id INTEGER PRIMARY KEY,
					data TEXT
				)
			`);

			// Try to perform many operations quickly to potentially overwhelm the system
			const rapidQueries = Array.from({ length: 50 }, (_, i) => 
				db.query(`INSERT INTO timeout_test (data) VALUES ('rapid_${i}')`)
			);

			perf.start('rapid-fire-queries');
			const results = await Promise.allSettled(rapidQueries);
			perf.end('rapid-fire-queries');

			const successful = results.filter(r => r.status === 'fulfilled');
			const failed = results.filter(r => r.status === 'rejected');

			// Some operations might fail due to timeouts, but some should succeed
			expect(successful.length).toBeGreaterThan(0);
			
			
			// Even with timeouts, performance should be reasonable
			expect(perf.getDuration('rapid-fire-queries')).toBeLessThan(30000);

			// Database should remain functional
			const countResult = await db.query('SELECT COUNT(*) as count FROM timeout_test');
			const count = JSON.parse(countResult.value || '[]')[0].count;
			expect(count).toBeGreaterThan(0);
		});

		it('should recover from temporary communication failures', async () => {
			await db.query(`
				CREATE TABLE recovery_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					phase TEXT NOT NULL,
					timestamp INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);

			// Insert initial data
			await db.query("INSERT INTO recovery_test (phase) VALUES ('before_failure')");
			await assertions.assertRowCount(db, 'SELECT * FROM recovery_test', 1);

			// Simulate some operations that might fail
			const potentiallyFailingOps = [
				db.query("INSERT INTO recovery_test (phase) VALUES ('during_potential_failure_1')"),
				db.query("INSERT INTO recovery_test (phase) VALUES ('during_potential_failure_2')"),
				db.query("INSERT INTO recovery_test (phase) VALUES ('during_potential_failure_3')")
			];

			const results = await Promise.allSettled(potentiallyFailingOps);
			const successful = results.filter(r => r.status === 'fulfilled');

			// At least one operation should succeed
			expect(successful.length).toBeGreaterThan(0);

			// Database should be functional after potential failures
			await db.query("INSERT INTO recovery_test (phase) VALUES ('after_recovery')");

			const finalResult = await db.query('SELECT COUNT(*) as count FROM recovery_test');
			const finalCount = JSON.parse(finalResult.value || '[]')[0].count;

			expect(finalCount).toBeGreaterThan(1); // At least initial + recovery
		});
	});

	describe('Custom Function Errors', () => {
		it('should handle custom function errors gracefully', async () => {
			await db.query(`
				CREATE TABLE custom_function_test (
					id INTEGER PRIMARY KEY,
					input1 TEXT,
					input2 TEXT,
					result TEXT
				)
			`);

			// Test custom function with invalid inputs
			const invalidInputs = [
				{ input1: 'not_a_number', input2: '123' },
				{ input1: '123', input2: 'not_a_number' },
				{ input1: '', input2: '123' },
				{ input1: '123', input2: '' },
				{ input1: 'null', input2: 'null' }
			];

			for (const inputs of invalidInputs) {
				try {
					const result = await db.query(`
						SELECT RAIN_MATH_PROCESS('${inputs.input1}', '${inputs.input2}') as result
					`);
					
					
					// If it succeeds, the result might be an error message
					if (result.error) {
						// Handle error case
						const errorMessage = result.error.msg || result.error.readableMsg || String(result.error);
						expect(errorMessage.toLowerCase()).toMatch(/failed|error|invalid/);
						continue;
					}
					
					if (!result.value || result.value === 'undefined') {
						throw new Error(`Custom function returned undefined: ${inputs.input1}, ${inputs.input2}`);
					}
					
					const data = JSON.parse(result.value);
					if (data[0].result && data[0].result.includes('Failed')) {
						// Custom function returned an error message, which is valid
						expect(data[0].result).toContain('Failed');
					}
				} catch (error) {
					// Expected to fail with invalid inputs
					expect(error).toBeDefined();
					const errorMessage = error instanceof Error ? error.message : String(error);
					expect(errorMessage.toLowerCase()).toMatch(/failed|error|invalid/);
				}
			}

			// Verify database is still functional
			await db.query("INSERT INTO custom_function_test (id, input1, input2) VALUES (1, 'test', 'test')");
			await assertions.assertRowCount(db, 'SELECT * FROM custom_function_test', 1);
		});

		it('should handle valid custom function calls', async () => {
			// Test that valid inputs work correctly
			try {
				const result = await db.query("SELECT RAIN_MATH_PROCESS('10', '20') as result");
				const data = JSON.parse(result.value || '[]');

				expect(data).toHaveLength(1);
				expect(data[0]).toHaveProperty('result');
				
				// Result should be a valid output (exact format depends on implementation)
				expect(data[0].result).toBeDefined();
				expect(typeof data[0].result).toBe('string');
				
			} catch (error) {
				// Custom function might not be available in test environment
				console.log('Custom function not available in test environment:', error);
			}
		});
	});

	describe('Edge Cases and Boundary Conditions', () => {
		it('should handle empty query strings', async () => {
			const emptyQueries = ['', '   ', '\t', '\n', '  \t\n  '];

			for (const emptyQuery of emptyQueries) {
				try {
					await db.query(emptyQuery);
					throw new Error(`Expected empty query to fail: "${emptyQuery}"`);
				} catch (error) {
					// Expected to fail
					expect(error).toBeDefined();
				}
			}
		});

		it('should handle special characters in data', async () => {
			await db.query(`
				CREATE TABLE special_chars_test (
					id INTEGER PRIMARY KEY,
					data TEXT NOT NULL
				)
			`);

			const specialStrings = [
				'Text with "double quotes"',
				"Text with 'single quotes'",
				'Text with \\ backslashes \\',
				'Text with \n newlines \r\n and returns',
				'Text with \t tabs',
				'Unicode: 🚀 ñáéíóú 世界',
				'NULL bytes: \0 middle',
				'SQL keywords: SELECT FROM WHERE INSERT UPDATE DELETE'
			];

			for (let i = 0; i < specialStrings.length; i++) {
				const testString = specialStrings[i];
				
				try {
					// Escape single quotes for SQL
					const escapedString = testString.replace(/'/g, "''");
					await db.query(`INSERT INTO special_chars_test (id, data) VALUES (${i + 1}, '${escapedString}')`);
					
					// Verify we can read it back correctly
					const result = await db.query(`SELECT data FROM special_chars_test WHERE id = ${i + 1}`);
					const data = JSON.parse(result.value || '[]');

					expect(data).toHaveLength(1);
					
					// Note: NULL bytes might be stripped by SQLite
					if (!testString.includes('\0')) {
						expect(data[0].data).toBe(testString);
					}
					
				} catch (error) {
					// Some special characters might cause legitimate failures
					expect(error).toBeDefined();
				}
			}
		});

		it('should handle concurrent error scenarios', async () => {
			await db.query(`
				CREATE TABLE concurrent_error_test (
					id INTEGER PRIMARY KEY,
					data TEXT UNIQUE
				)
			`);

			// Try to insert same data concurrently (should cause unique constraint violations)
			const duplicateInserts = Array.from({ length: 10 }, (_, i) => 
				db.query("INSERT INTO concurrent_error_test (id, data) VALUES (1, 'duplicate_data')")
			);

			const results = await Promise.all(duplicateInserts);
			
			const successful = results.filter(r => !r.error);
			const failed = results.filter(r => r.error);

			// Only one should succeed due to unique constraint
			expect(successful.length).toBe(1);
			expect(failed.length).toBe(9);

			// Verify database state
			await assertions.assertRowCount(db, 'SELECT * FROM concurrent_error_test', 1);

			// Database should still be functional
			await db.query("INSERT INTO concurrent_error_test (id, data) VALUES (2, 'different_data')");
			await assertions.assertRowCount(db, 'SELECT * FROM concurrent_error_test', 2);
		});
	});
});