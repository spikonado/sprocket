import katex from 'katex';

// Code spans and escapes come first so their dollars stay literal.
const MATH =
	/(`+)[\s\S]*?\1(?!`)|(?<math>\$\$[^`]+?\$\$|\\\[[^`]+?\\\]|\\\([^`]+?\\\)|\$(?![\s$])(?:\\[^`\n]|[^\\$`\n])+?(?<!\s)\$(?![\d$]))|\\[^\n]/g;

const REFERENCE_LINE =
	/^([ \t]*)(?:artifact:([A-Za-z0-9_-]+)|kicad:([^\n]+?\.kicad_pro))([ \t]*)$/gm;

// Private-use characters pass through the Markdown parser as plain text.
const OPEN = '\uE000';
const CLOSE = '\uE001';

const RESERVED = /[\uE000\uE001]/g;

const RESTORE = new RegExp(
	`<p>${OPEN}(\\d+)${CLOSE}</p>|<(pre|code)\\b[^>]*>[\\s\\S]*?</\\2>|<[^>]*>|${OPEN}(\\d+)${CLOSE}`,
	'g'
);

const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

const STANDALONE = new RegExp(`^<p>${OPEN}(\\d+)${CLOSE}</p>\\n$`);

const MAX_CACHED_FORMULAS = 1000;

const formulas = new Map<string, string>();

function escapeHtml(text: string) {
	return text.replace(
		/[&"<>]/g,
		(character) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!
	);
}

function renderFormula(source: string) {
	let html = formulas.get(source);

	if (html !== undefined) return html;

	const displayMode = source.startsWith('$$') || source.startsWith('\\[');
	const delimiter = displayMode || source[0] === '\\' ? 2 : 1;

	html = katex.renderToString(source.slice(delimiter, -delimiter).trim(), {
		displayMode,
		throwOnError: false,
		strict: false,
		trust: false,
		maxSize: 20,
		maxExpand: 1000
	});

	if (formulas.size >= MAX_CACHED_FORMULAS) formulas.clear();
	formulas.set(source, html);

	return html;
}

export type MarkdownReference =
	{ type: 'artifact'; artifactId: string } | { type: 'kicad'; path: string };

type Placeholder = { source: string; reference?: MarkdownReference };

/**
 * Swaps math and reference lines for placeholders before parsing. Afterwards, math becomes
 * KaTeX, and a reference alone in a paragraph can become a card.
 */
export function createPlaceholders() {
	const ids = new Map<string, number>();
	const placeholders: Placeholder[] = [];

	const placeholder = (source: string, reference?: MarkdownReference) => {
		let id = ids.get(source);

		if (id === undefined) {
			id = placeholders.push({ source, reference }) - 1;
			ids.set(source, id);
		}

		return `${OPEN}${id}${CLOSE}`;
	};

	const render = (id: string) => {
		const { source, reference } = placeholders[Number(id)];

		return reference ? escapeHtml(source) : renderFormula(source);
	};

	const maskMath = (markdown: string) => {
		if (!/[$\\]/.test(markdown)) return markdown;

		let masked = '';
		let cursor = 0;

		for (const match of markdown.matchAll(MATH)) {
			const math = match.groups?.math;

			if (!math) continue;

			masked += markdown.slice(cursor, match.index) + placeholder(math);
			cursor = match.index + math.length;
		}

		return masked + markdown.slice(cursor);
	};

	return {
		mask(markdown: string) {
			const withReferences = markdown
				.replace(RESERVED, '\uFFFD')
				.replace(
					REFERENCE_LINE,
					(line, indent: string, artifactId?: string, path?: string, trailing?: string) =>
						indent +
						placeholder(
							line.trim(),
							artifactId ? { type: 'artifact', artifactId } : { type: 'kicad', path: path! }
						) +
						trailing
				);

			return maskMath(withReferences);
		},
		restore(html: string) {
			if (!html.includes(OPEN)) return html;

			return html.replace(RESTORE, (match, paragraphId?: string, _code?: string, id?: string) => {
				if (paragraphId !== undefined) {
					const content = render(paragraphId);

					return content.startsWith('<span class="katex-display">') ? content : `<p>${content}</p>`;
				}

				if (id !== undefined) return render(id);

				// Code and attributes keep the source as written.
				return match.replace(PLACEHOLDER, (_placeholder, literalId: string) =>
					escapeHtml(placeholders[Number(literalId)].source)
				);
			});
		},
		/** The reference that makes up a whole paragraph, before `restore`. */
		standaloneReference(rendered: string) {
			const id = STANDALONE.exec(rendered)?.[1];

			return id === undefined ? undefined : placeholders[Number(id)].reference;
		}
	};
}

export type Placeholders = ReturnType<typeof createPlaceholders>;
