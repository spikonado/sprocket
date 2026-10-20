import type { MarkedExtension, Tokens } from 'marked';

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/;

const MARKDOWN_LANGUAGES = new Set(['markdown', 'md', 'mdx']);

type Fence = { marker: string; info: string; indent: number };

function parseFence(line: string): Fence | undefined {
	const match = FENCE.exec(line);

	if (!match || (match[2][0] === '`' && match[3].includes('`'))) return;

	return { marker: match[2], info: match[3], indent: match[1].length };
}

function closes(line: Fence, open: Fence) {
	return (
		!line.info && line.marker[0] === open.marker[0] && line.marker.length >= open.marker.length
	);
}

function nestedMarkdownFence(source: string): Tokens.Code | undefined {
	const firstLineEnd = source.indexOf('\n');
	const outer = parseFence(firstLineEnd === -1 ? source : source.slice(0, firstLineEnd));
	const language = outer?.info.split(/\s/, 1)[0].toLowerCase();

	if (!outer || !language || !MARKDOWN_LANGUAGES.has(language) || firstLineEnd === -1) return;

	// Agents often nest fences with the same marker inside a Markdown block. An inner fence that
	// names a language must open a nested block, so the next bare fence closes it instead of ours.
	const inner: Fence[] = [];
	const content: string[] = [];
	let nested = false;
	let end = source.length;
	let lineStart = firstLineEnd + 1;

	while (lineStart < source.length) {
		const lineEnd = source.indexOf('\n', lineStart);
		const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
		const fence = parseFence(line);
		const open = inner.at(-1);

		if (fence && open && closes(fence, open)) {
			inner.pop();
		} else if (fence && !open && closes(fence, outer)) {
			end = lineStart + line.length;
			break;
		} else if (fence?.info && !open) {
			inner.push(fence);
			nested = true;
		}

		content.push(line.replace(new RegExp(`^ {0,${outer.indent}}`), ''));

		if (lineEnd === -1) break;
		lineStart = lineEnd + 1;
	}

	if (!nested) return;

	return {
		type: 'code',
		raw: source.slice(0, end),
		lang: outer.info,
		text: content.join('\n')
	};
}

export const markdownFences: MarkedExtension = {
	tokenizer: {
		fences(source) {
			return nestedMarkdownFence(source) ?? false;
		}
	}
};
