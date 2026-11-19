const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/;

const MARKDOWN_LANGUAGES = new Set(['markdown', 'md', 'mdx']);

type Fence = { marker: string; info: string; indent: number };

function parseFence(line: string): Fence | undefined {
	const match = FENCE.exec(line);

	if (!match || (match[2][0] === '`' && match[3].includes('`'))) return;

	return { marker: match[2], info: match[3], indent: match[1].length };
}

function canClose(line: Fence, open: Fence) {
	return line.marker[0] === open.marker[0] && line.marker.length >= open.marker.length;
}

function closes(line: Fence, open: Fence) {
	return !line.info && canClose(line, open);
}

function isMarkdownFence(fence: Fence) {
	return MARKDOWN_LANGUAGES.has(fence.info.split(/\s/, 1)[0].toLowerCase());
}

function withMarker(line: string, fence: Fence, length: number) {
	return line.replace(fence.marker, fence.marker[0].repeat(length));
}

/**
 * Models write Markdown examples with fences inside a `markdown` fence of the same length.
 * CommonMark closes the outer fence at the first inner one, so lengthen the outer markers.
 */
function lengthenNestedFence(lines: string[], start: number, outer: Fence) {
	const inner: Fence[] = [];
	let nested = false;
	let longest = outer.marker.length;
	let end = lines.length;

	for (let index = start + 1; index < lines.length; index++) {
		const fence = parseFence(lines[index]);
		const open = inner.at(-1);

		if (fence && canClose(fence, outer)) longest = Math.max(longest, fence.marker.length);

		if (fence && open && closes(fence, open)) {
			inner.pop();
		} else if (fence && !open && closes(fence, outer)) {
			end = index;
			break;
		} else if (fence?.info && !open && canClose(fence, outer)) {
			inner.push(fence);
			nested = true;
		}
	}

	if (!nested) return;

	lines[start] = withMarker(lines[start], outer, longest + 1);

	if (end < lines.length) lines[end] = withMarker(lines[end], parseFence(lines[end])!, longest + 1);

	return end;
}

export function prepareFences(source: string) {
	if (!/^ {0,3}(?:```|~~~)/m.test(source)) return { source, endsInFence: false };

	const lines = source.split('\n');
	let open: Fence | undefined;
	let nestedEnd: number | undefined;

	for (let index = 0; index < lines.length; index++) {
		const fence = parseFence(lines[index]);

		if (!fence) continue;

		if (open) {
			if (closes(fence, open)) open = undefined;
			continue;
		}

		nestedEnd = isMarkdownFence(fence) ? lengthenNestedFence(lines, index, fence) : undefined;

		if (nestedEnd === undefined) {
			open = fence;
		} else {
			index = nestedEnd;
		}
	}

	return {
		source: lines.join('\n'),
		endsInFence: open !== undefined || nestedEnd === lines.length
	};
}
