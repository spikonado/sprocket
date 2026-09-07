import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { DEV_API_URL, WEB_DEV_PORT } from '../desktop/local-config.mjs';

const hosted = process.env.PUBLIC_SPROCKET_HOSTED === 'true';

export default defineConfig({
	define: {
		'import.meta.env.PUBLIC_SPROCKET_HOSTED': JSON.stringify(hosted ? 'true' : 'false')
	},
	resolve: {
		alias: {
			'@convex': path.resolve('./src/convex'),
			'@web-lib': path.resolve('./src/lib')
		}
	},
	server: {
		port: WEB_DEV_PORT,
		strictPort: true,
		proxy: hosted
			? undefined
			: {
					'/api': {
						target: DEV_API_URL,
						changeOrigin: false
					}
				}
	},
	plugins: [tailwindcss(), sveltekit()],
	test: {
		// Component `/test` entrypoints use `import.meta.glob`; Vite must transform them.
		server: {
			deps: {
				inline: [
					'@context-dot-dev/convex',
					'@convex-dev/rate-limiter',
					'@exalabs/convex-exa',
					'@convex-dev/migrations',
					'@convex-dev/aggregate',
					'@convex-dev/workflow',
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
					exclude: ['src/convex/**', 'src/**/*.svelte.test.{ts,js}'],
					environment: 'node'
				}
			},
			{
				extends: true,
				resolve: { conditions: ['browser'] },
				test: {
					name: 'components',
					include: ['src/**/*.svelte.test.{ts,js}'],
					environment: 'jsdom'
				}
			}
		]
	}
});
