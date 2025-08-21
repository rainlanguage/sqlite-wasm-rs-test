# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

### Main Build Process
- `./bundle.sh` - Complete build pipeline that:
  1. Builds `sqlite-web-core` with `wasm-pack build --target web`
  2. Embeds WASM into JavaScript worker template
  3. Builds `sqlite-web` package with embedded core
  4. Packages with `npm pack` and updates Svelte test integration

### Individual Package Builds
- `cd packages/sqlite-web-core && wasm-pack build --target web --out-dir ../../pkg`
- `cd packages/sqlite-web && wasm-pack build --target web --out-dir ../../pkg`

### Testing
- `./test.sh` - Run all Rust WASM tests (both packages)
- `cd packages/sqlite-web-core && wasm-pack test --headless --chrome` - Test core package only
- `cd packages/sqlite-web && wasm-pack test --headless --chrome` - Test worker package only

### Svelte Test App
- `cd svelte-test && bun dev` - Start development server
- `cd svelte-test && bun build` - Production build
- `cd svelte-test && bun run check` - TypeScript checking with svelte-check

## Project Architecture

This is a **Rust WebAssembly SQLite Worker** project with a workspace architecture consisting of two main packages and a Svelte test application.

### Core Components

#### 1. `packages/sqlite-web-core/`
- **Purpose**: Core SQLite functionality and worker implementation
- **Key modules**:
  - `worker.rs` - Main worker entry point called by `worker_main()`
  - `database.rs` - SQLite database operations using `sqlite-wasm-rs`
  - `coordination.rs` - Worker coordination and messaging
  - `database_functions.rs` - Custom database functions (uses rain.math.float)
  - `messages.rs` - Message serialization/deserialization
- **Dependencies**: sqlite-wasm-rs, alloy (Ethereum tooling), rain-math-float
- **Output**: WASM module with JS glue code

#### 2. `packages/sqlite-web/`
- **Purpose**: Public API that creates self-contained workers with embedded core
- **Key files**:
  - `lib.rs` - `SQLiteWasmDatabase` struct with async query interface
  - `worker_template.rs` - Generates self-contained worker JavaScript
  - `embedded_worker.js` - Generated template with embedded WASM
- **Pattern**: Creates blob URLs from JavaScript code that includes base64-encoded WASM
- **Output**: Final WASM package that consumers can use

#### 3. `lib/rain.math.float/`
- **Purpose**: Mathematical floating-point operations library
- **Integration**: Custom functions accessible from SQLite via `database_functions.rs`
- **Architecture**: Solidity-compatible decimal float operations with Rust/WASM bindings

#### 4. `svelte-test/`
- **Purpose**: Integration test and example usage
- **Technology**: SvelteKit + TypeScript + Vite
- **Pattern**: Imports `sqlite-web` package from local tarball

### Build Process Flow

1. **Core Build**: `sqlite-web-core` compiled to WASM + JS glue
2. **Embedding**: WASM converted to base64 and embedded into JavaScript template
3. **Wrapper Build**: `sqlite-web` compiled with embedded worker generator
4. **Packaging**: NPM package created and integrated into Svelte test

### Key Design Patterns

- **Self-contained Workers**: No external WASM file dependencies
- **Async/Promise-based API**: JavaScript promises for query results
- **Workspace Dependencies**: Shared dependency versions across packages
- **Embedded WASM**: Base64-encoded WASM included directly in JavaScript

## Development Notes

- The build process creates a fully self-contained worker that includes all WASM code
- The `embedded_worker.js` file is generated and should not be manually edited
- Database functions from `rain.math.float` are available in SQLite queries
- Workers communicate via message passing with structured message types