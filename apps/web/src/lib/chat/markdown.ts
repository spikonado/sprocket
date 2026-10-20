import DOMPurify from 'isomorphic-dompurify';
import { Marked, type Token } from 'marked';
import { isWindowsImagePath, stripImageFileScheme } from './markdown-image-path';
import { markdownMath } from './markdown-math';

const marked = new Marked({ gfm: true, breaks: true }, markdownMath);

DOMPurify.addHook('uponSanitizeAttribute', (node, attribute) => {
	const isPath =
		(node.nodeName === 'IMG' && attribute.attrName === 'src') ||
		(node.nodeName === 'A' && attribute.attrName === 'href');

	if (!isPath) return;

	const source = stripImageFileScheme(attribute.attrValue);

	// DOMPurify reads `C:` and the `README.md:` in `README.md:12` as URL schemes and drops them.
	attribute.attrValue = isWindowsImagePath(source)
		? `${source[0]}%3A${source.slice(2)}`
		: source.replace(
				/^(?!(?:callto|cid|mailto|matrix|sms|tel|xmpp):)([^:/?#]+):(?=\d+(?::\d+)?$)/i,
				'$1%3A'
			);
});

function sanitizeMarkdown(rendered: string, openLinksInNewTab = false) {
	const sanitized = DOMPurify.sanitize(rendered, {
		ADD_FORBID_CONTENTS: ['annotation'],
		ADD_ATTR: ['target', 'rel'],
		FORBID_ATTR: openLinksInNewTab ? ['target', 'rel'] : []
	});

	if (!openLinksInNewTab) return sanitized;

	return sanitized.replace(/<a(?=[\s>])/gi, '<a target="_blank" rel="noopener noreferrer"');
}

export function renderMarkdown(value: string) {
	return sanitizeMarkdown(marked.parse(value, { async: false }));
}

export type MarkdownBlock =
	{ type: 'html'; html: string } | { type: 'artifact'; artifactId: string };

const ARTIFACT_REFERENCE = /^\s*artifact:([A-Za-z0-9_-]+)\s*$/;

export function renderMarkdownBlocks(
	value: string,
	availableArtifactIds: ReadonlySet<string>,
	openLinksInNewTab = false
): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let markdownTokens: Token[] = [];

	const flushMarkdown = () => {
		if (markdownTokens.length === 0) return;
		const html = sanitizeMarkdown(marked.parser(markdownTokens), openLinksInNewTab);

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
