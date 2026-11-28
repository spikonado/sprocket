import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const catalog: { id: string; url: string; iconUrl?: string }[] = JSON.parse(
	await readFile(
		new URL('../../crates/sprocket-host/connector-catalog.json', import.meta.url),
		'utf8'
	)
);

test('reviewed connectors have sorted unique ids and HTTPS endpoints', () => {
	catalog.forEach(({ id, url, iconUrl }, index) => {
		assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		assert.ok(index === 0 || catalog[index - 1].id < id, `${id} is duplicated or out of order`);

		for (const link of [url, iconUrl].filter((link) => link !== undefined)) {
			assert.equal(new URL(link).protocol, 'https:', `${id}: ${link}`);
		}
	});
});
