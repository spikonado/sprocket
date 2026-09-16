import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('packages the project and third-party licenses', () => {
	const resources = new Map(manifest.build.extraResources.map(({ from, to }) => [to, from]));

	assert.equal(resources.get('LICENSE'), '../../LICENSE.md');
	assert.equal(resources.get('README.md'), '../../README.md');
	assert.equal(resources.get('THIRD_PARTY_NOTICES.md'), '../../THIRD_PARTY_NOTICES.md');
});
