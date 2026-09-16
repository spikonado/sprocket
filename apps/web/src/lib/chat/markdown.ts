import DOMPurify from 'isomorphic-dompurify';
import { marked, type Token } from 'marked';

marked.setOptions({
	gfm: true,
	breaks: true
});

function sanitizeMarkdown(rendered: string) {
	return DOMPurify.sanitize(rendered, {
		ADD_ATTR: ['target', 'rel']
	});
}

export function renderMarkdown(value: string) {
	return sanitizeMarkdown(marked.parse(value, { async: false }));
}

export type MarkdownBlock =
	{ type: 'html'; html: string } | { type: 'artifact'; artifactId: string };

const ARTIFACT_REFERENCE = /^\s*artifact:([A-Za-z0-9_-]+)\s*$/;

export function renderMarkdownBlocks(
	value: string,
	availableArtifactIds: ReadonlySet<string>
): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let markdownTokens: Token[] = [];

	const flushMarkdown = () => {
		if (markdownTokens.length === 0) return;
		const html = sanitizeMarkdown(marked.parser(markdownTokens));
		if (html) blocks.push({ type: 'html', html });
		markdownTokens = [];
	};

	for (const token of marked.lexer(value)) {
		const match = token.type === 'paragraph' ? ARTIFACT_REFERENCE.exec(token.raw) : null;
		const artifactId = match?.[1];
		if (!artifactId || !availableArtifactIds.has(artifactId)) {
			markdownTokens.push(token);
			continue;
		}

		flushMarkdown();
		blocks.push({ type: 'artifact', artifactId });
	}

	flushMarkdown();
	return blocks;
}
