import { expect, test } from 'vitest';
import { safeExternalHref } from './href';

test.each([
	['https://example.com/pr/1', 'https://example.com/pr/1'],
	['HTTP://example.com', 'HTTP://example.com'],
	['/docs/notes.md', '/docs/notes.md'],
	['docs/notes.md', 'docs/notes.md'],
	['#section', '#section'],
	['./board.png', './board.png']
])('keeps %s', (href, kept) => {
	expect(safeExternalHref(href)).toBe(kept);
});

test.each([
	'javascript:alert(1)',
	' JavaScript:alert(1)',
	'data:text/html,<script>alert(1)</script>',
	'vbscript:msgbox(1)',
	'//evil.example',
	'mailto:user@example.com',
	''
])('drops %s', (href) => {
	expect(safeExternalHref(href)).toBeUndefined();
});
