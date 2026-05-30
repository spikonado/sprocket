import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		alias: {
			'@convex': './src/convex',
			'@convex/*': './src/convex/*',
			'@web-lib': './src/lib',
			'@web-lib/*': './src/lib/*',
			$convex: './src/convex',
			'$convex/*': './src/convex/*'
		},
		adapter: adapter({
			pages: 'dist',
			assets: 'dist',
			fallback: 'index.html',
			precompress: false,
			strict: true
		})
	}
};

export default config;
