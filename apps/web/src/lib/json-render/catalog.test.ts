import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { jsonRenderCatalog } from './catalog';

const SKILL_PATH = new URL(
	'../../../../../crates/sprocket-workspace/skills/making-artifacts-and-visuals/SKILL.md',
	import.meta.url
);

const LISTED_COMPONENTS =
	/<!-- json-render-components:start -->\s*([\s\S]*?)\s*<!-- json-render-components:end -->/;

function componentReference() {
	const prompt = jsonRenderCatalog.prompt();
	const start = prompt.indexOf('\n', prompt.indexOf('AVAILABLE COMPONENTS ('));

	return prompt.slice(start, prompt.indexOf('AVAILABLE ACTIONS')).trim();
}

test('the visuals skill lists the json-render catalog', () => {
	const skill = readFileSync(SKILL_PATH, 'utf8');
	const listed = LISTED_COMPONENTS.exec(skill)?.[1];

	expect(listed).toBe(componentReference());
});
