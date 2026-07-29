import { describe, expect, it } from 'vitest';
import {
	buildArtifactPreviewDocument,
	buildHtmlPreviewDocument,
	buildReactPreviewDocument,
	parseArtifactType
} from './artifact-preview';

describe('artifact-preview', () => {
	it('parses known artifact types and falls back to markdown', () => {
		expect(parseArtifactType('react')).toBe('react');
		expect(parseArtifactType('html')).toBe('html');
		expect(parseArtifactType('markdown')).toBe('markdown');
		expect(parseArtifactType('nope')).toBe('markdown');
	});

	it('builds preview documents only for react and html', () => {
		expect(buildArtifactPreviewDocument('html', '<p>hi</p>')).toContain('<p>hi</p>');
		expect(buildArtifactPreviewDocument('markdown', '# hi')).toBeNull();
	});

	it('wraps react source in a document that mounts App', () => {
		const doc = buildReactPreviewDocument('function App() { return <h1>Hi</h1>; }');
		expect(doc).toContain('function App()');
		expect(doc).toContain('createRoot');
		expect(doc).toContain('text/babel');
		expect(doc).toContain('react@19');
		expect(buildArtifactPreviewDocument('react', 'function App(){return null}')).toContain(
			'function App()'
		);
	});

	it('escapes script breakouts in artifact source', () => {
		const doc = buildReactPreviewDocument(
			'const x = "</script><script>alert(1)</script>"; <!-- <script>'
		);
		expect(doc).not.toContain('</script><script>alert(1)</script>');
		expect(doc).not.toContain('<!--');
		expect(doc).not.toContain('<script>alert(1)');
	});

	it('passes through full html documents and wraps fragments', () => {
		const full = '<!DOCTYPE html><html><body>ok</body></html>';
		expect(buildHtmlPreviewDocument(full)).toBe(full);
		expect(buildHtmlPreviewDocument('<p>hi</p>')).toContain('<p>hi</p>');
		expect(buildHtmlPreviewDocument('<p>hi</p>')).toContain('<!DOCTYPE html>');
	});
});
