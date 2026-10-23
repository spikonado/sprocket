import path from 'node:path';
import posthog from '@posthog/rollup-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { DEV_API_URL, WEB_DEV_PORT } from '../desktop/local-config.mjs';

const { POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, SPROCKET_RELEASE_VERSION } = process.env;

// Release builds upload source maps for PostHog error tracking; builds without the keys skip it.
const posthogSourceMaps =
	POSTHOG_PERSONAL_API_KEY && POSTHOG_PROJECT_ID
		? [
				posthog({
					personalApiKey: POSTHOG_PERSONAL_API_KEY,
					projectId: POSTHOG_PROJECT_ID,
					host: 'https://eu.i.posthog.com',
					sourcemaps: { releaseName: 'sprocket-app', releaseVersion: SPROCKET_RELEASE_VERSION }
				})
			]
		: [];

export default defineConfig({
	publicDir: 'static',
	worker: { format: 'es' },
	build: {
		// Rust gives this directory immutable caching and returns 404 for missing chunks.
		assetsDir: '_app/immutable'
	},
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib'),
			'@convex': path.resolve('./convex')
		}
	},
	server: {
		port: WEB_DEV_PORT,
		strictPort: true,
		proxy: {
			'/api': {
				target: DEV_API_URL,
				changeOrigin: false,
				ws: true
			}
		}
	},
	plugins: [tailwindcss(), react(), ...posthogSourceMaps],
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
					'@convex-dev/workpool',
					'@posthog/convex'
				]
			}
		},
		projects: [
			{
				extends: true,
				test: {
					name: 'convex',
					include: ['convex/**/*.test.{ts,js}'],
					environment: 'edge-runtime'
				}
			},
			{
				extends: true,
				test: {
					name: 'frontend',
					include: ['src/**/*.test.{ts,js}'],
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
