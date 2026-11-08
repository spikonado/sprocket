// @ts-check

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import posthog from '@posthog/rollup-plugin';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';
import { SITE_URL } from './src/lib/seo.ts';

const { POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, VERCEL_GIT_COMMIT_SHA } = process.env;

// Uploads source maps so PostHog error tracking shows original code. Builds without the keys skip it.
const posthogSourceMaps =
	POSTHOG_PERSONAL_API_KEY && POSTHOG_PROJECT_ID
		? [
				posthog({
					personalApiKey: POSTHOG_PERSONAL_API_KEY,
					projectId: POSTHOG_PROJECT_ID,
					host: 'https://eu.i.posthog.com',
					sourcemaps: { releaseName: 'usesprocket.dev', releaseVersion: VERCEL_GIT_COMMIT_SHA }
				})
			]
		: [];

const monorepoRoot = path.resolve(import.meta.dirname, '../..');

// Bun's global store keeps the font files outside the repo, at `<store>/<entry>/node_modules/@fontsource/ibm-plex-mono`.
const bunGlobalStore = path.resolve(
	realpathSync(path.join(import.meta.dirname, 'node_modules/@fontsource/ibm-plex-mono')),
	'../../../..'
);

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	// No Astro.session usage on this site, so leave the session runtime out of the SSR bundle.
	session: false,
	security: {
		csp: {
			// Session replay's canvas encoder runs in a blob: worker.
			directives: ["worker-src 'self' blob:"],
			// PostHog loads its remote config and lazy extensions from the reverse proxy.
			scriptDirective: { resources: ["'self'", 'https://kpg.spikonado.com'] },
			// The Sprocket demos set `--step` in `style` attributes, which hashes can't cover.
			styleDirective: { resources: [{ resource: "'unsafe-inline'", kind: 'attribute' }] }
		}
	},
	integrations: [
		sitemap({
			filter: (page) => !page.includes('/api/')
		}),
		react()
	],
	adapter: vercel(),

	vite: {
		plugins: [tailwindcss(), ...posthogSourceMaps],
		server: { fs: { allow: [monorepoRoot, bunGlobalStore] } }
	}
});
