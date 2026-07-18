import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { DEV_API_URL, WEB_DEV_PORT } from '../desktop/local-config.mjs';

export default defineConfig({
	resolve: {
		alias: {
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
				changeOrigin: true
			}
		}
	},
	plugins: [tailwindcss(), sveltekit()],
	test: {
		// Component `/test` entrypoints use `import.meta.glob`; Vite must transform them.
		server: {
			deps: {
				inline: ['@context-dot-dev/convex', '@convex-dev/rate-limiter', '@exalabs/convex-exa']
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
			}
		]
	}
});
