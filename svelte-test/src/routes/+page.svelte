<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import init, { SQLiteWasmDatabase } from 'sqlite-web';

    let db: SQLiteWasmDatabase | undefined;
    let users: Array<{ id: number; name: string; email: string; created_at: string }> = $state([]);
    let newUserName = $state('');
    let newUserEmail = $state('');
    let status = $state('Initializing...');
    let isLoading = $state(false);

    onMount(async () => {
        if (!browser) return;

        try {
            status = 'Loading SQLite Worker...';

            // Initialize the WASM module
            await init();

            status = 'Creating database connection...';
            let res = SQLiteWasmDatabase.new();
            if (res.error) {
                throw new Error('Failed to create database connection');
            }
            db = res.value;

            status = 'Waiting for worker to be ready...';
            // Wait for worker to be ready
            await new Promise(resolve => setTimeout(resolve, 1000));

            status = 'Setting up database schema...';
            // Initialize schema
            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Load initial data
            await loadUsers();
            status = 'Ready ✅';
        } catch (error) {
            status = `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
    });

    async function  loadUsers() {
        if (!db) return;
        try {
            isLoading = true;
            const result = await db.query('SELECT * FROM users ORDER BY created_at DESC');
            users = JSON.parse(result.value || '[]');
        } catch (error) {
            status = `Load error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        } finally {
            isLoading = false;
        }
    }

    async function addUser() {
        if (!db || !newUserName.trim() || !newUserEmail.trim()) return;

        try {
            isLoading = true;
            await db.query(`
                INSERT OR IGNORE INTO users (name, email) 
                VALUES ('${newUserName.trim()}', '${newUserEmail.trim()}')
            `);

            // Clear form
            newUserName = '';
            newUserEmail = '';

            // Reload users
            await loadUsers();
        } catch (error) {
            status = `Add error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        } finally {
            isLoading = false;
        }
    }

    async function deleteUser(id: number) {
        if (!db) return;
        try {
            isLoading = true;
            await db.query(`DELETE FROM users WHERE id = ${id}`);
            await loadUsers();
        } catch (error) {
            status = `Delete error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        } finally {
            isLoading = false;
        }
    }

    async function clearAll() {
        if (!db) return;
        try {
            isLoading = true;
            await db.query('DELETE FROM users');
            await loadUsers();
        } catch (error) {
            status = `Clear error: ${error instanceof Error ? error.message : 'Unknown error'}`;
        } finally {
            isLoading = false;
        }
    }
</script>

<div class="database-demo">
    <h1>SQLite Worker Demo</h1>
    <p class="status">Status: <span class="status-text">{status}</span></p>

    {#if status.includes('Ready')}
        <div class="add-user">
            <h3>Add New User</h3>
            <div class="form-group">
                <input
                    bind:value={newUserName}
                    placeholder="Full Name"
                    type="text"
                    disabled={isLoading}
                />
                <input
                    bind:value={newUserEmail}
                    placeholder="Email Address"
                    type="email"
                    disabled={isLoading}
                />
                <button
                    onclick={addUser}
                    disabled={isLoading || !newUserName.trim() || !newUserEmail.trim()}
                >
                    {isLoading ? 'Adding...' : 'Add User'}
                </button>
            </div>
        </div>

        <div class="users-section">
            <div class="users-header">
                <h3>Users ({users.length})</h3>
                <div class="header-buttons">
                    <button class="refresh-btn" onclick={loadUsers} disabled={isLoading}>
                        {isLoading ? 'Loading...' : 'Refresh'}
                    </button>
                    {#if users.length > 0}
                        <button class="clear-btn" onclick={clearAll} disabled={isLoading}>
                            Clear All
                        </button>
                    {/if}
                </div>
            </div>

            {#if isLoading}
                <div class="loading">Loading...</div>
            {/if}

            <div class="users-list">
                {#each users as user (user.id)}
                    <div class="user-card">
                        <div class="user-info">
                            <strong>{user.name}</strong>
                            <span class="email">{user.email}</span>
                            <small class="date">{new Date(user.created_at).toLocaleString()}</small>
                        </div>
                        <button
                            class="delete-btn"
                            onclick={() => deleteUser(user.id)}
                            disabled={isLoading}
                        >
                            Delete
                        </button>
                    </div>
                {:else}
                    <div class="empty-state">
                        <p>No users yet. Add your first user above!</p>
                    </div>
                {/each}
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
    .database-demo {
        max-width: 800px;
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

    .add-user {
        background: #f8f9fa;
        padding: 20px;
        border-radius: 8px;
        margin: 20px 0;
        border: 1px solid #e9ecef;
    }

    .add-user h3 {
        margin-top: 0;
        color: #495057;
    }

    .form-group {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
    }

    .form-group input {
        flex: 1;
        min-width: 200px;
        padding: 10px;
        border: 1px solid #ced4da;
        border-radius: 4px;
        font-size: 14px;
    }

    .form-group input:focus {
        outline: none;
        border-color: #007bff;
        box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.25);
    }

    .form-group button {
        background: #007bff;
        color: white;
        padding: 10px 20px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        white-space: nowrap;
    }

    .form-group button:hover:not(:disabled) {
        background: #0056b3;
    }

    .form-group button:disabled {
        background: #6c757d;
        cursor: not-allowed;
    }

    .users-section {
        margin: 20px 0;
    }

    .users-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 15px;
    }

    .users-header h3 {
        margin: 0;
        color: #495057;
    }

    .header-buttons {
        display: flex;
        gap: 8px;
    }

    .refresh-btn {
        background: #28a745;
        color: white;
        padding: 6px 12px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .refresh-btn:hover:not(:disabled) {
        background: #218838;
    }

    .refresh-btn:disabled {
        background: #6c757d;
        cursor: not-allowed;
    }

    .clear-btn {
        background: #dc3545;
        color: white;
        padding: 6px 12px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
    }

    .clear-btn:hover:not(:disabled) {
        background: #c82333;
    }

    .loading {
        text-align: center;
        color: #6c757d;
        padding: 20px;
    }

    .users-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .user-card {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 15px;
        border: 1px solid #e9ecef;
        border-radius: 6px;
        background: white;
        transition: box-shadow 0.2s;
    }

    .user-card:hover {
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .user-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .user-info strong {
        color: #212529;
        font-size: 16px;
    }

    .email {
        color: #6c757d;
        font-size: 14px;
    }

    .date {
        color: #adb5bd;
        font-size: 12px;
    }

    .delete-btn {
        background: #dc3545;
        color: white;
        border: none;
        padding: 6px 12px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
    }

    .delete-btn:hover:not(:disabled) {
        background: #c82333;
    }

    .delete-btn:disabled {
        background: #6c757d;
        cursor: not-allowed;
    }

    .empty-state {
        text-align: center;
        padding: 40px 20px;
        color: #6c757d;
        background: #f8f9fa;
        border-radius: 6px;
        border: 2px dashed #dee2e6;
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

    @media (max-width: 600px) {
        .form-group {
            flex-direction: column;
        }

        .form-group input {
            min-width: unset;
        }

        .user-card {
            flex-direction: column;
            gap: 10px;
            align-items: stretch;
        }

        .users-header {
            flex-direction: column;
            gap: 10px;
            align-items: stretch;
        }

        .header-buttons {
            justify-content: center;
        }
    }
</style>
