import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { API_URL, WEB_DEV_PORT } from '../../scripts/dev-config.mjs';

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
				target: API_URL,
				changeOrigin: true
			}
		}
	},
	plugins: [tailwindcss(), sveltekit()]
});
