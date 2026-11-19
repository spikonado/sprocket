import DOMPurify from 'isomorphic-dompurify';
import { renderToHtml } from '@pierre/words';
import type { VisualKind } from './artifact-preview';
import { prepareFences } from './markdown-fences';
import { isWindowsImagePath } from './markdown-image-path';
import {
	createPlaceholders,
	type MarkdownReference,
	type Placeholders
} from './markdown-placeholders';

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

export type MarkdownBlock =
	| { type: 'html'; html: string }
	| MarkdownReference
	| { type: 'visual'; kind: VisualKind; source: string }
	| { type: 'mermaid'; source: string; codeHtml: string }
	| { type: 'json-render'; source: string; codeHtml: string };

const VISUAL_LANGUAGES = new Map<string, VisualKind>([
	['html-visual', 'html'],
	['jsx-visual', 'react']
]);

const CODE_BLOCK = /^<pre><code(?: class="language-([^"]*)")?>([^<]*)<\/code><\/pre>\n$/;

const decoder = new TextDecoder();

function decodeHtml(html: string) {
	return html.replace(
		/&(amp|lt|gt|quot);/g,
		(_entity, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[name]!
	);
}

function parseMarkdown(value: string, placeholders: Placeholders) {
	const normalized = value.includes('\r') ? value.replace(/\r\n?/g, '\n') : value;
	const { source, endsInFence } = prepareFences(normalized);

	return { endsInFence, html: decoder.decode(renderToHtml(placeholders.mask(source))) };
}

const TAG = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:"[^"]*"|'[^']*'|[^'">])*>|\n/g;

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr'
]);

/** Splits rendered HTML into top-level blocks, reusing the previous finished blocks it starts with. */
function splitBlocks(html: string, previous: readonly string[]) {
	const blocks: string[] = [];
	let start = 0;

	// The last block can be the unbalanced rest of the HTML rather than a finished block.
	for (const block of previous.slice(0, -1)) {
		if (!html.startsWith(block, start)) break;

		blocks.push(block);
		start += block.length;
	}

	let depth = 0;
	TAG.lastIndex = start;

	for (let match = TAG.exec(html); match; match = TAG.exec(html)) {
		const [token, closing, name] = match;

		if (token === '\n') {
			if (depth > 0) continue;

			blocks.push(html.slice(start, match.index + 1));
			start = match.index + 1;
		} else if (closing) {
			depth = Math.max(0, depth - 1);
		} else if (name && !VOID_TAGS.has(name.toLowerCase()) && !token.endsWith('/>')) {
			depth++;
		}
	}

	if (start < html.length) blocks.push(html.slice(start));

	return blocks;
}

const BLOCK_TAGS = new Set([
	'address',
	'article',
	'aside',
	'blockquote',
	'br',
	'caption',
	'col',
	'colgroup',
	'dd',
	'details',
	'div',
	'dl',
	'dt',
	'fieldset',
	'figcaption',
	'figure',
	'footer',
	'form',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'header',
	'hr',
	'li',
	'main',
	'nav',
	'ol',
	'p',
	'pre',
	'section',
	'summary',
	'table',
	'tbody',
	'td',
	'tfoot',
	'th',
	'thead',
	'tr',
	'ul'
]);

const BREAK_TOKENS =
	/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->|<\/?([A-Za-z][A-Za-z0-9-]*)(?:"[^"]*"|'[^']*'|[^'">])*>|\n/g;

const NEXT_TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)/y;

/** Renders soft line breaks inside text as `<br>`, like marked's `breaks` option. */
function softBreaks(html: string) {
	if (html.indexOf('\n') === html.length - 1) return html;

	let tagEnd = -1;
	let tag = '';

	return html.replace(
		BREAK_TOKENS,
		(token, code: string | undefined, name: string | undefined, offset: number) => {
			if (token !== '\n') {
				tagEnd = offset + token.length;
				tag = (code ?? name ?? '').toLowerCase();

				return token;
			}

			NEXT_TAG.lastIndex = offset + 1;
			const next = NEXT_TAG.exec(html)?.[1].toLowerCase();

			const separatesBlocks =
				offset === html.length - 1 ||
				(tagEnd === offset && BLOCK_TAGS.has(tag)) ||
				(next !== undefined && BLOCK_TAGS.has(next));

			return separatesBlocks ? token : '<br>';
		}
	);
}

type BlockContext = {
	placeholders: Placeholders;
	artifactIds: ReadonlySet<string>;
	openLinksInNewTab: boolean;
};

function blockHtml(rendered: string, placeholders: Placeholders) {
	return placeholders.restore(softBreaks(rendered));
}

function toBlock(rendered: string, isOpenFence: boolean, context: BlockContext): MarkdownBlock {
	const reference = context.placeholders.standaloneReference(rendered);

	if (
		reference?.type === 'kicad' ||
		(reference?.type === 'artifact' && context.artifactIds.has(reference.artifactId))
	) {
		return reference;
	}

	const html = blockHtml(rendered, context.placeholders);
	const code = CODE_BLOCK.exec(html);
	const flagged = isOpenFence ? html.replace('<pre>', '<pre data-markdown-incomplete>') : html;

	if (code) {
		const language = code[1]?.toLowerCase() ?? '';
		const kind = VISUAL_LANGUAGES.get(language);
		const source = decodeHtml(code[2]).replace(/\n$/, '');

		if (language === 'json-render') {
			return { type: 'json-render', source, codeHtml: sanitizeMarkdown(flagged) };
		}

		if (!isOpenFence && kind) return { type: 'visual', kind, source };

		if (!isOpenFence && language === 'mermaid') {
			return { type: 'mermaid', source, codeHtml: sanitizeMarkdown(html) };
		}
	}

	return { type: 'html', html: sanitizeMarkdown(flagged, context.openLinksInNewTab) };
}

export function renderMarkdown(value: string) {
	const placeholders = createPlaceholders();

	return splitBlocks(parseMarkdown(value, placeholders).html, [])
		.map((block) => sanitizeMarkdown(blockHtml(block, placeholders)))
		.join('');
}

export function mergeHtmlBlocks(blocks: readonly MarkdownBlock[]) {
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

export function renderMarkdownBlocks(
	value: string,
	availableArtifactIds: ReadonlySet<string>,
	openLinksInNewTab = false
): MarkdownBlock[] {
	return mergeHtmlBlocks(
		createMarkdownBlockRenderer()(value, availableArtifactIds, openLinksInNewTab)
	);
}

/**
 * Renders a growing message. Each call reparses the whole text and reuses the blocks whose HTML
 * did not change, so finished blocks keep their sanitized HTML and DOM.
 */
export function createMarkdownBlockRenderer() {
	const placeholders = createPlaceholders();
	let previousValue: string | undefined;
	let previousArtifactIds = new Set<string>();
	let previousOpenLinksInNewTab = false;
	let rendered: string[] = [];
	let cache = new Map<string, MarkdownBlock>();
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

		if (optionsChanged) {
			previousArtifactIds = new Set(availableArtifactIds);
			previousOpenLinksInNewTab = openLinksInNewTab;
			cache = new Map();
		} else if (value === previousValue) {
			return blocks;
		}

		previousValue = value;
		const { endsInFence, html } = parseMarkdown(value, placeholders);
		const context = { placeholders, artifactIds: availableArtifactIds, openLinksInNewTab };
		const nextCache = new Map<string, MarkdownBlock>();
		rendered = splitBlocks(html, rendered);

		blocks = rendered.map((block, index) => {
			const isOpenFence = endsInFence && index === rendered.length - 1 && block.startsWith('<pre>');
			const key = isOpenFence ? `${block}\0` : block;
			const result = cache.get(key) ?? nextCache.get(key) ?? toBlock(block, isOpenFence, context);
			nextCache.set(key, result);

			return result;
		});

		cache = nextCache;

		return blocks;
	};
}
