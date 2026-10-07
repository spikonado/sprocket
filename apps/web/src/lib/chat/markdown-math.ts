import katex from 'katex';
import { Tokenizer, type MarkedExtension, type Tokens } from 'marked';

const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;

const INLINE_MATH = /^\$(?![\s$])((?:\\[^\n]|[^\\$\n])+?)(?<!\s)\$(?![\d$])/;

const MATH_MASK =
	/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?![\s$])(?:\\[^\n]|[^\\$\n])+?(?<!\s)\$(?![\d$])/g;

const tokenizer = new Tokenizer();

function maskMath(source: string, maskedSource: string) {
	const offset = maskedSource.length - source.length;
	let masked = '';
	let cursor = 0;

	for (const match of source.matchAll(MATH_MASK)) {
		const start = offset + match.index;

		masked += maskedSource.slice(cursor, start) + 'a'.repeat(match[0].length);
		cursor = start + match[0].length;
	}

	return masked + maskedSource.slice(cursor);
}

function renderMath(token: Tokens.Generic) {
	return katex.renderToString(token.text, {
		displayMode: token.displayMode,
		throwOnError: false,
		trust: false,
		maxSize: 20,
		maxExpand: 1000
	});
}

export const markdownMath: MarkedExtension = {
	tokenizer: {
		emStrong(source, maskedSource, previousCharacter) {
			if (!/^[*_]/.test(source)) return;

			return tokenizer.emStrong.call(
				this,
				source,
				maskMath(source, maskedSource),
				previousCharacter
			);
		},
		del(source, maskedSource, previousCharacter) {
			if (!source.startsWith('~')) return;

			return tokenizer.del.call(this, source, maskMath(source, maskedSource), previousCharacter);
		}
	},
	extensions: [
		{
			name: 'blockMath',
			level: 'block',
			start: (source) => source.search(/^ {0,3}(?:\$\$|\\\[)/m),
			tokenizer(source) {
				const match = BLOCK_MATH.exec(source);

				if (!match) return;

				return {
					type: 'blockMath',
					raw: match[0],
					text: (match[1] ?? match[2]).trim(),
					displayMode: true
				};
			},
			renderer: renderMath
		},
		{
			name: 'inlineMath',
			level: 'inline',
			start: (source) => source.search(/\$|\\[([]/),
			tokenizer(source) {
				if (this.lexer.state.inRawBlock) return;

				const display = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])/.exec(source);
				const match = display ?? /^\\\(([\s\S]+?)\\\)/.exec(source) ?? INLINE_MATH.exec(source);

				if (!match) return;

				return {
					type: 'inlineMath',
					raw: match[0],
					text: (match[1] ?? match[2]).trim(),
					displayMode: Boolean(display)
				};
			},
			renderer: renderMath
		}
	]
};
