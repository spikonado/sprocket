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
	| { type: 'kicad'; path: string }
	| { type: 'visual'; kind: VisualKind; source: string }
	| { type: 'mermaid'; source: string; codeHtml: string }
	| { type: 'json-render'; source: string; codeHtml: string };

const ARTIFACT_REFERENCE = /^\s*artifact:([A-Za-z0-9_-]+)\s*$/;

const KICAD_REFERENCE = /^\s*kicad:([^\n]+?\.kicad_pro)\s*$/;

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

		if (language === 'json-render') {
			return { type: 'json-render', source: token.text, codeHtml: codeHtml() };
		}

		if (!(kind || isDiagram) || !fenceIsClosed(token.raw)) return;

		if (kind) return { type: 'visual', kind, source: token.text };

		return { type: 'mermaid', source: token.text, codeHtml: codeHtml() };
	}

	if (token.type !== 'paragraph') return;

	const artifactId = ARTIFACT_REFERENCE.exec(token.raw)?.[1];

	if (artifactId && availableArtifactIds.has(artifactId)) return { type: 'artifact', artifactId };

	const kicadPath = KICAD_REFERENCE.exec(token.raw)?.[1];

	if (kicadPath) return { type: 'kicad', path: kicadPath };
}

export function renderMarkdownBlocks(
	value: string,
	availableArtifactIds: ReadonlySet<string>,
	openLinksInNewTab = false
): MarkdownBlock[] {
	return renderMarkdownTokens(marked.lexer(value), availableArtifactIds, openLinksInNewTab);
}

function renderMarkdownTokens(
	tokens: Token[],
	availableArtifactIds: ReadonlySet<string>,
	openLinksInNewTab: boolean
): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	let markdownTokens: Token[] = [];

	const flushMarkdown = () => {
		if (markdownTokens.length === 0) return;
		const html = sanitizeMarkdown(marked.parser(markdownTokens), openLinksInNewTab);

		if (html) blocks.push({ type: 'html', html });
		markdownTokens = [];
	};

	for (const token of tokens) {
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

export function createMarkdownBlockRenderer() {
	let previousValue = '';
	let previousArtifactIds = new Set<string>();
	let previousOpenLinksInNewTab = false;
	let mode: 'paragraphs' | 'full' = 'paragraphs';
	let completedLength = 0;
	let completed: MarkdownBlock[] = [];
	let blocks: MarkdownBlock[] = [];

	return (
		value: string,
		availableArtifactIds: ReadonlySet<string>,
		openLinksInNewTab = false
	): MarkdownBlock[] => {
		const optionsChanged =
			previousOpenLinksInNewTab !== openLinksInNewTab ||
			previousArtifactIds.size !== availableArtifactIds.size ||
			[...availableArtifactIds].some((id) => !previousArtifactIds.has(id));

		if (optionsChanged || !value.startsWith(previousValue)) {
			previousArtifactIds = new Set(availableArtifactIds);
			previousOpenLinksInNewTab = openLinksInNewTab;
			mode = 'paragraphs';
			completedLength = 0;
			completed = [];
		} else if (value === previousValue) {
			return blocks;
		}

		previousValue = value;
		const tail = value.slice(completedLength);

		// Reference definitions, HTML, and math can span paragraphs or change earlier output.
		// Fences and other multi-paragraph blocks lex as non-paragraph tokens below.
		const tokens =
			mode === 'paragraphs' && !/^ {0,3}\[|[<\\$\r]/m.test(tail) ? marked.lexer(tail) : undefined;

		if (!tokens || tokens.some((token) => token.type !== 'paragraph' && token.type !== 'space')) {
			mode = 'full';
			completed = [];
			blocks = renderMarkdownBlocks(value, availableArtifactIds, openLinksInNewTab);

			return blocks;
		}

		let pending: Token[] = [];
		let offset = completedLength;

		for (const token of tokens) {
			pending.push(token);
			offset += token.raw.length;

			if (token.type !== 'space' || !/\n[ \t]*\n/.test(token.raw)) continue;

			completed.push(...renderMarkdownTokens(pending, availableArtifactIds, openLinksInNewTab));
			// Spaces after the last newline may become indentation in the next chunk.
			completedLength = offset - token.raw.length + token.raw.lastIndexOf('\n') + 1;
			pending = [];
		}

		blocks = [
			...completed,
			...renderMarkdownTokens(pending, availableArtifactIds, openLinksInNewTab)
		];

		return blocks;
	};
}
