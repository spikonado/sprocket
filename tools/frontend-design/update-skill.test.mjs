import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateSkill } from './update-skill.mjs';

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), 'frontend-design-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, 'crates/sprocket-workspace/skills/frontend-design');
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, 'SKILL.md'), 'old skill\n');
	await writeFile(join(directory, 'LICENSE.txt'), 'old license\n');

	const notices =
		'# Notices\n\n## Frontend design skill\n\nold attribution\n\n## Other tool\n\nKeep me.\n';

	await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), notices);

	return { root, directory, notices };
}

function upstream(skill, license) {
	return async (url) => {
		if (url === 'https://api.github.com/repos/anthropics/skills/commits/main') {
			return Response.json({ sha: 'new-commit' });
		}

		const base =
			'https://raw.githubusercontent.com/anthropics/skills/new-commit/skills/frontend-design';

		if (url === `${base}/SKILL.md`) return new Response(skill);

		if (url === `${base}/LICENSE.txt`) return new Response(license);

		throw new Error(`Unexpected request: ${url}`);
	};
}

test('updates both vendored files and their attribution from one upstream commit', async (t) => {
	const { root, directory } = await fixture(t);
	await updateSkill(root, upstream('new skill\n', '\n   New license\n'));
	assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), 'new skill\n');
	assert.equal(await readFile(join(directory, 'LICENSE.txt'), 'utf8'), '\n   New license\n');
	const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
	assert.match(notices, /at commit `new-commit`/);
	assert.ok(
		notices.includes(
			'[Apache-2.0](https://github.com/anthropics/skills/blob/new-commit/skills/frontend-design/LICENSE.txt).'
		)
	);
	assert.ok(notices.endsWith('## Other tool\n\nKeep me.\n'));
	await updateSkill(root, upstream('new skill\n', '\n   New license\n'));
	assert.equal(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), notices);
});

test('keeps the existing pin when upstream changes outside the skill', async (t) => {
	const { root, notices } = await fixture(t);
	await updateSkill(root, upstream('old skill\n', 'old license\n'));
	assert.equal(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), notices);
});

test('downloads the complete update before writing files', async (t) => {
	const { root, directory, notices } = await fixture(t);
	const request = upstream('new skill\n', 'new license\n');
	await assert.rejects(
		updateSkill(root, (url, options) =>
			url.endsWith('/LICENSE.txt') ? new Response(null, { status: 503 }) : request(url, options)
		),
		/503/
	);
	assert.equal(await readFile(join(directory, 'SKILL.md'), 'utf8'), 'old skill\n');
	assert.equal(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), notices);
});
