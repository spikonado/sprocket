import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TARGETS = JSON.parse(
	readFileSync(path.join(import.meta.dirname, '../targets.json'), 'utf8')
).map((target) => [target.id, target.executable]);

test('assembles version-matched root and native packages', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'sprocket-npm-'));
	const artifacts = path.join(temporary, 'artifacts');
	const web = path.join(temporary, 'web');
	const output = path.join(temporary, 'output');

	try {
		await mkdir(web);
		await writeFile(path.join(web, 'index.html'), 'test web app');
		await Promise.all(
			TARGETS.map(async ([target, executable]) => {
				const directory = path.join(artifacts, target);
				await mkdir(directory, { recursive: true });
				await writeFile(path.join(directory, executable), 'test binary');
			})
		);

		const result = spawnSync(
			process.execPath,
			[
				path.join(ROOT, 'scripts/build-npm-packages.mjs'),
				'--version',
				'1.2.3',
				'--artifacts',
				artifacts,
				'--web',
				web,
				'--output',
				output
			],
			{ encoding: 'utf8' }
		);
		assert.equal(result.status, 0, result.stderr);

		const rootManifest = JSON.parse(
			await readFile(path.join(output, 'sprocket/package.json'), 'utf8')
		);
		assert.equal(rootManifest.version, '1.2.3');
		assert.equal(rootManifest.optionalDependencies['@spikonado/sprocket-linux-x64-gnu'], '1.2.3');
		await access(path.join(output, 'sprocket/web/index.html'));
		await access(path.join(output, 'sprocket/targets.json'));

		const nativeManifest = JSON.parse(
			await readFile(path.join(output, 'linux-x64-gnu/package.json'), 'utf8')
		);
		assert.deepEqual(nativeManifest, {
			name: '@spikonado/sprocket-linux-x64-gnu',
			version: '1.2.3',
			description: 'Sprocket native executable for linux/x64',
			license: 'Apache-2.0',
			os: ['linux'],
			cpu: ['x64'],
			files: ['bin/'],
			repository: {
				type: 'git',
				url: 'git+https://github.com/spikonado/sprocket.git'
			},
			publishConfig: { access: 'public' },
			libc: ['glibc']
		});

		const sourceManifest = JSON.parse(
			await readFile(path.join(ROOT, 'npm/sprocket/package.json'), 'utf8')
		);
		assert.equal(rootManifest.engines.node, sourceManifest.engines.node);
		await access(path.join(output, 'sprocket/bin/sprocket.js'), constants.X_OK);
		await access(path.join(output, 'linux-x64-gnu/bin/sprocket'), constants.X_OK);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
