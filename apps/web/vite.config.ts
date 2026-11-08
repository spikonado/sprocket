import { realpathSync } from 'node:fs';
import path from 'node:path';
import posthog from '@posthog/rollup-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { searchForWorkspaceRoot, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { DEV_API_URL, WEB_DEV_PORT } from '../desktop/local-config.mjs';

const { POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, SPROCKET_RELEASE_VERSION } = process.env;

const IMMUTABLE_ASSETS_DIR = '_app/immutable';

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

const kicadFramePaths = [
	'/ecad-viewer/',
	'/src/lib/kicad-frame/',
	'/@vite/client',
	'/@react-refresh',
	'/node_modules/'
];

// The sandboxed KiCad viewer frame has an opaque origin, so all its requests are cross-origin.
// Like the Rust server's built assets, its own modules and package code may be read by any origin.
const kicadFrameCors: Plugin = {
	name: 'kicad-frame-cors',
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			let url: string;

			try {
				// Normalized like Vite does, so `..` can't step out of `node_modules`.
				url = path.posix.normalize(decodeURIComponent(new URL(req.url ?? '', 'http://x').pathname));
			} catch {
				return next();
			}

			if (
				kicadFramePaths.some((prefix) => url.startsWith(prefix)) ||
				(url.startsWith('/@fs/') && url.includes('/node_modules/'))
			) {
				res.setHeader('Access-Control-Allow-Origin', '*');
			}

			next();
		});
	}
};

// Bun's global store keeps package files outside the repo, at `<store>/<entry>/node_modules/react`.
const bunGlobalStore = path.resolve(
	realpathSync(path.join(import.meta.dirname, 'node_modules/react')),
	'../../..'
);

export default defineConfig({
	publicDir: 'static',
	worker: { format: 'es' },
	build: {
		assetsDir: IMMUTABLE_ASSETS_DIR,
		rolldownOptions: {
			input: ['index.html', 'kicad-viewer.html']
		}
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
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd()), bunGlobalStore]
		},
		proxy: {
			'/api': {
				target: DEV_API_URL,
				changeOrigin: false,
				ws: true
			}
		}
	},
	plugins: [tailwindcss(), react(), kicadFrameCors, ...posthogSourceMaps],
	test: {
		// Component `/test` entrypoints use `import.meta.glob`; Vite must transform them.
		server: {
			deps: {
				inline: [
					'@convex-dev/rate-limiter',
					'@exalabs/convex-exa',
					'@convex-dev/migrations',
					'@convex-dev/aggregate',
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
