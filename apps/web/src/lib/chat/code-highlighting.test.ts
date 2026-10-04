import { describe, expect, it } from 'vitest';
import { highlightCode } from './code-highlighting';

describe('code highlighting', () => {
	it.each([
		['TS', 'const count: number = 42;'],
		['tsx', 'const view = <button disabled>Build</button>;'],
		['rust', 'fn main() { println!("Hello"); }'],
		['python', 'def read():\n\treturn "sensor"\n'],
		['bash', 'echo "$HOME"'],
		['cpp', '#include <iostream>\nint main() { return 0; }']
	])('highlights %s with light and dark token colors', async (language, code) => {
		const lines = await highlightCode(code, language);
		expect(lines?.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
		const styles = lines?.flat().map((token) => token.htmlStyle);
		expect(styles).toContainEqual(
			expect.objectContaining({
				'--shiki-light': expect.any(String),
				'--shiki-dark': expect.any(String)
			})
		);
	});

	it('leaves an unrecognized language as plain code', async () => {
		expect(await highlightCode('device ready', 'custom-firmware')).toBeNull();
	});
});
