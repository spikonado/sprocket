import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { DEV_API_URL, WEB_DEV_PORT } from '../desktop/local-config.mjs';

export default defineConfig({
	publicDir: 'static',
	build: {
		// Rust gives this directory immutable caching and returns 404 for missing chunks.
		assetsDir: '_app/immutable'
	},
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib'),
			$convex: path.resolve('./src/convex'),
			'@convex': path.resolve('./src/convex'),
			'@web-lib': path.resolve('./src/lib')
		}
	},
	server: {
		port: WEB_DEV_PORT,
		strictPort: true,
		proxy: {
			'/api': {
				target: DEV_API_URL,
				changeOrigin: false
			}
		}
	},
	plugins: [tailwindcss(), react()],
	test: {
		// Component `/test` entrypoints use `import.meta.glob`; Vite must transform them.
		server: {
			deps: {
				inline: [
					'@firecrawl/firecrawl-convex',
					'@convex-dev/rate-limiter',
					'@exalabs/convex-exa',
					'@convex-dev/migrations',
					'@convex-dev/aggregate',
					'@convex-dev/action-retrier',
					'@convex-dev/workpool'
				]
			}
		},
		projects: [
			{
				extends: true,
				test: {
					name: 'convex',
					include: ['src/convex/**/*.test.{ts,js}'],
					environment: 'edge-runtime'
				}
			},
			{
				extends: true,
				test: {
					name: 'frontend',
					include: ['src/**/*.test.{ts,js}'],
					exclude: ['src/convex/**'],
					environment: 'node'
				}
			},
			{
				extends: true,
				test: {
					name: 'components',
					include: ['src/**/*.test.{tsx,jsx}'],
					setupFiles: ['src/test-setup.ts'],
					environment: 'jsdom'
				}
			}
		]
	}
});
