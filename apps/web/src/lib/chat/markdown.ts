import DOMPurify from 'isomorphic-dompurify';
import { Marked, type Token } from 'marked';
import type { VisualKind } from './artifact-preview';
import { markdownFences } from './markdown-fences';
import { isWindowsImagePath } from './markdown-image-path';
import { markdownMath } from './markdown-math';

const marked = new Marked({ gfm: true, breaks: true }, markdownFences, markdownMath);

DOMPurify.addHook('uponSanitizeAttribute', (node, attribute) => {
	const isPath =
		(node.nodeName === 'IMG' && attribute.attrName === 'src') ||
		(node.nodeName === 'A' && attribute.attrName === 'href');

	// DOMPurify reads the `C:` drive as a URL scheme and drops the path.
	if (isPath && isWindowsImagePath(attribute.attrValue)) {
		attribute.attrValue = `${attribute.attrValue[0]}%3A${attribute.attrValue.slice(2)}`;
	}
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
	| { type: 'html'; html: string }
	| { type: 'artifact'; artifactId: string }
	| { type: 'visual'; kind: VisualKind; source: string }
	| { type: 'mermaid'; source: string; codeHtml: string }
	| { type: 'json-render'; source: string; codeHtml: string };

const ARTIFACT_REFERENCE = /^\s*artifact:([A-Za-z0-9_-]+)\s*$/;

const VISUAL_LANGUAGES = new Map<string, VisualKind>([
	['html-visual', 'html'],
	['jsx-visual', 'react']
]);

const FENCE_MARKERS = /^ {0,3}(`{3,}|~{3,})[^\n]*\n(?:[\s\S]*\n)? {0,3}(`{3,}|~{3,})\s*$/;

function fenceIsClosed(raw: string) {
	const [, open, close] = FENCE_MARKERS.exec(raw) ?? [];

	return !!open && !!close && close[0] === open[0] && close.length >= open.length;
}

function specialBlock(
	token: Token,
	availableArtifactIds: ReadonlySet<string>
): MarkdownBlock | undefined {
	if (token.type === 'code') {
		const language = token.lang?.split(/\s/, 1)[0].toLowerCase() ?? '';
		const kind = VISUAL_LANGUAGES.get(language);
		const isDiagram = language === 'mermaid';
		const codeHtml = () => sanitizeMarkdown(marked.parser([token]));

		// JSONL patches render as they stream in.
		if (language === 'json-render') {
			return { type: 'json-render', source: token.text, codeHtml: codeHtml() };
		}

		// A diagram or visual still streaming in stays a code block until its fence closes.
		if (!(kind || isDiagram) || !fenceIsClosed(token.raw)) return;

		if (kind) return { type: 'visual', kind, source: token.text };

		return { type: 'mermaid', source: token.text, codeHtml: codeHtml() };
	}

	const artifactId =
		token.type === 'paragraph' ? ARTIFACT_REFERENCE.exec(token.raw)?.[1] : undefined;

	if (artifactId && availableArtifactIds.has(artifactId)) return { type: 'artifact', artifactId };
}

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
		const block = specialBlock(token, availableArtifactIds);

		if (!block) {
			markdownTokens.push(token);
			continue;
		}

		flushMarkdown();
		blocks.push(block);
	}

	flushMarkdown();

	return blocks;
}
