import { rename } from 'node:fs/promises';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const outDir = path.resolve('../site/public/demo');

const demoIndex: Plugin = {
	name: 'demo-index',
	apply: 'build',
	async closeBundle() {
		await rename(path.join(outDir, 'demo.html'), path.join(outDir, 'index.html'));
	}
};

export default defineConfig({
	base: '/demo/',
	publicDir: 'static',
	worker: { format: 'es' },
	build: {
		outDir,
		emptyOutDir: true,
		assetsDir: '_app/immutable',
		rollupOptions: { input: 'demo.html' }
	},
	resolve: { alias: { $lib: path.resolve('./src/lib'), '@convex': path.resolve('./convex') } },
	plugins: [tailwindcss(), react(), demoIndex]
});
