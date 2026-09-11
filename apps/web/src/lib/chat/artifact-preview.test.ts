import { describe, expect, it } from 'vitest';
import { buildHtmlPreviewDocument, buildReactPreviewDocument } from './artifact-preview';

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
		expect(buildHtmlPreviewDocument('<p>hi</p>')).toContain('<p>hi</p>');
		expect(buildHtmlPreviewDocument('<p>hi</p>')).toContain('<!DOCTYPE html>');
	});
});
