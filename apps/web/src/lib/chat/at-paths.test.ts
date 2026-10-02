import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { applyPathSelection, getActiveAtMention } from './at-paths';

describe('workspace path mentions', () => {
	it('searches the mention at the caret with path case intact', () => {
		expect(getActiveAtMention('Compare @src/App.tsx with this', 16)).toEqual({
			query: 'src/App',
			start: 8,
			quoted: false
		});
		expect(getActiveAtMention('Inspect @', 9)?.query).toBe('');
		expect(getActiveAtMention('Inspect @"my project/so', 23)?.query).toBe('my project/so');
		expect(getActiveAtMention('Write to dev@example.com', 24)).toBeNull();
		expect(getActiveAtMention('Inspect @src/app.tsx ', 21)).toBeNull();
	});

	it('replaces the full token when selecting from its middle', () => {
		expect(
			applyPathSelection('Compare @src/old.ts with @tests', 12, {
				path: 'src/app.tsx',
				kind: 'file'
			})
		).toEqual({
			text: 'Compare [app.tsx](src/app.tsx) with @tests',
			caret: 'Compare [app.tsx](src/app.tsx) '.length
		});
	});

	it('inserts a Markdown link with the file name and workspace-relative path', () => {
		expect(
			applyPathSelection('Read @SKILL', 11, { path: 'apps/web/SKILL.md', kind: 'file' })
		).toEqual({
			text: 'Read [SKILL.md](apps/web/SKILL.md) ',
			caret: 'Read [SKILL.md](apps/web/SKILL.md) '.length
		});
	});

	it('escapes link destinations and marks directories with a trailing slash', () => {
		const selection = applyPathSelection('Inspect @my', 11, {
			path: 'my project',
			kind: 'directory'
		});

		expect(selection).toEqual({
			text: 'Inspect [my project](my%20project/) ',
			caret: 'Inspect [my project](my%20project/) '.length
		});
		expect(getActiveAtMention(selection?.text ?? '', selection?.caret ?? 0)).toBeNull();
		expect(
			applyPathSelection('Inspect @"my old" carefully', 12, {
				path: 'my "new" file.ts',
				kind: 'file'
			})?.text
		).toBe('Inspect [my "new" file.ts](my%20%22new%22%20file.ts) carefully');
	});

	it.each([
		['report [draft](v2).md', 'report [draft](v2).md'],
		['name#part?.md', 'name#part?.md'],
		['100%.md', '100%.md'],
		['my *file*_`name`<&>.md', 'my *file*_`name`&lt;&amp;&gt;.md'],
		['a\\b ~~old~~ &copy;.md', 'a\\b ~~old~~ &amp;copy;.md']
	])('preserves the name and destination of %s when rendered as Markdown', (name, renderedName) => {
		const path = `docs/${name}`;
		const selection = applyPathSelection('@doc', 4, { path, kind: 'file' });
		const tokens = marked.Lexer.lexInline(selection?.text.trim() ?? '');
		const link = tokens[0];

		expect(tokens).toHaveLength(1);

		if (link.type !== 'link') throw new Error('Expected a Markdown link');
		expect(decodeURIComponent(link.href)).toBe(path);
		expect(marked.parseInline(selection?.text.trim() ?? '')).toBe(
			`<a href="${link.href}">${renderedName}</a>`
		);
	});

	it('leaves completion closed when moving within an inserted link', () => {
		const text = '[SKILL.md](apps/web/SKILL.md)';

		for (let caret = 0; caret <= text.length; caret += 1) {
			expect(getActiveAtMention(text, caret)).toBeNull();
		}
	});
});
