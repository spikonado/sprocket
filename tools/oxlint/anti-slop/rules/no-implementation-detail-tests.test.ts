import { RuleTester } from 'oxlint/plugins-dev';

import { noImplementationDetailTestsRule } from './no-implementation-detail-tests.ts';

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const domError = { messageId: 'domEquality' };
const sourceError = { messageId: 'sourceRead' };
const schemaError = { messageId: 'schemaSnapshot' };

tester.run('anti-slop/no-implementation-detail-tests', noImplementationDetailTestsRule, {
	valid: [
		"expect(button.getAttribute('aria-expanded')).toBe('true');",
		"expect(button.textContent).toBe('Build');",
		'expect(highlighted.style).toEqual(token.htmlStyle);',
		"expect(sanitized.getAttribute('style')).toBeNull();",
		'expect(schema.properties.timeoutMs.default).toBe(10000);',
		"expect(validate({ '$schema': 'https://json-schema.org/draft/2020-12/schema', properties: {} })).toBe(true);",
		"expect(Number(child.style.marginLeft.replace('px', ''))).toBeGreaterThan(Number(parent.style.marginLeft.replace('px', '')));",
		"button.classList.add('selected');",
		"const expect = (value) => ({ toBe() {} }); expect(button.className).toBe('selected');",
		"import { expect } from './helpers'; expect(button.style.bottom).toBe('12px');",
		"import { readFileSync } from 'node:fs'; readFileSync(new URL('./fixtures/old-format.ts', import.meta.url), 'utf8');",
		"import { readFile } from 'node:fs/promises'; readFile(output, 'utf8');",
		"import { readFileSync } from 'node:fs'; readFileSync(new URL('../package.json', import.meta.url), 'utf8');",
		"import { readFileSync } from 'node:fs'; readFileSync(new URL('../LICENSE.md', import.meta.url), 'utf8');",
		"function readFileSync(path) { return path; } readFileSync('./implementation.ts');"
	],
	invalid: [
		{
			code: "expect(layout?.classList.contains('sidebar-hidden')).toBe(true);",
			errors: [domError]
		},
		{
			code: 'expect(menu.style.bottom).toBe(`${window.innerHeight - 400 + 12}px`);',
			errors: [domError]
		},
		{
			code: "import { expect as check } from 'vitest'; check(button['className']).not.toEqual('hidden');",
			errors: [domError]
		},
		{
			code: "import * as test from '@jest/globals'; test.expect(button.getAttribute('class')).toBe('hidden');",
			errors: [domError]
		},
		{ code: "expect(button).not.toHaveClass('hidden');", errors: [domError] },
		{
			code: "import { readFileSync } from 'node:fs'; const SKILL_PATH = new URL('../../skills/cleanup/SKILL.md', import.meta.url); readFileSync(SKILL_PATH, 'utf8');",
			errors: [sourceError]
		},
		{
			code: "import { readFile as read } from 'node:fs/promises'; await read('./implementation.ts', 'utf8');",
			errors: [sourceError]
		},
		{
			code: "import * as fs from 'fs'; fs['readFileSync'](`../index.rs`, 'utf8');",
			errors: [sourceError]
		},
		{
			code: "import fs from 'node:fs'; fs.readFileSync('./index.ts', 'utf8');",
			errors: [sourceError]
		},
		{
			code: "expect(parameters()).toEqual({ '$schema': 'https://json-schema.org/draft/2020-12/schema', properties: { parts: { type: 'array' } } });",
			errors: [schemaError]
		},
		{
			code: "const expected = { '$schema': 'https://json-schema.org/draft/2020-12/schema', properties: {} }; expect(parameters()).toStrictEqual(expected);",
			errors: [schemaError]
		},
		{
			code: "import assert from 'node:assert/strict'; assert.deepEqual(parameters(), { '$schema': 'https://json-schema.org/draft/2020-12/schema', properties: {} });",
			errors: [schemaError]
		}
	]
});
