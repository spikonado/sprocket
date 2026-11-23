import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	base: '/demo/',
	publicDir: 'static',
	worker: { format: 'es' },
	build: {
		outDir: path.resolve('../site/public/demo'),
		emptyOutDir: true,
		assetsDir: '_app/immutable',
		rollupOptions: { input: 'demo.html' }
	},
	resolve: { alias: { $lib: path.resolve('./src/lib'), '@convex': path.resolve('./convex') } },
	plugins: [tailwindcss(), react()]
});
