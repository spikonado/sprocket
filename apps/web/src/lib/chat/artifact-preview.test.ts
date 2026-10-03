// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	buildArtifactPreviewDocument,
	buildHtmlPreviewDocument,
	buildReactPreviewDocument
} from './artifact-preview';

function parseContextMenuPreview(artifactType: 'html' | 'react', source: string) {
	const preview = buildArtifactPreviewDocument(artifactType, source, { contextMenu: true });

	if (preview === null) throw new Error('Expected a live preview document.');

	return { preview, parsed: new DOMParser().parseFromString(preview, 'text/html') };
}

describe('artifact-preview', () => {
	it('escapes script breakouts in react artifact source', () => {
		const doc = buildReactPreviewDocument('const x = "</script><script>alert(1)</script>"; <!--');
		expect(doc).not.toContain('</script><script>alert(1)</script>');
		expect(doc).not.toContain('<!--');
	});

	it('keeps literal script markup and jsx script elements intact', () => {
		expect(buildReactPreviewDocument('const html = "<script>";')).toContain('"<script>"');
		expect(buildReactPreviewDocument('const el = <script src="x" />;')).toContain(
			'<script src="x" />'
		);
	});

	it('passes through full html documents and wraps fragments', () => {
		const full = '<!DOCTYPE html><html><body>ok</body></html>';
		expect(buildHtmlPreviewDocument(full)).toBe(full);
		const fragment = buildHtmlPreviewDocument('<p>hi</p>');
		expect(fragment).toContain('<p>hi</p>');
		expect(fragment).toContain('<!DOCTYPE html>');
	});

	it('preserves scripts and comments containing head tags in a complete HTML preview', () => {
		const source =
			'<!DOCTYPE html><html><!-- <head> --><body><script>window.title = "<head>";</script><p>App</p></body></html>';

		const { preview, parsed } = parseContextMenuPreview('html', source);

		expect(parsed.doctype?.name).toBe('html');
		expect(parsed.querySelector('p')?.textContent).toBe('App');
		expect(preview.replace(parsed.scripts[0]!.outerHTML, '')).toBe(source);
		expect(parsed.scripts).toHaveLength(2);
		expect(parsed.scripts[0]?.textContent).toContain('sprocket-artifact-menu');
		expect(parsed.scripts[1]?.textContent).toBe('window.title = "<head>";');
	});

	it('installs the gesture bridge before scripts even when HTML tag attributes contain angle brackets', () => {
		const source =
			'<!DOCTYPE html><html data-label="<head>"><head data-label=">"><script>window.addEventListener("contextmenu", (event) => event.stopImmediatePropagation(), true);</script></head><body>App</body></html>';

		const { preview, parsed } = parseContextMenuPreview('html', source);

		expect(parsed.documentElement.getAttribute('data-label')).toBe('<head>');
		expect(parsed.head.getAttribute('data-label')).toBe('>');
		expect(preview.replace(parsed.scripts[0]!.outerHTML, '')).toBe(source);
		expect(parsed.scripts).toHaveLength(2);
		expect(parsed.scripts[0]?.textContent).toContain('sprocket-artifact-menu');
		expect(parsed.scripts[1]?.textContent).toContain('event.stopImmediatePropagation()');
	});

	it.each([undefined, {}, { contextMenu: false }, { contextMenu: true }])(
		'keeps markdown previews as text with options %j',
		(options) => {
			expect(buildArtifactPreviewDocument('markdown', '# Artifact', options)).toBeNull();
		}
	);

	it.each([
		{ artifactType: 'html' as const, source: '<p>App</p>', build: buildHtmlPreviewDocument },
		{
			artifactType: 'react' as const,
			source: 'function App() { return <p>App</p>; }',
			build: buildReactPreviewDocument
		}
	])(
		'adds the gesture bridge only when requested for $artifactType previews',
		({ artifactType, source, build }) => {
			const original = build(source);
			expect(buildArtifactPreviewDocument(artifactType, source)).toBe(original);
			expect(buildArtifactPreviewDocument(artifactType, source, {})).toBe(original);
			expect(buildArtifactPreviewDocument(artifactType, source, { contextMenu: false })).toBe(
				original
			);

			const { preview, parsed } = parseContextMenuPreview(artifactType, source);
			const bridge = parsed.scripts[0]!;
			expect(bridge.textContent).toContain('sprocket-artifact-menu');
			expect(preview.replace(bridge.outerHTML, '')).toBe(original);
		}
	);
});
