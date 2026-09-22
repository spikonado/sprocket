import { describe, expect, it } from 'vitest';

import { renderMarkdown, renderMarkdownBlocks } from '$lib/chat/markdown';

describe('renderMarkdown', () => {
	it('sanitizes unsafe html', () => {
		const html = renderMarkdown('<script>alert("xss")</script><strong>safe</strong>');

		expect(html).not.toContain('<script>');
		expect(html).toContain('<strong>safe</strong>');
	});
});

describe('renderMarkdownBlocks', () => {
	it('replaces existing link targets when links should open in a new tab', () => {
		const blocks = renderMarkdownBlocks(
			'<a href="https://example.com" target="named-frame" rel="opener">example</a>',
			new Set(),
			true
		);

		expect(blocks).toEqual([
			{
				type: 'html',
				html: '<p><a target="_blank" rel="noopener noreferrer" href="https://example.com">example</a></p>\n'
			}
		]);
	});

	it('turns a known standalone artifact reference into a separate block', () => {
		expect(
			renderMarkdownBlocks(
				'Here is the result.\n\nartifact:ks73zzsnfj2najtd871p43f45s8ec23d\n\nDone.',
				new Set(['ks73zzsnfj2najtd871p43f45s8ec23d'])
			)
		).toEqual([
			{ type: 'html', html: '<p>Here is the result.</p>\n' },
			{ type: 'artifact', artifactId: 'ks73zzsnfj2najtd871p43f45s8ec23d' },
			{ type: 'html', html: '<p>Done.</p>\n' }
		]);
	});

	it.each([
		['unknown reference', 'artifact:missing'],
		['inline reference', 'See artifact:known for details.'],
		['inline code', '`artifact:known`'],
		['fenced code', '```text\nartifact:known\n```'],
		['block quote', '> artifact:known'],
		['list item', '- artifact:known'],
		['raw HTML', '<p>artifact:known</p>']
	])('leaves a %s as markdown', (_case, markdown) => {
		const blocks = renderMarkdownBlocks(markdown, new Set(['known']));

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: 'html',
			html: expect.stringContaining('artifact:')
		});
	});
});
