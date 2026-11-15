import { describe, expect, it, vi } from 'vitest';
import { Marked } from 'marked';

import {
	createMarkdownBlockRenderer,
	renderMarkdown,
	renderMarkdownBlocks,
	type MarkdownBlock
} from '$lib/chat/markdown';

describe('renderMarkdown', () => {
	it.each([
		['dollar inline', String.raw`The result is $x^2 + y_1$.`, false],
		['parenthesis inline', String.raw`The result is \(x^2 + y_1\).`, false],
		['dollar display', String.raw`$$\frac{1}{2}$$`, true],
		['bracket display', String.raw`\[\frac{1}{2}\]`, true],
		['multiline display', '$$\n\\begin{aligned}x &= 1 \\\\\ny &= 2\\end{aligned}\n$$', true],
		['matrix', String.raw`\[\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}\]`, true],
		['nested radicals', String.raw`$\sqrt{1 + \sqrt{x}}$`, false],
		['limits', String.raw`\[\sum_{n=1}^{\infty}\frac{1}{n^2} = \frac{\pi^2}{6}\]`, true],
		['reflected text', String.raw`$\reflectbox{ABC}$`, false],
		['maps from', String.raw`$A \mapsfrom B$`, false]
	])('renders %s math with accessible markup', (_case, markdown, display) => {
		const html = renderMarkdown(markdown);

		expect(html).toContain('class="katex"');
		expect(html).toContain('<math');
		expect(html).toContain('class="katex-html" aria-hidden="true"');
		expect(html.includes('class="katex-display"')).toBe(display);
		expect(html).not.toContain('class="katex-error"');
		expect(html).not.toContain('<annotation');
	});

	it('keeps Unicode text readable when KaTeX lacks font metrics', () => {
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			const html = renderMarkdown(String.raw`$\text{λ}$ and $x^2$`);

			expect(html).toContain('<mtext>λ</mtext>');
			expect(html.match(/class="katex"/g)).toHaveLength(2);
			expect(html).not.toContain('class="katex-error"');
			expect(warning).not.toHaveBeenCalled();
		} finally {
			warning.mockRestore();
		}
	});

	it.each([
		[String.raw`*before $a*b$ after*`, 'em'],
		[String.raw`**before \(a*b\) after**`, 'strong'],
		[String.raw`_before $a_b$ after_`, 'em'],
		[String.raw`~~before $a~~b$ after~~`, 'del']
	])('preserves math within Markdown emphasis: %s', (markdown, tag) => {
		const html = renderMarkdown(markdown);

		expect(html).toContain(`<${tag}>before <span class="katex">`);
		expect(html).toContain(` after</${tag}>`);
	});

	it('preserves currency next to code and formatting around literal dollars', () => {
		expect(renderMarkdown('Costs $5; use `$HOME` for the path.')).toBe(
			'<p>Costs $5; use <code>$HOME</code> for the path.</p>\n'
		);

		const html = renderMarkdown('*before `$x`* and **$y$**');

		expect(html).toContain('<em>before <code>$x</code></em> and <strong><span class="katex">');
		expect(html).toContain('</span></strong>');
		expect(renderMarkdown(String.raw`*before \$x* and **$y$**`)).toContain(
			'<em>before $x</em> and <strong><span class="katex">'
		);
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

	it('keeps same-marker fences nested inside a Markdown code block', () => {
		const notes = '## Use it now\n\n```sh\nnpx usesprocket\n```\n\n## Changes';

		expect(renderMarkdown(`Notes:\n\n\`\`\`markdown\n${notes}\n\`\`\`\n\nDone.`)).toBe(
			'<p>Notes:</p>\n' +
				'<pre><code class="language-markdown">## Use it now\n\n```sh\nnpx usesprocket\n```\n\n## Changes\n</code></pre>\n' +
				'<p>Done.</p>\n'
		);
		expect(renderMarkdown('````markdown\n```sh\nnpx sprocket\n````\n\nDone.')).toContain(
			'</code></pre>\n<p>Done.</p>'
		);
	});
});

describe('renderMarkdownBlocks', () => {
	it('renders a visual once its fence closes', () => {
		const visual = '```jsx-visual\nfunction App() {}\n';

		expect(renderMarkdownBlocks(`Before\n\n${visual}\`\`\``, new Set())).toEqual([
			{ type: 'html', html: '<p>Before</p>\n' },
			{ type: 'visual', kind: 'react', source: 'function App() {}' }
		]);
		expect(renderMarkdownBlocks(visual, new Set())).toEqual([
			{ type: 'html', html: expect.stringContaining('language-jsx-visual') }
		]);
		expect(renderMarkdownBlocks('````html-visual\n<pre>\n```\n', new Set())).toEqual([
			{ type: 'html', html: expect.stringContaining('language-html-visual') }
		]);
	});

	it('renders a Mermaid diagram once its fence closes', () => {
		const diagram = '```mermaid\ngraph TD\n  A --> B\n';

		expect(renderMarkdownBlocks(`${diagram}\`\`\``, new Set())).toEqual([
			{
				type: 'mermaid',
				source: 'graph TD\n  A --> B',
				codeHtml: expect.stringContaining('language-mermaid')
			}
		]);
		expect(renderMarkdownBlocks(diagram, new Set())).toEqual([
			{ type: 'html', html: expect.stringContaining('language-mermaid') }
		]);
	});

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

function mergeHtmlBlocks(blocks: MarkdownBlock[]) {
	const merged: MarkdownBlock[] = [];

	for (const block of blocks) {
		const previous = merged.at(-1);

		if (block.type === 'html' && previous?.type === 'html') {
			merged[merged.length - 1] = { type: 'html', html: previous.html + block.html };
		} else {
			merged.push(block);
		}
	}

	return merged;
}

describe('paragraph-cached Markdown', () => {
	it('reuses completed paragraphs and lexes only the unfinished tail', () => {
		const render = createMarkdownBlockRenderer();
		const ids = new Set<string>();
		const lexer = vi.spyOn(Marked.prototype, 'lexer');

		try {
			const first = render('**Finished.**\n \t\nDraft', ids);
			const appended = render('**Finished.**\n \t\nDraft grows', ids);

			expect(appended[0]).toBe(first[0]);
			expect(lexer).toHaveBeenLastCalledWith('Draft grows');
			expect(render('**Finished.**\n \t\nDraft grows', new Set())).toBe(appended);

			const completed = render('**Finished.**\n \t\nDraft grows\n\n', ids);
			const next = render('**Finished.**\n \t\nDraft grows\n\nNext', ids);

			expect(next[0]).toBe(first[0]);
			expect(next[1]).toBe(completed[1]);
			expect(lexer).toHaveBeenLastCalledWith('Next');
		} finally {
			lexer.mockRestore();
		}
	});

	it.each([
		['prose', '**First.**\n\nSecond with ~~strikethrough~~.\n\nThird.'],
		['references', '[guide][ref]\n\nartifact:known\n\n[ref]: https://example.com "Guide"'],
		['nested definitions', '[ref]\n\n> [ref]: https://example.com'],
		['lists', '- first\n\n- second\n\n  continuation\n\nAfter.'],
		['quotes', '> first\n\n> second\n\nAfter.'],
		['indented code', '    first\n\n    second\n\nAfter.'],
		['fences', '```mermaid\ngraph TD\n\nA --> B\n```\n\nAfter.'],
		['streaming JSON', '```json-render\n{"root":"ci","elements":{}}\n```'],
		['nested fences', '```markdown\nBefore\n\n```sh\necho hi\n```\n\nAfter\n```'],
		['tables', 'Name | Value\n--- | ---\nA | 1\n\nAfter.'],
		['setext headings', 'Heading\n---\n\nAfter.'],
		['HTML', '<div>\n\n**Inside**\n\n</div>\n\nAfter.'],
		['math', '$$x\n\n+ y$$\n\nAfter.'],
		['CRLF', 'First.\r\n\r\nSecond.'],
		['cards', 'artifact:known\n\nkicad:boards/main.kicad_pro\n\nAfter.']
	])('matches whole-document rendering at every append for %s', (_name, source) => {
		const render = createMarkdownBlockRenderer();
		const ids = new Set(['known']);

		for (let length = 0; length <= source.length; length++) {
			const content = 'Finished.\n\n' + source.slice(0, length);

			expect(mergeHtmlBlocks(render(content, ids, true)), content).toEqual(
				renderMarkdownBlocks(content, ids, true)
			);
		}
	});

	it('matches a full parse across initial chunks, replacements, and option changes', () => {
		const render = createMarkdownBlockRenderer();
		render('First.\n\n    ', new Set());
		expect(mergeHtmlBlocks(render('First.\n\n    code', new Set()))).toEqual(
			renderMarkdownBlocks('First.\n\n    code', new Set())
		);

		const content = 'artifact:known\n\nTail';

		expect(render(content, new Set(['known']))[0]).toEqual({
			type: 'artifact',
			artifactId: 'known'
		});
		expect(mergeHtmlBlocks(render(content, new Set()))).toEqual(
			renderMarkdownBlocks(content, new Set())
		);

		const replacement = 'Replacement\n\nhttps://example.com';
		render(replacement, new Set());
		expect(mergeHtmlBlocks(render(replacement, new Set(), true))).toEqual(
			renderMarkdownBlocks(replacement, new Set(), true)
		);
		expect(render('Shorter', new Set())).toEqual(renderMarkdownBlocks('Shorter', new Set()));
	});
});
