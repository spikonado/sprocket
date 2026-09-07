import adapterStatic from '@sveltejs/adapter-static';
import adapterVercel from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const hosted = process.env.PUBLIC_SPROCKET_HOSTED === 'true';

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
		adapter: hosted
			? adapterVercel()
			: adapterStatic({
					pages: 'dist',
					assets: 'dist',
					fallback: 'index.html',
					precompress: false,
					strict: true
				})
	}
};

export default config;
