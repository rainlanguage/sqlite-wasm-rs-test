<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import init, { SQLiteWasmDatabase } from 'sqlite-web';

    let db: SQLiteWasmDatabase | undefined;
    let sqlQuery = $state('SELECT * FROM users;');
    let queryResult = $state<Record<string, unknown>[] | null>(null);
    let status = $state('Initializing...');
    let isExecuting = $state(false);
    let errorMessage = $state('');

    onMount(async () => {
        if (!browser) return;

        try {
            status = 'Loading SQLite Worker...';

            await init();

            status = 'Creating database connection...';
            let res = SQLiteWasmDatabase.new();
            if (res.error) {
                status = `Failed to create database connection: ${res.error.msg}`;
                return;
            }
            db = res.value;

            status = 'Waiting for worker to be ready...';
            await new Promise(resolve => setTimeout(resolve, 1000));

            status = 'Setting up database schema...';
            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            status = 'Ready ✅';
        } catch (error) {
            status = `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    });

    async function executeQuery() {
        if (!db || !sqlQuery.trim()) return;

        try {
            isExecuting = true;
            errorMessage = '';

            const result = await db.query(sqlQuery.trim());

            try {
                queryResult = JSON.parse(result.value || '[]');
            } catch {
                queryResult = [{ result }];
            }
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : 'Unknown error';
            queryResult = null;
        } finally {
            isExecuting = false;
        }
    }

    function insertSampleData() {
        sqlQuery = `INSERT INTO users (name, email) VALUES 
('Alice Johnson', 'alice@example.com'),
('Bob Smith', 'bob@example.com'),
('Carol Davis', 'carol@example.com');`;
    }

    function clearQuery() {
        sqlQuery = '';
        queryResult = null;
        errorMessage = '';
    }
</script>

<div class="sql-console">
    <h1>SQL Console</h1>
    <p class="status">Status: <span class="status-text">{status}</span></p>

    {#if status.includes('Ready')}
        <div class="query-section">
            <div class="query-header">
                <h3>SQL Query</h3>
                <div class="query-buttons">
                    <button class="sample-btn" onclick={insertSampleData}>Insert Sample Data</button>
                    <button class="clear-btn" onclick={clearQuery}>Clear</button>
                </div>
            </div>

            <textarea
                bind:value={sqlQuery}
                placeholder="Enter your SQL query here..."
                rows="8"
                disabled={isExecuting}
            ></textarea>

            <button
                class="execute-btn"
                onclick={executeQuery}
                disabled={isExecuting || !sqlQuery.trim()}
            >
                {isExecuting ? 'Executing...' : 'Execute Query'}
            </button>
        </div>

        {#if errorMessage}
            <div class="error-message">
                <h4>❌ Query Error</h4>
                <pre>{errorMessage}</pre>
            </div>
        {/if}

        {#if queryResult !== null}
            <div class="results-section">
                <h3>Query Results</h3>

                {#if Array.isArray(queryResult) && queryResult.length > 0}
                    <div class="results-info">
                        <span class="row-count">{queryResult.length} row{queryResult.length !== 1 ? 's' : ''} returned</span>
                    </div>

                    <div class="table-container">
                        <table>
                            <thead>
                                <tr>
                                    {#each Object.keys(queryResult[0]) as column}
                                        <th>{column}</th>
                                    {/each}
                                </tr>
                            </thead>
                            <tbody>
                                {#each queryResult as row}
                                    <tr>
                                        {#each Object.values(row) as value}
                                            <td>{value}</td>
                                        {/each}
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {:else if Array.isArray(queryResult)}
                    <div class="empty-result">
                        <p>Query executed successfully but returned no rows.</p>
                    </div>
                {:else}
                    <div class="simple-result">
                        <pre>{JSON.stringify(queryResult, null, 2)}</pre>
                    </div>
                {/if}
            </div>
        {/if}

        <div class="example-queries">
            <h3>Example Queries</h3>
            <div class="examples">
                <button onclick={() => sqlQuery = 'SELECT * FROM users ORDER BY created_at DESC;'}>
                    Select All Users
                </button>
                <button onclick={() => sqlQuery = 'SELECT COUNT(*) as total_users FROM users;'}>
                    Count Users
                </button>
                <button onclick={() => sqlQuery = 'SELECT name, email FROM users WHERE email LIKE \'%@example.com\';'}>
                    Filter by Email Domain
                </button>
                <button onclick={() => sqlQuery = 'DROP TABLE IF EXISTS test_table;\nCREATE TABLE test_table (id INTEGER, data TEXT);'}>
                    Create Test Table
                </button>
            </div>
        </div>

    {:else if status.includes('Failed')}
        <div class="error-state">
            <h3>❌ Initialization Failed</h3>
            <p>{status}</p>
            <button onclick={() => window.location.reload()}>Reload Page</button>
        </div>
    {:else}
        <div class="loading-state">
            <h3>🔄 {status}</h3>
            <div class="spinner"></div>
        </div>
    {/if}
</div>

<style>
    .sql-console {
        max-width: 1200px;
        margin: 0 auto;
        padding: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    h1 {
        color: #333;
        margin-bottom: 10px;
    }

    .status {
        margin: 20px 0;
        padding: 10px;
        background: #f8f9fa;
        border-radius: 6px;
        border-left: 4px solid #007bff;
    }

    .status-text {
        font-weight: bold;
        color: #007bff;
    }

    .query-section {
        background: #f8f9fa;
        padding: 20px;
        border-radius: 8px;
        margin: 20px 0;
        border: 1px solid #e9ecef;
    }

    .query-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
    }

    .query-header h3 {
        margin: 0;
        color: #495057;
    }

    .query-buttons {
        display: flex;
        gap: 8px;
    }

    .sample-btn, .clear-btn {
        padding: 6px 12px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .sample-btn {
        background: #28a745;
        color: white;
    }

    .sample-btn:hover {
        background: #218838;
    }

    .clear-btn {
        background: #6c757d;
        color: white;
    }

    .clear-btn:hover {
        background: #5a6268;
    }

    textarea {
        width: 100%;
        padding: 15px;
        border: 1px solid #ced4da;
        border-radius: 6px;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: 14px;
        line-height: 1.5;
        resize: vertical;
        background: white;
        box-sizing: border-box;
    }

    textarea:focus {
        outline: none;
        border-color: #007bff;
        box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
    }

    textarea:disabled {
        background: #e9ecef;
        cursor: not-allowed;
    }

    .execute-btn {
        background: #007bff;
        color: white;
        padding: 12px 24px;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 16px;
        font-weight: bold;
        margin-top: 15px;
        transition: background-color 0.2s;
    }

    .execute-btn:hover:not(:disabled) {
        background: #0056b3;
    }

    .execute-btn:disabled {
        background: #6c757d;
        cursor: not-allowed;
    }

    .error-message {
        background: #f8d7da;
        border: 1px solid #f5c6cb;
        border-radius: 6px;
        padding: 15px;
        margin: 20px 0;
    }

    .error-message h4 {
        margin: 0 0 10px 0;
        color: #721c24;
    }

    .error-message pre {
        margin: 0;
        color: #721c24;
        font-size: 14px;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .results-section {
        margin: 20px 0;
    }

    .results-section h3 {
        color: #495057;
        margin-bottom: 15px;
    }

    .results-info {
        margin-bottom: 15px;
        padding: 8px 12px;
        background: #e7f3ff;
        border-radius: 4px;
        border-left: 4px solid #007bff;
    }

    .row-count {
        font-weight: bold;
        color: #0056b3;
    }

    .table-container {
        overflow-x: auto;
        border: 1px solid #e9ecef;
        border-radius: 6px;
        background: white;
    }

    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 14px;
    }

    th {
        background: #f8f9fa;
        padding: 12px;
        text-align: left;
        font-weight: bold;
        color: #495057;
        border-bottom: 2px solid #e9ecef;
        position: sticky;
        top: 0;
    }

    td {
        padding: 12px;
        border-bottom: 1px solid #e9ecef;
        vertical-align: top;
    }

    tr:hover {
        background: #f8f9fa;
    }

    .empty-result {
        padding: 40px 20px;
        text-align: center;
        background: #f8f9fa;
        border-radius: 6px;
        border: 2px dashed #dee2e6;
        color: #6c757d;
    }

    .simple-result {
        background: #f8f9fa;
        padding: 15px;
        border-radius: 6px;
        border: 1px solid #e9ecef;
    }

    .simple-result pre {
        margin: 0;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        font-size: 14px;
        color: #495057;
    }

    .example-queries {
        margin: 30px 0;
        padding: 20px;
        background: #e7f3ff;
        border-radius: 8px;
        border: 1px solid #b6d7ff;
    }

    .example-queries h3 {
        margin: 0 0 15px 0;
        color: #0056b3;
    }

    .examples {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
    }

    .examples button {
        background: white;
        color: #007bff;
        padding: 8px 16px;
        border: 1px solid #007bff;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s;
    }

    .examples button:hover {
        background: #007bff;
        color: white;
    }

    .error-state, .loading-state {
        text-align: center;
        padding: 40px 20px;
    }

    .error-state {
        color: #dc3545;
    }

    .error-state button {
        background: #007bff;
        color: white;
        padding: 10px 20px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-top: 10px;
    }

    .loading-state {
        color: #007bff;
    }

    .spinner {
        width: 40px;
        height: 40px;
        border: 4px solid #f3f3f3;
        border-top: 4px solid #007bff;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin: 20px auto;
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }

    @media (max-width: 768px) {
        .query-header {
            flex-direction: column;
            gap: 10px;
            align-items: stretch;
        }

        .query-buttons {
            justify-content: center;
        }

        .examples {
            flex-direction: column;
        }

        .examples button {
            text-align: left;
        }
    }
</style>