// @ts-check

import { defineConfig, envField, fontProviders } from 'astro/config';
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

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	// No Astro.session usage on this site, so leave the session runtime out of the SSR bundle.
	session: false,
	security: {
		csp: {
			// Sources follow https://posthog.com/docs/advanced/content-security-policy so replay,
			// surveys, and the PostHog and Vercel toolbars all load.
			directives: ["worker-src 'self' blob: data:"],
			scriptDirective: {
				resources: [
					"'self'",
					'https://kpg.spikonado.com',
					'https://*.posthog.com',
					'https://vercel.live'
				]
			},
			// Surveys and both toolbars inject <style> elements, which hashes can't cover.
			styleDirective: {
				resources: ["'self'", "'unsafe-inline'", 'https://*.posthog.com', 'https://vercel.live']
			}
		}
	},
	integrations: [
		sitemap({
			filter: (page) => !page.includes('/api/')
		}),
		react()
	],
	adapter: vercel(),
	env: {
		schema: {
			PUBLIC_POSTHOG_KEY: envField.string({ context: 'client', access: 'public', optional: true }),
			PUBLIC_CONVEX_URL: envField.string({ context: 'client', access: 'public', optional: true }),
			WORKOS_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
			WORKOS_COOKIE_PASSWORD: envField.string({
				context: 'server',
				access: 'secret',
				optional: true
			})
		}
	},
	// Fonts load from the pinned @fontsource packages so the site serves the same files as the web app.
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Geist',
			cssVariable: '--font-geist-sans',
			options: {
				variants: [
					{
						src: ['@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'],
						weight: '100 900',
						style: 'normal'
					}
				]
			}
		},
		{
			provider: fontProviders.local(),
			name: 'Geist Mono',
			cssVariable: '--font-geist-mono',
			fallbacks: ['monospace'],
			options: {
				variants: [
					{
						src: ['@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2'],
						weight: '100 900',
						style: 'normal'
					}
				]
			}
		}
	],

	vite: {
		plugins: [tailwindcss(), ...posthogSourceMaps]
	}
});
