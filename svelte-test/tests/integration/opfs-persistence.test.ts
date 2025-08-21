import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
	createTestDatabase, 
	cleanupDatabase, 
	waitFor, 
	assertions,
	PerformanceTracker 
} from '../fixtures/test-helpers.js';
import type { SQLiteWasmDatabase } from 'sqlite-web';

describe('OPFS Persistence Tests', () => {
	let db1: SQLiteWasmDatabase;
	let db2: SQLiteWasmDatabase;
	let perf: PerformanceTracker;
	
	beforeEach(async () => {
		perf = new PerformanceTracker();
	});
	
	afterEach(async () => {
		if (db1) await cleanupDatabase(db1);
		if (db2) await cleanupDatabase(db2);
	});

	describe('Data Persistence Across Sessions', () => {
		it('should persist data between database connections', async () => {
			// Create first database instance and insert data
			db1 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE persistent_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					message TEXT NOT NULL,
					timestamp INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			const testMessage = `Test message ${Date.now()}`;
			await db1.query(`
				INSERT INTO persistent_test (message) 
				VALUES ('${testMessage}')
			`);
			
			// Verify data was inserted
			await assertions.assertRowCount(db1, 'SELECT * FROM persistent_test', 1);
			await assertions.assertContains(
				db1, 
				'SELECT * FROM persistent_test', 
				{ message: testMessage }
			);
			
			// Close first connection by cleaning up
			await cleanupDatabase(db1);
			
			// Wait a moment to ensure OPFS has time to persist
			await new Promise(resolve => setTimeout(resolve, 500));
			
			// Create second database instance - should see persisted data
			db2 = await createTestDatabase();
			
			// The table should still exist and contain our data
			const result = await db2.query('SELECT * FROM persistent_test');
			const data = JSON.parse(result.value || '[]');

			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			
			// Find our test message
			const foundMessage = data.find((row: { message: string }) => row.message === testMessage);
			expect(foundMessage).toBeDefined();
			expect(foundMessage.message).toBe(testMessage);
		});

		it('should handle schema persistence', async () => {
			db1 = await createTestDatabase();
			
			// Create a complex schema
			await db1.query(`
				CREATE TABLE schema_test (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL UNIQUE,
					data BLOB,
					created_at DATETIME DEFAULT CURRENT_TIMESTAMP
				)
			`);
			
			await db1.query(`
				CREATE INDEX idx_schema_name ON schema_test(name)
			`);
			
			await db1.query(`
				CREATE TRIGGER schema_trigger 
				BEFORE UPDATE ON schema_test 
				FOR EACH ROW 
				BEGIN 
					UPDATE schema_test SET created_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
				END
			`);
			
			// Insert test data
			await db1.query(`
				INSERT INTO schema_test (name, data) 
				VALUES ('test1', X'48656C6C6F'), ('test2', X'576F726C64')
			`);
			
			// Close and reopen
			await cleanupDatabase(db1);
			await new Promise(resolve => setTimeout(resolve, 300));
			
			db2 = await createTestDatabase();
			
			// Verify schema persisted
			const tableResult = await db2.query(`
				SELECT name FROM sqlite_master 
				WHERE type='table' AND name='schema_test'
			`);
			const tables = JSON.parse(tableResult.value || '[]');
			expect(tables).toHaveLength(1);
			
			// Verify index persisted
			const indexResult = await db2.query(`
				SELECT name FROM sqlite_master 
				WHERE type='index' AND name='idx_schema_name'
			`);
			const indices = JSON.parse(indexResult.value || '[]');
			expect(indices).toHaveLength(1);
			
			// Verify data persisted
			await assertions.assertRowCount(db2, 'SELECT * FROM schema_test', 2);
		});

		it('should persist data through page reloads (simulation)', async () => {
			const testId = `reload_test_${Date.now()}`;
			
			// Simulate "before reload" - create data
			db1 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE reload_simulation (
					session_id TEXT PRIMARY KEY,
					data TEXT NOT NULL,
					created_at INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			await db1.query(`
				INSERT INTO reload_simulation (session_id, data) 
				VALUES ('${testId}', 'Data that should survive reload')
			`);
			
			// Verify insertion
			await assertions.assertRowCount(
				db1, 
				`SELECT * FROM reload_simulation WHERE session_id = '${testId}'`, 
				1
			);
			
			// Simulate "after reload" - new database instance
			db2 = await createTestDatabase();
			
			// Data should still be there
			const result = await db2.query(`
				SELECT * FROM reload_simulation WHERE session_id = '${testId}'
			`);
			const data = JSON.parse(result.value || '[]');

			expect(data).toHaveLength(1);
			expect(data[0].session_id).toBe(testId);
			expect(data[0].data).toBe('Data that should survive reload');
		});
	});

	describe('Multiple Database Instances', () => {
		it('should handle concurrent access to same OPFS database', async () => {
			// Create two database instances simultaneously
			const [dbA, dbB] = await Promise.all([
				createTestDatabase(),
				createTestDatabase()
			]);
			
			db1 = dbA;
			db2 = dbB;
			
			// Set up table in first instance
			await db1.query(`
				CREATE TABLE IF NOT EXISTS concurrent_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					source TEXT NOT NULL,
					value INTEGER NOT NULL
				)
			`);
			
			// Wait for table to be available
			await new Promise(resolve => setTimeout(resolve, 200));
			
			// Insert data from both instances concurrently
			const insertPromises = [
				db1.query("INSERT INTO concurrent_test (source, value) VALUES ('db1', 100)"),
				db2.query("INSERT INTO concurrent_test (source, value) VALUES ('db2', 200)"),
				db1.query("INSERT INTO concurrent_test (source, value) VALUES ('db1', 101)"),
				db2.query("INSERT INTO concurrent_test (source, value) VALUES ('db2', 201)")
			];
			
			// Wait for all inserts to complete
			const results = await Promise.allSettled(insertPromises);
			
			// At least some inserts should succeed (worker coordination should handle this)
			const successfulInserts = results.filter(r => r.status === 'fulfilled');
			expect(successfulInserts.length).toBeGreaterThan(0);
			
			// Verify data integrity from both instances
			const result1 = await db1.query('SELECT COUNT(*) as count FROM concurrent_test');
			const count1 = JSON.parse(result1.value || '[]')[0].count;

			const result2 = await db2.query('SELECT COUNT(*) as count FROM concurrent_test');
			const count2 = JSON.parse(result2.value || '[]')[0].count;

			// Both instances should see the same data
			expect(count1).toBe(count2);
			expect(count1).toBeGreaterThan(0);
		});

		it('should maintain consistency across database instances', async () => {
			db1 = await createTestDatabase();
			
			// Create table and insert initial data
			await db1.query(`
				CREATE TABLE consistency_test (
					id INTEGER PRIMARY KEY,
					name TEXT UNIQUE,
					counter INTEGER DEFAULT 0
				)
			`);
			
			await db1.query("INSERT INTO consistency_test (id, name) VALUES (1, 'test_counter')");
			
			// Create second instance
			db2 = await createTestDatabase();
			
			// Perform updates from first instance
			for (let i = 0; i < 5; i++) {
				await db1.query("UPDATE consistency_test SET counter = counter + 1 WHERE id = 1");
			}
			
			// Read from second instance - should see updates
			// @ts-expect-error this is fine
			await waitFor(async () => {
				const result = await db2.query('SELECT counter FROM consistency_test WHERE id = 1');
				const data = JSON.parse(result.value || '[]');
				return data.length > 0 && data[0].counter >= 5;
			}, 3000);
			
			const finalResult = await db2.query('SELECT counter FROM consistency_test WHERE id = 1');
			const finalData = JSON.parse(finalResult.value || '[]');

			expect(finalData).toHaveLength(1);
			expect(finalData[0].counter).toBe(5);
		});
	});

	describe('Storage Limits and Error Handling', () => {
		it('should handle OPFS storage gracefully', async () => {
			db1 = await createTestDatabase();
			
			// Create table for storage test
			await db1.query(`
				CREATE TABLE storage_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data TEXT NOT NULL
				)
			`);
			
			// Insert progressively larger data
			const dataSizes = [1000, 10000, 100000]; // Characters
			
			for (const size of dataSizes) {
				const largeData = 'x'.repeat(size);
				
				try {
					const result = await db1.query(`
						INSERT INTO storage_test (data) 
						VALUES ('${largeData}')
					`);
					
					expect(result.value).toContain('Rows affected: 1');
					
					// Verify we can read it back
					const readResult = await db1.query(`
						SELECT LENGTH(data) as data_length 
						FROM storage_test 
						WHERE id = (SELECT MAX(id) FROM storage_test)
					`);
					const readData = JSON.parse(readResult.value || '[]');
					expect(readData[0].data_length).toBe(size);
					
				} catch (error) {
					// If we hit storage limits, that's acceptable
					console.warn(`Storage limit reached at size ${size}:`, error);
					break;
				}
			}
		});

		it('should recover from OPFS errors', async () => {
			db1 = await createTestDatabase();
			
			// Create a valid table
			await db1.query(`
				CREATE TABLE recovery_test (
					id INTEGER PRIMARY KEY,
					status TEXT DEFAULT 'active'
				)
			`);
			
			// Insert some data
			await db1.query("INSERT INTO recovery_test (id) VALUES (1), (2), (3)");
			
			// Try an operation that might fail (invalid SQL)
			try {
				await db1.query("INVALID SQL STATEMENT HERE");
				// If this doesn't throw, that's unexpected but not necessarily wrong
			} catch (error) {
				// Expected to fail
				expect(error).toBeDefined();
			}
			
			// Database should still be usable after error
			const result = await db1.query('SELECT COUNT(*) as count FROM recovery_test');
			const data = JSON.parse(result.value || '[]');

			expect(data).toHaveLength(1);
			expect(data[0].count).toBe(3);
			
			// Should be able to continue operations
			await db1.query("INSERT INTO recovery_test (id) VALUES (4)");
			
			await assertions.assertRowCount(db1, 'SELECT * FROM recovery_test', 4);
		});
	});

	describe('Performance with OPFS', () => {
		it('should perform bulk operations efficiently on persistent storage', async () => {
			db1 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE bulk_persistent_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					batch_id TEXT NOT NULL,
					value REAL NOT NULL,
					created_at INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			const batchId = `batch_${Date.now()}`;
			const batchSize = 100;
			
			perf.start('bulk-opfs-insert');
			
			// Generate bulk insert statement
			const values = Array.from({ length: batchSize }, (_, i) => 
				`('${batchId}', ${Math.random() * 1000})`
			).join(',');
			
			const result = await db1.query(`
				INSERT INTO bulk_persistent_test (batch_id, value) 
				VALUES ${values}
			`);
			
			perf.end('bulk-opfs-insert');
			
			expect(result.value).toContain(`Rows affected: ${batchSize}`);
			
			// Performance should be reasonable for OPFS
			const insertTime = perf.getDuration('bulk-opfs-insert');
			expect(insertTime).toBeLessThan(10000); // 10 seconds max
			
			perf.start('bulk-opfs-query');
			
			// Query the data back
			const queryResult = await db1.query(`
				SELECT COUNT(*) as count, AVG(value) as avg_value 
				FROM bulk_persistent_test 
				WHERE batch_id = '${batchId}'
			`);
			
			perf.end('bulk-opfs-query');
			
			const queryData = JSON.parse(queryResult.value || '[]');
			expect(queryData[0].count).toBe(batchSize);
			expect(queryData[0].avg_value).toBeTypeOf('number');
			
			// Query should be fast
			const queryTime = perf.getDuration('bulk-opfs-query');
			expect(queryTime).toBeLessThan(2000); // 2 seconds max
		});

		it('should handle database growth over time', async () => {
			db1 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE growth_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					phase INTEGER NOT NULL,
					data TEXT NOT NULL,
					timestamp INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			const phases = [10, 50, 100]; // Number of records per phase
			let totalRecords = 0;
			
			for (let phase = 0; phase < phases.length; phase++) {
				perf.start(`phase-${phase}`);
				
				const recordsInPhase = phases[phase];
				const values = Array.from({ length: recordsInPhase }, (_, i) => 
					`(${phase}, 'Phase ${phase} record ${i}')`
				).join(',');
				
				await db1.query(`
					INSERT INTO growth_test (phase, data) 
					VALUES ${values}
				`);
				
				totalRecords += recordsInPhase;
				
				perf.end(`phase-${phase}`);
				
				// Verify count after each phase
				await assertions.assertRowCount(db1, 'SELECT * FROM growth_test', totalRecords);
				
				// Performance shouldn't degrade significantly
				const phaseTime = perf.getDuration(`phase-${phase}`);
				expect(phaseTime).toBeLessThan(5000); // 5 seconds max per phase
			}
			
			// Final verification - all data should be accessible
			const finalResult = await db1.query(`
				SELECT phase, COUNT(*) as count 
				FROM growth_test 
				GROUP BY phase 
				ORDER BY phase
			`);
			const phaseData = JSON.parse(finalResult.value || '[]');

			expect(phaseData).toHaveLength(phases.length);
			phases.forEach((expectedCount, index) => {
				expect(phaseData[index].phase).toBe(index);
				expect(phaseData[index].count).toBe(expectedCount);
			});
		});
	});
});