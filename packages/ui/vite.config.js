import path from 'node:path';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
	resolve: {
		alias: {
			$ui: path.resolve('./src')
		}
	},
	plugins: [svelte()]
});
