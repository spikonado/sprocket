import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	resolve: {
		alias: {
			'@convex': path.resolve('./src/convex'),
			'@web-lib': path.resolve('./src/lib')
		}
	},
	server: {
		port: 5173,
		strictPort: true
	},
	plugins: [tailwindcss(), sveltekit()]
});
