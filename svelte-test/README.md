# SQLite Worker - Svelte Integration Example

This is a SvelteKit application that demonstrates integration with the SQLite Worker WASM package. It shows how to use browser-native SQLite database with persistent storage in a modern frontend framework.

## Features

- **SQLite Worker Integration** - Uses the parent project's WASM SQLite implementation
- **TypeScript Support** - Full type safety with generated WASM bindings
- **SvelteKit Framework** - Modern Svelte application with routing and components
- **Local Package Dependency** - Consumes the SQLite worker as a local package

## Getting Started

### Prerequisites

Make sure the parent SQLite Worker project is built:

```sh
# From the root directory
wasm-pack build --target web
```

### Installation

```sh
# Install dependencies
bun install  # or npm install
```

### Development

Start the development server:

```sh
bun run dev  # or npm run dev

# or start the server and open in browser
bun run dev -- --open
```

### Building

To create a production version:

```sh
bun run build  # or npm run build
```

Preview the production build:

```sh
bun run preview  # or npm run preview
```

## Project Structure

```
src/
├── routes/
│   ├── +page.svelte        # Main application page
│   └── +layout.svelte      # Layout component
├── lib/                    # Shared utilities
└── app.html               # HTML template
```

## SQLite Worker Usage

The project imports and uses the SQLite worker package:

```javascript
import init, { DatabaseConnection } from 'sqlite-web';

// Initialize WASM module
await init();

// Create database connection
const db = new DatabaseConnection();

// Execute queries
const result = await db.query("SELECT * FROM users");
```

## Dependencies

- **sqlite-web** - Local WASM package from `../pkg/sqlite-web-0.1.0.tgz`
- **@sveltejs/kit** - SvelteKit framework
- **vite** - Build tool and development server
- **typescript** - Type checking and compilation

## Deployment

For deployment, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

The SQLite worker requires:
- HTTPS in production (for OPFS support)
- Proper MIME types for WASM files
- COOP/COEP headers for SharedArrayBuffer (if used)
