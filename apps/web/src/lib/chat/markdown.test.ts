import { describe, expect, it } from 'vitest';

import { renderMarkdown, renderMarkdownBlocks } from '$lib/chat/markdown';

describe('renderMarkdown', () => {
	it.each([
		['dollar inline', String.raw`The result is $x^2 + y_1$.`, false],
		['parenthesis inline', String.raw`The result is \(x^2 + y_1\).`, false],
		['dollar display', String.raw`$$\frac{1}{2}$$`, true],
		['bracket display', String.raw`\[\frac{1}{2}\]`, true],
		['multiline display', '$$\n\\begin{aligned}x &= 1 \\\\\ny &= 2\\end{aligned}\n$$', true]
	])('renders %s math with accessible markup', (_case, markdown, display) => {
		const html = renderMarkdown(markdown);

		expect(html).toContain('class="katex"');
		expect(html).toContain('<math');
		expect(html).toContain('class="katex-html" aria-hidden="true"');
		expect(html.includes('class="katex-display"')).toBe(display);
	});

	it.each([
		String.raw`*before $a*b$ after*`,
		String.raw`**before \(a*b\) after**`,
		String.raw`_before $a_b$ after_`,
		String.raw`~~before $a~~b$ after~~`
	])('preserves math within Markdown emphasis: %s', (markdown) => {
		const html = renderMarkdown(markdown);

		expect(html).toContain('class="katex"');
	});

	it.each([
		['currency', 'Costs $5 and $10.'],
		['escaped dollars', String.raw`Use \$x\$ literally.`],
		['inline code', '`$x^2$` and `\\(y_1\\)`'],
		['fenced code', '```latex\n$x^2$\n\\[y_1\\]\n```'],
		['indented code', '    $$x^2$$'],
		['raw code', String.raw`<code>$x^2$</code>`],
		['unfinished inline math', String.raw`The result is $\frac{1}`]
	])('keeps %s readable as literal text', (_case, markdown) => {
		const html = renderMarkdown(markdown);

		expect(html).not.toContain('class="katex"');
		expect(html).toContain('$');
	});

	it('keeps malformed math readable alongside valid math', () => {
		const html = renderMarkdown(String.raw`$\frac{$ and $x^2$`);

		expect(html).toContain('class="katex-error"');
		expect(html).toContain('\\frac{');
		expect(html).toContain('class="katex"');
	});

	it('sanitizes unsafe html', () => {
		const html = renderMarkdown('<script>alert("xss")</script><strong>safe</strong>');

		expect(html).not.toContain('<script>');
		expect(html).toContain('<strong>safe</strong>');
	});
});

describe('renderMarkdownBlocks', () => {
	it('renders math on both sides of an artifact reference', () => {
		const blocks = renderMarkdownBlocks('$x^2$\n\nartifact:known\n\n\\[y_1\\]', new Set(['known']));

		expect(blocks).toEqual([
			{ type: 'html', html: expect.stringContaining('class="katex"') },
			{ type: 'artifact', artifactId: 'known' },
			{ type: 'html', html: expect.stringContaining('class="katex-display"') }
		]);
	});

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
