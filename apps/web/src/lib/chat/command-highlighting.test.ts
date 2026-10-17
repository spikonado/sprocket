import { describe, expect, it } from 'vitest';
import { highlightCode } from './code-highlighting';
import { highlightCommand, pythonScriptRanges } from './command-highlighting';

function scripts(command: string) {
	return pythonScriptRanges(command).map(({ start, end }) => command.slice(start, end));
}

describe('python script detection', () => {
	it('finds heredoc bodies up to their terminator', () => {
		const command =
			"cd repo && python3 - <<'PY'\nimport json\nprint(json.dumps({}))\nPY\necho done";

		expect(scripts(command)).toEqual(['import json\nprint(json.dumps({}))\n']);
	});

	it('finds -c arguments in single and escaped double quotes', () => {
		const command = `python3 -u -c 'print(1)' && python -c "print(\\"a\\")" | cat`;

		expect(scripts(command)).toEqual(['print(1)', 'print(\\"a\\")']);
	});

	it('runs an unterminated script to the end of the command', () => {
		expect(scripts("python3 <<EOF\nprint('partial')")).toEqual(["print('partial')"]);
	});
});

describe('command highlighting', () => {
	it('keeps the command text and highlights embedded Python as Python', async () => {
		const command = "ls -la\npython3 -c 'print(1)'";
		const runs = await highlightCommand(command, highlightCode);

		expect(runs?.map((run) => run.text).join('')).toBe(command);

		const pythonPrint = (await highlightCode('print(1)', 'python'))![0]!.find(
			(token) => token.content === 'print'
		);

		expect(runs?.find((run) => run.text === 'print')?.style).toEqual(pythonPrint?.htmlStyle);
	});
});
