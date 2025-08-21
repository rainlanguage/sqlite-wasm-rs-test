import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
	createTestDatabase, 
	loadTestData, 
	cleanupDatabase, 
	generateTestData, 
	assertions,
	PerformanceTracker 
} from '../fixtures/test-helpers.js';
import type { SQLiteWasmDatabase } from 'sqlite-web';

describe('Basic Database Operations', () => {
	let db: SQLiteWasmDatabase;
	let perf: PerformanceTracker;
	
	beforeEach(async () => {
		db = await createTestDatabase();
		perf = new PerformanceTracker();
	});
	
	afterEach(async () => {
		await cleanupDatabase(db);
	});

	describe('Table Creation', () => {
		it('should create a basic table', async () => {
			const sql = `
				CREATE TABLE test_items (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					value REAL
				)
			`;
			
			const result = await db.query(sql);
			expect(result.value).toContain('successfully');
		});

		it('should create table with various column types', async () => {
			const sql = `
				CREATE TABLE type_test (
					id INTEGER PRIMARY KEY,
					text_col TEXT,
					real_col REAL,
					blob_col BLOB,
					null_col NULL
				)
			`;
			
			const result = await db.query(sql);
			expect(result.value).toContain('successfully');
		});

		it('should handle CREATE TABLE IF NOT EXISTS', async () => {
			const sql = `
				CREATE TABLE IF NOT EXISTS duplicate_test (
					id INTEGER PRIMARY KEY,
					data TEXT
				)
			`;
			
			// Create table twice - second should not error
			await db.query(sql);
			const result = await db.query(sql);
			expect(result.value).toContain('successfully');
		});
	});

	describe('Insert Operations', () => {
		beforeEach(async () => {
			await db.query(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					email TEXT UNIQUE,
					age INTEGER
				)
			`);
		});

		it('should insert a single record', async () => {
			perf.start('single-insert');
			const result = await db.query(`
				INSERT INTO users (name, email, age) 
				VALUES ('John Doe', 'john@test.com', 30)
			`);
			perf.end('single-insert');
			
			expect(result.value).toContain('Rows affected: 1');
			expect(perf.getDuration('single-insert')).toBeLessThan(1000);
		});

		it('should insert multiple records', async () => {
			const result = await db.query(`
				INSERT INTO users (name, email, age) VALUES 
				('Alice Johnson', 'alice@test.com', 28),
				('Bob Smith', 'bob@test.com', 35),
				('Carol Davis', 'carol@test.com', 32)
			`);
			
			expect(result.value).toContain('Rows affected: 3');
			
			// Verify all records were inserted
			await assertions.assertRowCount(db, 'SELECT * FROM users', 3);
		});

		it('should handle INSERT OR IGNORE for duplicates', async () => {
			// Insert initial record
			await db.query(`
				INSERT INTO users (name, email, age) 
				VALUES ('John Doe', 'john@test.com', 30)
			`);
			
			// Try to insert duplicate email with OR IGNORE
			const result = await db.query(`
				INSERT OR IGNORE INTO users (name, email, age) 
				VALUES ('Jane Doe', 'john@test.com', 25)
			`);
			
			expect(result.value).toContain('Rows affected: 0');
			await assertions.assertRowCount(db, 'SELECT * FROM users', 1);
		});

		it('should insert records with NULL values', async () => {
			const result = await db.query(`
				INSERT INTO users (name, email, age) 
				VALUES ('Anonymous', NULL, NULL)
			`);
			
			expect(result.value).toContain('Rows affected: 1');
			
			const selectResult = await db.query('SELECT * FROM users WHERE name = "Anonymous"');
			const data = JSON.parse(selectResult.value || '[]');
			
			expect(data).toHaveLength(1);
			expect(data[0].email).toBeNull();
			expect(data[0].age).toBeNull();
		});
	});

	describe('Select Operations', () => {
		beforeEach(async () => {
			await loadTestData(db);
		});

		it('should select all records', async () => {
			perf.start('select-all');
			const result = await db.query('SELECT * FROM test_users');
			perf.end('select-all');
			
			const data = JSON.parse(result.value || '[]');
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			expect(perf.getDuration('select-all')).toBeLessThan(500);
		});

		it('should select with WHERE clause', async () => {
			const result = await db.query(`
				SELECT * FROM test_users 
				WHERE age > 30
			`);
			
			const data = JSON.parse(result.value || '[]');
			expect(Array.isArray(data)).toBe(true);
			
			// Verify all returned records have age > 30
			// @ts-expect-error this is fine
			data.forEach(user => {
				expect(user.age).toBeGreaterThan(30);
			});
		});

		it('should select with ORDER BY', async () => {
			const result = await db.query(`
				SELECT name, age FROM test_users 
				ORDER BY age DESC
			`);
			
			const data = JSON.parse(result.value || '[]');
			expect(data.length).toBeGreaterThan(1);
			
			// Verify ordering
			for (let i = 0; i < data.length - 1; i++) {
				expect(data[i].age).toBeGreaterThanOrEqual(data[i + 1].age);
			}
		});

		it('should select with LIMIT and OFFSET', async () => {
			const result = await db.query(`
				SELECT * FROM test_users 
				ORDER BY id 
				LIMIT 2 OFFSET 1
			`);
			
			const data = JSON.parse(result.value || '[]');
			expect(data).toHaveLength(2);
		});

		it('should handle COUNT queries', async () => {
			const result = await db.query('SELECT COUNT(*) as total FROM test_users');
			const data = JSON.parse(result.value || '[]');
			
			expect(data).toHaveLength(1);
			expect(data[0]).toHaveProperty('total');
			expect(typeof data[0].total).toBe('number');
			expect(data[0].total).toBeGreaterThan(0);
		});

		it('should handle GROUP BY queries', async () => {
			const result = await db.query(`
				SELECT 
					CASE 
						WHEN age < 30 THEN 'Young' 
						ELSE 'Mature' 
					END as age_group,
					COUNT(*) as count
				FROM test_users 
				GROUP BY age_group
			`);
			
			const data = JSON.parse(result.value || '[]');
			expect(Array.isArray(data)).toBe(true);
			
			// @ts-expect-error this is fine
			data.forEach(row => {
				expect(row).toHaveProperty('age_group');
				expect(row).toHaveProperty('count');
				expect(['Young', 'Mature']).toContain(row.age_group);
			});
		});
	});

	describe('Update Operations', () => {
		beforeEach(async () => {
			await db.query(`
				CREATE TABLE products (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					name TEXT NOT NULL,
					price REAL,
					category TEXT
				)
			`);
			
			await db.query(`
				INSERT INTO products (name, price, category) VALUES 
				('Laptop', 999.99, 'Electronics'),
				('Mouse', 25.50, 'Electronics'),
				('Chair', 150.00, 'Furniture')
			`);
		});

		it('should update a single record', async () => {
			const result = await db.query(`
				UPDATE products 
				SET price = 899.99 
				WHERE name = 'Laptop'
			`);
			
			expect(result.value).toContain('Rows affected: 1');
			
			// Verify the update
			await assertions.assertContains(
				db, 
				'SELECT * FROM products WHERE name = "Laptop"', 
				{ name: 'Laptop', price: 899.99 }
			);
		});

		it('should update multiple records', async () => {
			const result = await db.query(`
				UPDATE products 
				SET category = 'Tech' 
				WHERE category = 'Electronics'
			`);
			
			expect(result.value).toContain('Rows affected: 2');
			
			// Verify both electronics items were updated
			await assertions.assertRowCount(
				db, 
				'SELECT * FROM products WHERE category = "Tech"', 
				2
			);
		});

		it('should handle UPDATE with calculations', async () => {
			const result = await db.query(`
				UPDATE products 
				SET price = price * 1.1 
				WHERE category = 'Electronics'
			`);
			
			expect(result.value).toContain('Rows affected: 2');
			
			// Verify price increased
			const selectResult = await db.query('SELECT price FROM products WHERE name = "Laptop"');
			const data = JSON.parse(selectResult.value || '[]');
			expect(data[0].price).toBeCloseTo(1099.989, 2);
		});
	});

	describe('Delete Operations', () => {
		beforeEach(async () => {
			await loadTestData(db);
		});

		it('should delete specific records', async () => {
			const result = await db.query(`
				DELETE FROM test_users 
				WHERE age < 30
			`);
			
			expect(result.value).toMatch(/Rows affected: \d+/);
			
			// Verify no users under 30 remain
			await assertions.assertRowCount(
				db, 
				'SELECT * FROM test_users WHERE age < 30', 
				0
			);
		});

		it('should delete all records', async () => {
			const result = await db.query('DELETE FROM test_users');
			expect(result.value).toMatch(/Rows affected: \d+/);
			
			// Verify table is empty
			await assertions.assertRowCount(db, 'SELECT * FROM test_users', 0);
		});
	});

	describe('Data Type Handling', () => {
		beforeEach(async () => {
			await db.query(`
				CREATE TABLE type_test (
					id INTEGER PRIMARY KEY,
					int_col INTEGER,
					real_col REAL,
					text_col TEXT,
					blob_col BLOB
				)
			`);
		});

		it('should handle INTEGER types correctly', async () => {
			await db.query(`
				INSERT INTO type_test (int_col) VALUES 
				(42), (-1), (0), (9223372036854775807)
			`);
			
			const result = await db.query('SELECT int_col FROM type_test ORDER BY int_col');
			const data = JSON.parse(result.value || '[]');
			
			expect(data).toHaveLength(4);
			expect(data[0].int_col).toBe(-1);
			expect(data[1].int_col).toBe(0);
			expect(data[2].int_col).toBe(42);
			expect(data[3].int_col).toBe(9223372036854775807);
		});

		it('should handle REAL types correctly', async () => {
			await db.query(`
				INSERT INTO type_test (real_col) VALUES 
				(3.14159), (-2.71828), (0.0), (1e10)
			`);
			
			const result = await db.query('SELECT real_col FROM type_test ORDER BY real_col');
			const data = JSON.parse(result.value || '[]');
			
			expect(data).toHaveLength(4);
			expect(data[0].real_col).toBeCloseTo(-2.71828, 5);
			expect(data[1].real_col).toBe(0);
			expect(data[2].real_col).toBeCloseTo(3.14159, 5);
			expect(data[3].real_col).toBe(1e10);
		});

		it('should handle TEXT with special characters', async () => {
			const testTexts = [
				'Hello World',
				'Text with "quotes"',
				"Text with 'single quotes'",
				'Unicode: 🚀 世界 ñáéíóú',
				'Line\nBreak\tTab',
				''  // Empty string
			];
			
			for (let i = 0; i < testTexts.length; i++) {
				await db.query(`
					INSERT INTO type_test (id, text_col) 
					VALUES (${i + 1}, ?)
				`.replace('?', `'${testTexts[i].replace(/'/g, "''")}'`));
			}
			
			const result = await db.query('SELECT text_col FROM type_test ORDER BY id');
			const data = JSON.parse(result.value || '[]');
			
			expect(data).toHaveLength(testTexts.length);
			// @ts-expect-error this is fine
			data.forEach((row, index) => {
				expect(row.text_col).toBe(testTexts[index]);
			});
		});

		it('should handle NULL values', async () => {
			await db.query(`
				INSERT INTO type_test (id, int_col, real_col, text_col) 
				VALUES (1, NULL, NULL, NULL)
			`);
			
			const result = await db.query('SELECT * FROM type_test WHERE id = 1');
			const data = JSON.parse(result.value || '[]');
			
			expect(data).toHaveLength(1);
			expect(data[0].int_col).toBeNull();
			expect(data[0].real_col).toBeNull();
			expect(data[0].text_col).toBeNull();
		});
	});

	describe('Performance Tests', () => {
		it('should handle bulk inserts efficiently', async () => {
			await db.query(`
				CREATE TABLE bulk_test (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data TEXT,
					value REAL
				)
			`);
			
			const testData = generateTestData();
			const insertCount = 100;
			
			perf.start('bulk-insert');
			
			// Generate bulk insert statement
			const values = Array.from({ length: insertCount }, (_, i) => {
				const user = testData.randomUser();
				return `('${user.name}', ${Math.random() * 1000})`;
			}).join(',');
			
			const result = await db.query(`
				INSERT INTO bulk_test (data, value) VALUES ${values}
			`);
			
			perf.end('bulk-insert');
			
			expect(result.value).toContain(`Rows affected: ${insertCount}`);
			expect(perf.getDuration('bulk-insert')).toBeLessThan(5000);
			
			// Verify all records were inserted
			await assertions.assertRowCount(db, 'SELECT * FROM bulk_test', insertCount);
		});

		it('should handle complex queries efficiently', async () => {
			await loadTestData(db);
			
			perf.start('complex-query');
			
			const result = await db.query(`
				SELECT 
					u.name,
					u.age,
					COUNT(p.id) as product_count,
					AVG(p.price) as avg_price
				FROM test_users u
				LEFT JOIN test_products p ON u.id <= p.id
				WHERE u.age > 25
				GROUP BY u.id, u.name, u.age
				HAVING COUNT(p.id) > 0
				ORDER BY avg_price DESC
				LIMIT 10
			`);
			
			perf.end('complex-query');
			
			const data = JSON.parse(result.value || '[]');
			expect(Array.isArray(data)).toBe(true);
			expect(perf.getDuration('complex-query')).toBeLessThan(2000);
		});
	});
});