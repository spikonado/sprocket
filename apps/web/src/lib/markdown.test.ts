import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '$lib/markdown';

describe('renderMarkdown', () => {
	it('renders common markdown formatting', () => {
		const html = renderMarkdown('## Heading\n\n- one\n- two\n\n`code`');

		expect(html).toContain('<h2>Heading</h2>');
		expect(html).toContain('<li>one</li>');
		expect(html).toContain('<code>code</code>');
	});

	it('sanitizes unsafe html', () => {
		const html = renderMarkdown('<script>alert("xss")</script><strong>safe</strong>');

		expect(html).not.toContain('<script>');
		expect(html).toContain('<strong>safe</strong>');
	});
});
