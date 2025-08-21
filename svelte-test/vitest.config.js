import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';

export default defineConfig({
	plugins: [
		{
			name: 'sqlite-web-serve',
			configureServer(server) {
				server.middlewares.use('/pkg', (req, res, next) => {
					const filePath = req.url?.substring(1);
					const fullPath = path.join(process.cwd(), 'node_modules/sqlite-web', filePath || '');
					
					if (fs.existsSync(fullPath)) {
						if (fullPath.endsWith('.wasm')) {
							res.setHeader('Content-Type', 'application/wasm');
						} else if (fullPath.endsWith('.js')) {
							res.setHeader('Content-Type', 'application/javascript');
						}
						fs.createReadStream(fullPath).pipe(res);
					} else {
						next();
					}
				});
			}
		}
	],
	test: {
		// Browser mode configuration
		browser: {
			enabled: true,
			name: 'chromium',
			provider: 'playwright',
			// Enable necessary web APIs
			headless: true,
			// Allow access to OPFS, BroadcastChannel, etc.
			api: {
				port: 63315
			},
			// Add cross-origin isolation headers for SharedArrayBuffer and OPFS
			providerOptions: {
				launch: {
					args: [
						'--enable-features=SharedArrayBuffer',
						'--disable-web-security',
						'--allow-running-insecure-content',
						'--disable-features=VizDisplayCompositor'
					]
				}
			}
		},
		// Test configuration
		testTimeout: 30000, // 30 seconds for database operations
		hookTimeout: 10000, // 10 seconds for setup/teardown
		teardownTimeout: 10000,
		// Test file patterns  
		include: ['tests/**/*.test.{js,ts}'],
		exclude: [
			'**/node_modules/**',
			'**/dist/**',
			'**/.svelte-kit/**'
		],
		// Global test setup
		globalSetup: './tests/global-setup.js',
		// Environment setup for each test
		setupFiles: ['./tests/test-setup.js']
	},
	// Vite configuration for tests
	server: {
		fs: {
			allow: ['..']
		},
		headers: {
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cross-Origin-Opener-Policy': 'same-origin'
		}
	},
	optimizeDeps: {
		exclude: ['sqlite-web']
	},
	assetsInclude: ['**/*.wasm'],
	// Resolve configuration
	resolve: {
		alias: {
			'$lib': path.resolve('./src/lib')
		}
	}
});