import { describe, expect, it } from 'vitest';
import answer from './fixtures/streamed-answer.md?raw';
import {
	createMarkdownBlockRenderer,
	mergeHtmlBlocks,
	renderMarkdown,
	renderMarkdownBlocks,
	type MarkdownBlock
} from './markdown';

function streamEveryPrefix(text: string) {
	const render = createMarkdownBlockRenderer();
	const ids = new Set<string>();
	const snapshots: MarkdownBlock[][] = [];

	for (let length = 1; length <= text.length; length++) {
		snapshots.push(render(text.slice(0, length), ids, true));
	}

	return snapshots;
}

describe('streamed Markdown', () => {
	it('ends with the one-shot render after streaming every prefix of an answer', () => {
		const snapshots = streamEveryPrefix(answer);

		expect(mergeHtmlBlocks(snapshots.at(-1)!)).toEqual(
			renderMarkdownBlocks(answer, new Set(), true)
		);

		for (const length of [400, 1200, 2100, 3000]) {
			const prefix = answer.slice(0, length);

			expect(mergeHtmlBlocks(snapshots[length - 1]), prefix).toEqual(
				renderMarkdownBlocks(prefix, new Set(), true)
			);
		}
	});

	it('keeps finished blocks while the answer streams', () => {
		const snapshots = streamEveryPrefix(answer);
		const heading = snapshots[100][0];

		const finishedCode = snapshots
			.flat()
			.find((block) => block.type === 'html' && block.html.startsWith('<pre><code'));

		expect(heading).toMatchObject({ type: 'html', html: expect.stringContaining('<h2>') });
		expect(snapshots.at(-1)![0]).toBe(heading);
		expect(snapshots.at(-1)).toContain(finishedCode);
	});

	it('matches the one-shot render at every prefix of math with every delimiter', () => {
		const source = String.raw`Inline \(a^2\) and $b_1$, then` + '\n\n\\[c\\]\n\n$$d$$';
		const snapshots = streamEveryPrefix(source);

		snapshots.forEach((blocks, index) => {
			const prefix = source.slice(0, index + 1);

			expect(mergeHtmlBlocks(blocks), prefix).toEqual(
				renderMarkdownBlocks(prefix, new Set(), true)
			);
		});
	});

	it('updates earlier blocks when a later reference definition resolves them', () => {
		const render = createMarkdownBlockRenderer();
		const before = render('[guide][ref] and a note[^1].\n\nMore.\n\n', new Set());

		const after = render(
			'[guide][ref] and a note[^1].\n\nMore.\n\n[ref]: https://example.com\n\n[^1]: Note.',
			new Set()
		);

		expect(before[0]).toEqual({ type: 'html', html: '<p>[guide][ref] and a note[^1].</p>\n' });
		expect(after[0]).toMatchObject({
			html: expect.stringContaining('<a href="https://example.com">guide</a>')
		});
		expect(after[1]).toBe(before[1]);
		expect(after.at(-1)).toMatchObject({ html: expect.stringContaining('Note.') });
	});

	it('splits a known artifact reference into its own block as soon as it streams', () => {
		const render = createMarkdownBlockRenderer();
		const ids = new Set(['known']);
		const intro = render('Intro\n\nartifact:know', ids);
		const reference = render('Intro\n\nartifact:known', ids);
		const done = render('Intro\n\nartifact:known\n\nDone.', ids);

		expect(intro).toEqual([
			{ type: 'html', html: '<p>Intro</p>\n' },
			{ type: 'html', html: '<p>artifact:know</p>\n' }
		]);
		expect(reference[1]).toEqual({ type: 'artifact', artifactId: 'known' });
		expect(done).toEqual([intro[0], reference[1], { type: 'html', html: '<p>Done.</p>\n' }]);
		expect(done[0]).toBe(intro[0]);
	});

	it('turns only Markdown reference paragraphs into cards', () => {
		const render = createMarkdownBlockRenderer();
		const ids = new Set(['known']);
		render('<p>artifact:known</p>', ids);

		expect(render('<p>artifact:known</p>\n\nartifact:known', ids)).toEqual([
			{ type: 'html', html: '<p>artifact:known</p>\n' },
			{ type: 'artifact', artifactId: 'known' }
		]);
	});

	it('shows the private-use characters it reserves as replacement characters', () => {
		expect(renderMarkdown('a \uE0000\uE001 and $x$')).toMatch(
			/^<p>a \uFFFD0\uFFFD and <span class="katex">/
		);
	});

	it('renders soft line breaks as <br> outside code', () => {
		expect(
			renderMarkdown(
				'one\ntwo **bold**\n_em_\n\n- item\n  more\n\n> quote\n> more\n\n`a\nb`\n\n```\nc\nd\n```\n\n| x |\n| - |\n| y |'
			)
		).toBe(
			'<p>one<br>two <strong>bold</strong><br><em>em</em></p>\n' +
				'<ul>\n<li>item<br>more</li>\n</ul>\n' +
				'<blockquote>\n<p>quote<br>more</p>\n</blockquote>\n' +
				'<p><code>a b</code></p>\n' +
				'<pre><code>c\nd\n</code></pre>\n' +
				'<table>\n<thead>\n<tr>\n<th>x</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>y</td>\n</tr>\n</tbody>\n</table>\n'
		);
	});
});
