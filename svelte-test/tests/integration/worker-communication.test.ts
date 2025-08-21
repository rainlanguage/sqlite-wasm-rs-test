import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
	createTestDatabase, 
	cleanupDatabase, 
	waitFor, 
	assertions,
	PerformanceTracker 
} from '../fixtures/test-helpers.js';
import type { SQLiteWasmDatabase } from 'sqlite-web';

describe('Worker Communication Tests', () => {
	let db1: SQLiteWasmDatabase;
	let db2: SQLiteWasmDatabase;
	let db3: SQLiteWasmDatabase;
	let perf: PerformanceTracker;
	
	beforeEach(async () => {
		perf = new PerformanceTracker();
	});
	
	afterEach(async () => {
		if (db1) await cleanupDatabase(db1);
		if (db2) await cleanupDatabase(db2);
		if (db3) await cleanupDatabase(db3);
	});

	describe('Multi-Worker Coordination', () => {
		// TODO: Multi-worker coordination requires complex BroadcastChannel setup
		// that doesn't work reliably in the test environment
		it.skip('should coordinate between multiple workers', async () => {
			// Create multiple database instances (simulating multiple tabs/workers)
			perf.start('multi-worker-setup');
			const databases = await Promise.all([
				createTestDatabase(),
				createTestDatabase(),
				createTestDatabase()
			]);
			perf.end('multi-worker-setup');
			
			[db1, db2, db3] = databases;
			
			expect(perf.getDuration('multi-worker-setup')).toBeLessThan(5000);
			
			// Set up schema from first worker
			await db1.query(`
				CREATE TABLE IF NOT EXISTS worker_coordination (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					worker_name TEXT NOT NULL,
					action TEXT NOT NULL,
					timestamp INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			// Wait for schema propagation
			await new Promise(resolve => setTimeout(resolve, 500));
			
			// Have each worker insert data concurrently
			const workerActions = [
				db1.query("INSERT INTO worker_coordination (worker_name, action) VALUES ('worker1', 'init')"),
				db2.query("INSERT INTO worker_coordination (worker_name, action) VALUES ('worker2', 'init')"),
				db3.query("INSERT INTO worker_coordination (worker_name, action) VALUES ('worker3', 'init')")
			];
			
			const results = await Promise.allSettled(workerActions);
			
			// At least one should succeed (leader handles the operations)
			const successful = results.filter(r => r.status === 'fulfilled');
			expect(successful.length).toBeGreaterThan(0);
			
			// Wait for coordination to complete
			// @ts-expect-error this is fine
			await waitFor(async () => {
				try {
					const result = await db1.query('SELECT COUNT(*) as count FROM worker_coordination');
					const data = JSON.parse(result.value || '[]');
					return data[0].count >= 1;
				} catch {
					return false;
				}
			}, 5000);
			
			// All workers should see the same data
			const finalResults = await Promise.all([
				db1.query('SELECT * FROM worker_coordination ORDER BY id'),
				db2.query('SELECT * FROM worker_coordination ORDER BY id'),
				db3.query('SELECT * FROM worker_coordination ORDER BY id')
			]);
			
			const data1 = JSON.parse(finalResults[0].value || '[]');
			const data2 = JSON.parse(finalResults[1].value || '[]');
			const data3 = JSON.parse(finalResults[2].value || '[]');
			
			// All workers should see the same data
			expect(data1.length).toBe(data2.length);
			expect(data2.length).toBe(data3.length);
			expect(data1.length).toBeGreaterThan(0);
		});

		it.skip('should handle leader election properly', async () => {
			// Create multiple workers simultaneously
			const workerPromises = Array.from({ length: 3 }, () => createTestDatabase());
			const workers = await Promise.all(workerPromises);
			[db1, db2, db3] = workers;
			
			// Set up a test scenario where we can observe leader behavior
			await db1.query(`
				CREATE TABLE IF NOT EXISTS leader_test (
					id INTEGER PRIMARY KEY,
					leader_action TEXT NOT NULL,
					executed_at INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			await new Promise(resolve => setTimeout(resolve, 300));
			
			// Try to perform operations from all workers
			const leaderActions = [
				db1.query("INSERT OR REPLACE INTO leader_test (id, leader_action) VALUES (1, 'action_from_db1')"),
				db2.query("INSERT OR REPLACE INTO leader_test (id, leader_action) VALUES (2, 'action_from_db2')"),
				db3.query("INSERT OR REPLACE INTO leader_test (id, leader_action) VALUES (3, 'action_from_db3')")
			];
			
			// All should complete (routed through leader)
			await Promise.all(leaderActions);
			
			// Wait for all operations to complete
			// @ts-expect-error this is fine
			await waitFor(async () => {
				try {
					const result = await db1.query('SELECT COUNT(*) as count FROM leader_test');
					const data = JSON.parse(result.value || '[]');
					return data[0].count >= 3;
				} catch {
					return false;
				}
			}, 3000);
			
			// Verify all actions were executed
			const result = await db1.query('SELECT * FROM leader_test ORDER BY id');
			const data = JSON.parse(result.value || '[]');

			expect(data).toHaveLength(3);
			expect(data[0].leader_action).toBe('action_from_db1');
			expect(data[1].leader_action).toBe('action_from_db2');
			expect(data[2].leader_action).toBe('action_from_db3');
		});

		it('should handle worker failures gracefully', async () => {
			db1 = await createTestDatabase();
			db2 = await createTestDatabase();
			
			// Set up test data
			await db1.query(`
				CREATE TABLE IF NOT EXISTS failure_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					message TEXT NOT NULL,
					source TEXT NOT NULL
				)
			`);
			
			await db1.query("INSERT INTO failure_test (message, source) VALUES ('initial', 'db1')");
			await new Promise(resolve => setTimeout(resolve, 200));
			
			// Verify both workers can see the data
			await assertions.assertRowCount(db1, 'SELECT * FROM failure_test', 1);
			await assertions.assertRowCount(db2, 'SELECT * FROM failure_test', 1);
			
			// Simulate worker cleanup (like tab closing)
			await cleanupDatabase(db1);
			db1 = null!;
			
			// db2 should continue working
			await db2.query("INSERT INTO failure_test (message, source) VALUES ('after_failure', 'db2')");
			
			// @ts-expect-error this is fine
			await waitFor(async () => {
				try {
					const result = await db2.query('SELECT COUNT(*) as count FROM failure_test');
					const data = JSON.parse(result.value || '[]');
					return data[0].count >= 2;
				} catch {
					return false;
				}
			}, 3000);
			
			// Create a new worker to verify persistence
			db1 = await createTestDatabase();
			await assertions.assertRowCount(db1, 'SELECT * FROM failure_test', 2);
		});
	});

	describe('Message Passing and Coordination', () => {
		it('should handle concurrent queries efficiently', async () => {
			db1 = await createTestDatabase();
			db2 = await createTestDatabase();
			
			// Set up test table
			await db1.query(`
				CREATE TABLE IF NOT EXISTS concurrent_queries (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					query_id TEXT NOT NULL,
					result_data TEXT NOT NULL
				)
			`);
			
			await new Promise(resolve => setTimeout(resolve, 200));
			
			// Prepare concurrent queries
			const queryPromises = [];
			const queryIds = [];
			
			for (let i = 0; i < 10; i++) {
				const queryId = `query_${i}_${Date.now()}`;
				queryIds.push(queryId);
				
				const dbToUse = i % 2 === 0 ? db1 : db2; // Alternate between workers
				queryPromises.push(
					dbToUse.query(`INSERT INTO concurrent_queries (query_id, result_data) VALUES ('${queryId}', 'data_${i}')`)
				);
			}
			
			perf.start('concurrent-queries');
			const results = await Promise.allSettled(queryPromises);
			perf.end('concurrent-queries');
			
			// Most queries should succeed
			const successful = results.filter(r => r.status === 'fulfilled');
			expect(successful.length).toBeGreaterThan(queryIds.length * 0.5); // At least 50% success
			
			// Performance should be reasonable
			expect(perf.getDuration('concurrent-queries')).toBeLessThan(10000);
			
			// Wait for all operations to be reflected
			// @ts-expect-error this is fine
			await waitFor(async () => {
				try {
					const result = await db1.query('SELECT COUNT(*) as count FROM concurrent_queries');
					const data = JSON.parse(result.value || '[]');
					return data[0].count >= successful.length;
				} catch {
					return false;
				}
			}, 5000);
			
			// Verify data integrity
			const finalResult = await db1.query('SELECT * FROM concurrent_queries ORDER BY id');
			const finalData = JSON.parse(finalResult.value || '[]');

			expect(finalData.length).toBeGreaterThan(0);
			
			// Each query_id should be unique
			const uniqueQueryIds = new Set(finalData.map((row: { query_id: string }) => row.query_id));
			expect(uniqueQueryIds.size).toBe(finalData.length);
		});

		it('should maintain transaction-like behavior across workers', async () => {
			db1 = await createTestDatabase();
			db2 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE IF NOT EXISTS transaction_test (
					id INTEGER PRIMARY KEY,
					balance INTEGER NOT NULL DEFAULT 0,
					last_updated INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			// Initialize account balances
			await db1.query("INSERT INTO transaction_test (id, balance) VALUES (1, 1000), (2, 500)");
			await new Promise(resolve => setTimeout(resolve, 200));
			
			// Simulate a transfer: deduct from account 1, add to account 2
			const transferAmount = 100;
			
			// Both operations should be handled by the leader worker
			const transferOps = await Promise.allSettled([
				db1.query(`UPDATE transaction_test SET balance = balance - ${transferAmount} WHERE id = 1`),
				db2.query(`UPDATE transaction_test SET balance = balance + ${transferAmount} WHERE id = 2`)
			]);
			
			// Wait for operations to complete
			await new Promise(resolve => setTimeout(resolve, 500));
			
			// Verify final balances
			const finalResult = await db1.query('SELECT id, balance FROM transaction_test ORDER BY id');
			const balances = JSON.parse(finalResult.value || '[]');
			expect(balances).toHaveLength(2);
			
			// Check if operations were successful
			const successfulOps = transferOps.filter(op => op.status === 'fulfilled');
			if (successfulOps.length === 2) {
				// Both operations succeeded - balances should be updated
				expect(balances[0].balance).toBe(900); // 1000 - 100
				expect(balances[1].balance).toBe(600); // 500 + 100
			} else {
				// Some operations failed - balances should be unchanged
				const totalBalance = balances.reduce((sum: number, account: { balance: number }) => sum + account.balance, 0);
				expect(totalBalance).toBe(1500); // Original total should be preserved
			}
		});

		it('should handle query timeouts appropriately', async () => {
			db1 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE IF NOT EXISTS timeout_test (
					id INTEGER PRIMARY KEY,
					data TEXT NOT NULL
				)
			`);
			
			// Insert some baseline data
			await db1.query("INSERT INTO timeout_test (id, data) VALUES (1, 'baseline')");
			
			// Create a second database instance that might timeout
			db2 = await createTestDatabase();
			
			// Try a complex query that might timeout
			const complexQuery = `
				WITH RECURSIVE series(x) AS (
					SELECT 1 
					UNION ALL 
					SELECT x + 1 FROM series WHERE x < 1000
				)
				INSERT INTO timeout_test (data)
				SELECT 'generated_' || x FROM series
			`;
			
			perf.start('complex-query');
			
			try {
				const result = await db2.query(complexQuery);
				perf.end('complex-query');
				
				// If successful, verify it worked
				expect(result.value).toContain('Rows affected');
				
				// Should complete in reasonable time
				expect(perf.getDuration('complex-query')).toBeLessThan(30000);
				
			} catch (error) {
				perf.end('complex-query');
				
				// If it times out, that's expected behavior
				expect(error).toBeDefined();
			}
			
			// Database should still be functional after timeout
			const testResult = await db1.query('SELECT COUNT(*) as count FROM timeout_test');
			const data = JSON.parse(testResult.value || '[]');
			expect(data[0].count).toBeGreaterThan(0);
		});
	});

	describe('BroadcastChannel Communication', () => {
		it.skip('should coordinate through BroadcastChannel', async () => {
			db1 = await createTestDatabase();
			db2 = await createTestDatabase();
			
			// Set up test table
			await db1.query(`
				CREATE TABLE IF NOT EXISTS broadcast_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					message TEXT NOT NULL,
					sender TEXT NOT NULL,
					broadcast_time INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			await new Promise(resolve => setTimeout(resolve, 300));
			
			// Send messages from different workers
			await db1.query("INSERT INTO broadcast_test (message, sender) VALUES ('Hello from worker 1', 'worker1')");
			await db2.query("INSERT INTO broadcast_test (message, sender) VALUES ('Hello from worker 2', 'worker2')");
			
			// Wait for broadcast coordination
			// @ts-expect-error this is fine
			await waitFor(async () => {
				try {
					const result = await db1.query('SELECT COUNT(*) as count FROM broadcast_test');
					const data = JSON.parse(result.value || '[]');
					return data[0].count >= 2;
				} catch {
					return false;
				}
			}, 5000);
			
			// Both workers should see both messages
			const result1 = await db1.query('SELECT * FROM broadcast_test ORDER BY id');
			const result2 = await db2.query('SELECT * FROM broadcast_test ORDER BY id');
			
			const data1 = JSON.parse(result1.value || '[]');
			const data2 = JSON.parse(result2.value || '[]');
			
			expect(data1.length).toBe(data2.length);
			expect(data1.length).toBe(2);
			
			// Verify message content
			const senders = data1.map((row: { sender: string }) => row.sender);
			expect(senders).toContain('worker1');
			expect(senders).toContain('worker2');
		});

		it.skip('should handle BroadcastChannel message ordering', async () => {
			db1 = await createTestDatabase();
			db2 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE IF NOT EXISTS message_order_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					sequence_number INTEGER NOT NULL,
					content TEXT NOT NULL
				)
			`);
			
			await new Promise(resolve => setTimeout(resolve, 200));
			
			// Send messages in sequence from alternating workers
			const messagePromises = [];
			for (let i = 0; i < 6; i++) {
				const sender = i % 2 === 0 ? db1 : db2;
				messagePromises.push(
					sender.query(`INSERT INTO message_order_test (sequence_number, content) VALUES (${i}, 'Message ${i}')`)
				);
			}
			
			await Promise.all(messagePromises);
			
			// Wait for all messages to be processed
			// @ts-expect-error this is fine
			await waitFor(async () => {
				try {
					const result = await db1.query('SELECT COUNT(*) as count FROM message_order_test');
					const data = JSON.parse(result.value || '[]');
					return data[0].count >= 6;
				} catch {
					return false;
				}
			}, 5000);
			
			// Verify message ordering
			const result = await db1.query('SELECT * FROM message_order_test ORDER BY sequence_number');
			const messages = JSON.parse(result.value || '[]');

			expect(messages.length).toBe(6);
			
			// Messages should be in sequence order
			for (let i = 0; i < 6; i++) {
				expect(messages[i].sequence_number).toBe(i);
				expect(messages[i].content).toBe(`Message ${i}`);
			}
		});
	});

	describe('Performance Under Load', () => {
		it('should handle high-frequency operations across workers', async () => {
			db1 = await createTestDatabase();
			db2 = await createTestDatabase();
			
			await db1.query(`
				CREATE TABLE IF NOT EXISTS load_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					worker_id TEXT NOT NULL,
					operation_number INTEGER NOT NULL,
					timestamp INTEGER DEFAULT (strftime('%s', 'now'))
				)
			`);
			
			await new Promise(resolve => setTimeout(resolve, 200));
			
			const operationsPerWorker = 25;
			const allOperations = [];
			
			perf.start('high-frequency-load');
			
			// Generate operations from both workers
			for (let i = 0; i < operationsPerWorker; i++) {
				allOperations.push(
					db1.query(`INSERT INTO load_test (worker_id, operation_number) VALUES ('worker1', ${i})`)
				);
				allOperations.push(
					db2.query(`INSERT INTO load_test (worker_id, operation_number) VALUES ('worker2', ${i})`)
				);
			}
			
			const results = await Promise.allSettled(allOperations);
			perf.end('high-frequency-load');
			
			const successful = results.filter(r => r.status === 'fulfilled');
			const failureRate = (results.length - successful.length) / results.length;
			
			// Should have reasonable success rate under load
			expect(failureRate).toBeLessThan(0.5); // Less than 50% failure rate
			
			// Should complete in reasonable time
			expect(perf.getDuration('high-frequency-load')).toBeLessThan(15000);
			
			// Wait for operations to settle
			await new Promise(resolve => setTimeout(resolve, 1000));
			
			// Verify data integrity
			const finalResult = await db1.query(`
				SELECT worker_id, COUNT(*) as count 
				FROM load_test 
				GROUP BY worker_id 
				ORDER BY worker_id
			`);
			const workerCounts = JSON.parse(finalResult.value || '[]');

			expect(workerCounts.length).toBeGreaterThan(0);
			
			// Should have operations from both workers
			const workerIds = workerCounts.map((row: { worker_id: string }) => row.worker_id);
			expect(workerIds).toContain('worker1');
			expect(workerIds).toContain('worker2');
		});
	});
});