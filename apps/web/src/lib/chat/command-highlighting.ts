import type { highlightCode } from './code-highlighting';

type Highlight = (code: string, language: string) => ReturnType<typeof highlightCode>;

type TokenStyle = Record<string, string>;

export type StyledRun = { text: string; style?: TokenStyle };

type Range = { start: number; end: number };

const PYTHON = String.raw`\bpython(?:3(?:\.\d+)?)?\b`;

const PYTHON_HEREDOC = new RegExp(String.raw`${PYTHON}[^\n]*?<<-?\s*(['"]?)(\w+)\1[^\n]*\n`, 'g');

const PYTHON_INLINE = new RegExp(String.raw`${PYTHON}(?:\s+-[^\sc-]\S*)*\s+-c\s+(['"])`, 'g');

function heredocScript(command: string, from: number): Range | undefined {
	PYTHON_HEREDOC.lastIndex = from;
	const match = PYTHON_HEREDOC.exec(command);

	if (!match) return undefined;

	const start = match.index + match[0].length;
	let lineStart = start;

	while (lineStart < command.length) {
		const newline = command.indexOf('\n', lineStart);
		const lineEnd = newline === -1 ? command.length : newline;

		if (command.slice(lineStart, lineEnd).trim() === match[2]) return { start, end: lineStart };

		lineStart = lineEnd + 1;
	}

	return { start, end: command.length };
}

function inlineScript(command: string, from: number): Range | undefined {
	PYTHON_INLINE.lastIndex = from;
	const match = PYTHON_INLINE.exec(command);

	if (!match) return undefined;

	const quote = match[1];
	const start = match.index + match[0].length;

	for (let index = start; index < command.length; index += 1) {
		if (quote === '"' && command[index] === '\\') index += 1;
		else if (command[index] === quote) return { start, end: index };
	}

	return { start, end: command.length };
}

/** Finds `python3 -c '…'` arguments and `python3 <<EOF` heredoc bodies inside a shell command. */
export function pythonScriptRanges(command: string): Range[] {
	const ranges: Range[] = [];
	let position = 0;

	for (;;) {
		const next = [heredocScript(command, position), inlineScript(command, position)]
			.filter((range) => range !== undefined)
			.sort((left, right) => left.start - right.start)[0];

		if (!next) return ranges;

		ranges.push(next);
		position = next.end;
	}
}

function paint(
	styles: (TokenStyle | undefined)[],
	tokens: Awaited<ReturnType<Highlight>>,
	shift: number
) {
	for (const line of tokens ?? []) {
		for (const token of line) {
			for (let index = 0; index < token.content.length; index += 1) {
				styles[shift + token.offset + index] = token.htmlStyle;
			}
		}
	}
}

/** Highlights a command as Bash, with embedded Python scripts highlighted as Python. */
export async function highlightCommand(
	command: string,
	highlight: Highlight
): Promise<StyledRun[] | null> {
	const ranges = pythonScriptRanges(command);

	const [shell, ...scripts] = await Promise.all([
		highlight(command, 'bash'),
		...ranges.map(({ start, end }) => highlight(command.slice(start, end), 'python'))
	]);

	if (!shell) return null;

	const styles: (TokenStyle | undefined)[] = Array.from({ length: command.length });
	paint(styles, shell, 0);

	for (const [index, tokens] of scripts.entries()) paint(styles, tokens, ranges[index]!.start);

	const runs: StyledRun[] = [];

	for (let index = 0; index < command.length; index += 1) {
		const last = runs.at(-1);
		const style = styles[index];

		if (last && last.style === style) last.text += command[index];
		else runs.push({ text: command[index]!, style });
	}

	return runs;
}
