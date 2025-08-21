import init, { SQLiteWasmDatabase } from 'sqlite-web';

/**
 * Initialize a new SQLite database instance for testing
 */
export async function createTestDatabase(): Promise<SQLiteWasmDatabase> {
	// Initialize WASM module
	await init();
	
	// Create database instance
	const result = SQLiteWasmDatabase.new();
	if (result.error) {
		throw new Error(`Failed to create database: ${result.error.msg}`);
	}
	
	const db = result.value!
	
	// Wait for worker to be ready
	await new Promise(resolve => setTimeout(resolve, 1000));
	
	return db;
}

/**
 * Execute multiple SQL statements from a file or string
 */
export async function executeSqlScript(db: SQLiteWasmDatabase, sqlContent: string): Promise<void> {
	// Split SQL content by semicolons and execute each statement
	const statements = sqlContent
		.split(';')
		.map(stmt => stmt.trim())
		.filter(stmt => stmt.length > 0);
	
	for (const statement of statements) {
		try {
			await db.query(statement);
		} catch (error) {
			console.warn(`Failed to execute statement: ${statement}`, error);
		}
	}
}

/**
 * Load test data into the database
 */
export async function loadTestData(db: SQLiteWasmDatabase): Promise<void> {
	const testDataSql = await fetch('/tests/fixtures/test-data.sql')
		.then(r => r.text())
		.catch(() => {
			// Fallback test data if file not available
			return `
				CREATE TABLE IF NOT EXISTS test_users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					email TEXT UNIQUE
				);
				INSERT OR IGNORE INTO test_users (name, email) VALUES 
				('Alice', 'alice@test.com'),
				('Bob', 'bob@test.com');
			`;
		});
	
	await executeSqlScript(db, testDataSql);
}

/**
 * Wait for a condition to be true with timeout
 */
export function waitFor(condition: () => boolean, timeout = 5000, interval = 100): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const startTime = Date.now();
		
		const check = () => {
			if (condition()) {
				resolve(true);
			} else if (Date.now() - startTime >= timeout) {
				reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
			} else {
				setTimeout(check, interval);
			}
		};
		
		check();
	});
}

export interface TestUser {
	name: string;
	email: string;
	age: number;
}

export interface TestProduct {
	name: string;
	price: number;
	category: string;
	in_stock: boolean;
}

/**
 * Generate random test data
 */
export function generateTestData() {
	const names = ['Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Henry'];
	const domains = ['test.com', 'example.org', 'demo.net'];
	
	return {
		randomUser: (): TestUser => {
			const name = names[Math.floor(Math.random() * names.length)];
			const domain = domains[Math.floor(Math.random() * domains.length)];
			const timestamp = Date.now();
			
			return {
				name: `${name} ${timestamp}`,
				email: `${name.toLowerCase()}${timestamp}@${domain}`,
				age: Math.floor(Math.random() * 50) + 18
			};
		},
		
		randomProduct: (): TestProduct => {
			const products = ['Widget', 'Gadget', 'Tool', 'Device'];
			const categories = ['Electronics', 'Home', 'Office', 'Sports'];
			const timestamp = Date.now();
			
			return {
				name: `${products[Math.floor(Math.random() * products.length)]} ${timestamp}`,
				price: Math.round((Math.random() * 1000) * 100) / 100,
				category: categories[Math.floor(Math.random() * categories.length)],
				in_stock: Math.random() > 0.3
			};
		}
	};
}

/**
 * Performance measurement utilities
 */
export class PerformanceTracker {
	private measurements: Record<string, { start: number; end?: number; duration?: number }> = {};

	constructor() {}
	
	start(label: string): void {
		this.measurements[label] = { start: performance.now() };
	}
	
	end(label: string): number {
		if (!this.measurements[label]) {
			throw new Error(`No measurement started for label: ${label}`);
		}
		
		this.measurements[label].end = performance.now();
		this.measurements[label].duration = this.measurements[label].end - this.measurements[label].start;
		
		return this.measurements[label].duration;
	}
	
	getDuration(label: string): number | undefined {
		return this.measurements[label]?.duration;
	}
	
	getAll(): Array<{ label: string; duration: number | undefined }> {
		return Object.entries(this.measurements).map(([label, data]) => ({
			label,
			duration: data.duration
		}));
	}
}

/**
 * Database cleanup utility
 */
export async function cleanupDatabase(db: SQLiteWasmDatabase): Promise<void> {
	if (!db) return;
	
	try {
		// Drop all test tables
		const tables = [
			'test_users', 'test_products', 'users', 'products',
			'test_items', 'type_test', 'duplicate_test', 'bulk_test',
			'constraint_test', 'concurrency_test',
			// Error handling test tables
			'error_recovery_test', 'injection_test', 'parent_table', 'child_table',
			'long_query_test', 'many_params_test', 'nested_test', 'timeout_test',
			'recovery_test', 'custom_function_test', 'special_chars_test', 'concurrent_error_test',
			// Worker communication test tables  
			'workers_test', 'shared_data', 'worker_coordination', 'message_test'
		];
		for (const table of tables) {
			try {
				await db.query(`DROP TABLE IF EXISTS ${table}`);
			} catch (error) {
				// Table might not exist, continue
			}
		}
	} catch (error) {
		console.warn('Error cleaning up database:', error);
	}
}

/**
 * Assert helpers for common database testing patterns
 */
export const assertions = {
	/**
	 * Assert that a query result contains expected number of rows
	 */
	async assertRowCount(db: SQLiteWasmDatabase, sql: string, expectedCount: number, message = ''): Promise<void> {
		const result = await db.query(sql);
		const data = JSON.parse(result.value || '[]');
		const actualCount = Array.isArray(data) ? data.length : 0;
		
		if (actualCount !== expectedCount) {
			throw new Error(
				`Expected ${expectedCount} rows but got ${actualCount}. ${message}\nSQL: ${sql}`
			);
		}
	},
	
	/**
	 * Assert that a query result contains specific data
	 */
	async assertContains(db: SQLiteWasmDatabase, sql: string, expectedData: Record<string, unknown>, message = ''): Promise<void> {
		const result = await db.query(sql);
		const data = JSON.parse(result.value || '[]');
		
		if (!Array.isArray(data)) {
			throw new Error(`Query result is not an array. ${message}`);
		}
		
		const found = data.some(row => 
			Object.entries(expectedData).every(([key, value]) => row[key] === value)
		);
		
		if (!found) {
			throw new Error(
				`Expected data not found in results. ${message}\nExpected: ${JSON.stringify(expectedData)}\nActual: ${JSON.stringify(data)}`
			);
		}
	}
};