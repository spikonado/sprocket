import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '$lib/chat/markdown';

describe('renderMarkdown', () => {
	it('sanitizes unsafe html', () => {
		const html = renderMarkdown('<script>alert("xss")</script><strong>safe</strong>');

		expect(html).not.toContain('<script>');
		expect(html).toContain('<strong>safe</strong>');
	});
});
