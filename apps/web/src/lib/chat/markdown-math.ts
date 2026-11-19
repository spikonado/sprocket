import katex from 'katex';

// Code spans and escapes come first so their dollars stay literal.
const MATH =
	/(`+)[\s\S]*?\1(?!`)|(?<math>\$\$[^`]+?\$\$|\\\[[^`]+?\\\]|\\\([^`]+?\\\)|\$(?![\s$])(?:\\[^`\n]|[^\\$`\n])+?(?<!\s)\$(?![\d$]))|\\[^\n]/g;

// Private-use characters pass through the Markdown parser as plain text.
const OPEN = '\uE000';
const CLOSE = '\uE001';

const RESTORE = new RegExp(
	`<p>${OPEN}(\\d+)${CLOSE}</p>|<(pre|code)\\b[^>]*>[\\s\\S]*?</\\2>|<[^>]*>|${OPEN}(\\d+)${CLOSE}`,
	'g'
);

const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

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

/** Swaps math for placeholders before parsing, then KaTeX for the placeholders after. */
export function createMathTable() {
	const ids = new Map<string, number>();
	const sources: string[] = [];

	return {
		mask(markdown: string) {
			if (!/[$\\]/.test(markdown)) return markdown;

			let masked = '';
			let cursor = 0;

			for (const match of markdown.matchAll(MATH)) {
				const math = match.groups?.math;

				if (!math) continue;

				let id = ids.get(math);

				if (id === undefined) {
					id = sources.push(math) - 1;
					ids.set(math, id);
				}

				masked += `${markdown.slice(cursor, match.index)}${OPEN}${id}${CLOSE}`;
				cursor = match.index + math.length;
			}

			return masked + markdown.slice(cursor);
		},
		restore(html: string) {
			if (!html.includes(OPEN)) return html;

			return html.replace(RESTORE, (match, paragraphId?: string, _code?: string, id?: string) => {
				if (paragraphId !== undefined) {
					const formula = renderFormula(sources[Number(paragraphId)]);

					return formula.startsWith('<span class="katex-display">') ? formula : `<p>${formula}</p>`;
				}

				if (id !== undefined) return renderFormula(sources[Number(id)]);

				// Code and attributes keep the source as written.
				return match.replace(PLACEHOLDER, (_placeholder, literalId: string) =>
					escapeHtml(sources[Number(literalId)])
				);
			});
		}
	};
}

export type MathTable = ReturnType<typeof createMathTable>;
