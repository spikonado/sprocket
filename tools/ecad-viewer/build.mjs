// Usage: node build.mjs <fork checkout> <output directory>
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [fork, out] = process.argv.slice(2).map((path) => resolve(path));
const app = resolve(fork, 'packages/ecad-viewer-app');

const { bundle, CSSMinifyPlugin } = await import(
	pathToFileURL(resolve(app, 'scripts/bundle.js')).href
);

const shared = {
	outdir: out,
	minify: true,
	legalComments: 'none',
	resolveExtensions: ['.ts', '.js'],
	alias: { 'kicad-parser': resolve(fork, 'packages/kicad-parser/src') },
	// The fork logs every step of every load.
	pure: ['console.log', 'console.info', 'console.debug'],
	plugins: [CSSMinifyPlugin],
	logLevel: 'warning'
};

const builds = [
	{ entryPoints: { 'ecad-viewer': resolve(app, 'src/index.ts') } },
	{ entryPoints: { 'glyph-full': resolve(app, 'src/glyph/index.ts') } },
	// The frame's opaque origin can only start classic workers from blob URLs. The wasm glue
	// reads `import.meta.url` only to find files the inlined wasm doesn't need.
	{
		entryPoints: { 'parser.worker': resolve(app, 'src/kicanvas/parser.worker.ts') },
		format: 'iife',
		logOverride: { 'empty-import-meta': 'silent' }
	}
];

for (const options of builds) {
	const { context } = await bundle({ ...shared, ...options });
	await context.rebuild();
	await context.dispose();
}
