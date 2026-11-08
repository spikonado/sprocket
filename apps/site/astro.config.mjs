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
	// The Fontsource provider's variable files add opsz and wdth axes that change DM Sans glyph
	// metrics, so fonts load from the pinned @fontsource packages.
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'DM Sans',
			cssVariable: '--font-dm-sans',
			options: {
				variants: [
					{
						src: ['@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2'],
						weight: '100 1000',
						style: 'normal'
					}
				]
			}
		},
		{
			provider: fontProviders.local(),
			name: 'IBM Plex Sans',
			cssVariable: '--font-ibm-plex-sans',
			options: {
				variants: [
					{
						src: ['@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2'],
						weight: '100 700',
						style: 'normal'
					}
				]
			}
		},
		{
			provider: fontProviders.local(),
			name: 'IBM Plex Mono',
			cssVariable: '--font-ibm-plex-mono',
			fallbacks: ['monospace'],
			options: {
				variants: [
					{
						src: ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'],
						weight: 400,
						style: 'normal'
					},
					{
						src: ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'],
						weight: 500,
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
