import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
	archHints,
	isUpdateMetadataName,
	mergeUpdateInfo,
	mergeUpdateMetadata,
	parseUpdateInfoYaml,
	serializeUpdateInfoYaml
} from '../scripts/merge-update-metadata.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/merge-update-metadata.mjs');

function macManifest(arch, extras = {}) {
	const version = extras.version ?? '1.2.3';
	return serializeUpdateInfoYaml({
		version,
		files: [
			{
				url: `sprocket-desktop-${version}-mac-${arch}.zip`,
				sha512: `${arch}-zip-sha`,
				size: arch === 'arm64' ? 10 : 11,
				blockMapSize: 2
			},
			{
				url: `sprocket-desktop-${version}-mac-${arch}.dmg`,
				sha512: `${arch}-dmg-sha`,
				size: arch === 'arm64' ? 20 : 21
			}
		],
		path: `sprocket-desktop-${version}-mac-${arch}.zip`,
		sha512: `${arch}-zip-sha`,
		releaseDate: extras.releaseDate ?? '2026-09-07T00:00:00.000Z',
		isAdminRightsRequired: extras.isAdminRightsRequired,
		stagingPercentage: extras.stagingPercentage,
		releaseNotes: extras.releaseNotes
	});
}

test('names GitHub channel files and keeps x64 out of arm64 hints', () => {
	assert.equal(isUpdateMetadataName('latest-mac.yml'), true);
	assert.equal(isUpdateMetadataName('canary-linux-arm64.yml'), true);
	assert.equal(isUpdateMetadataName('builder-debug.yml'), false);
	assert.deepEqual([...archHints('sprocket-desktop-1.2.3-mac-arm64.zip')], ['arm64']);
	assert.deepEqual([...archHints('sprocket-desktop-1.2.3-mac-x64.zip')], ['x64']);
});

test('merges per-arch files and keeps extra update fields', () => {
	const merged = mergeUpdateInfo([
		{
			filePath: 'arm64/latest-mac.yml',
			info: parseUpdateInfoYaml(
				macManifest('arm64', {
					isAdminRightsRequired: false,
					releaseNotes: 'signed builds'
				})
			)
		},
		{
			filePath: 'x64/latest-mac.yml',
			info: parseUpdateInfoYaml(
				macManifest('x64', {
					releaseDate: '2026-09-07T01:00:00.000Z',
					stagingPercentage: 25
				})
			)
		}
	]);
	assert.equal(merged.version, '1.2.3');
	assert.equal(merged.isAdminRightsRequired, false);
	assert.equal(merged.stagingPercentage, 25);
	assert.equal(merged.releaseNotes, 'signed builds');
	assert.deepEqual(merged.files.map((file) => file.url).sort(), [
		'sprocket-desktop-1.2.3-mac-arm64.dmg',
		'sprocket-desktop-1.2.3-mac-arm64.zip',
		'sprocket-desktop-1.2.3-mac-x64.dmg',
		'sprocket-desktop-1.2.3-mac-x64.zip'
	]);
	assert.equal(merged.path.endsWith('.zip'), true);
	assert.equal(merged.releaseDate, '2026-09-07T01:00:00.000Z');
});

test('refuses version, channel-field, and same-url checksum collisions', () => {
	const arm64 = parseUpdateInfoYaml(
		macManifest('arm64', { stagingPercentage: 10, releaseNotes: 'notes' })
	);
	assert.throws(
		() =>
			mergeUpdateInfo([
				{ filePath: 'arm64.yml', info: arm64 },
				{ filePath: 'other.yml', info: { ...arm64, version: '9.9.9' } }
			]),
		/version 9\.9\.9/
	);
	assert.throws(
		() =>
			mergeUpdateInfo([
				{ filePath: 'arm64.yml', info: arm64 },
				{
					filePath: 'x64.yml',
					info: parseUpdateInfoYaml(macManifest('x64', { stagingPercentage: 90 }))
				}
			]),
		/stagingPercentage is not compatible/
	);
	assert.throws(
		() =>
			mergeUpdateInfo([
				{ filePath: 'arm64.yml', info: { ...arm64, channel: 'latest' } },
				{
					filePath: 'x64.yml',
					info: {
						...parseUpdateInfoYaml(macManifest('x64')),
						channel: 'canary'
					}
				}
			]),
		/channel is not compatible/
	);
	assert.throws(
		() =>
			mergeUpdateInfo([
				{ filePath: 'first.yml', info: arm64 },
				{
					filePath: 'second.yml',
					info: {
						...arm64,
						files: [{ url: arm64.files[0].url, sha512: 'different', size: 99 }]
					}
				}
			]),
		/Refusing to overwrite/
	);
});

test('copies unique artifacts and merges colliding canary metadata', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'sprocket-desktop-meta-'));
	const input = path.join(temporary, 'input');
	const output = path.join(temporary, 'output');
	try {
		await mkdir(path.join(input, 'desktop-darwin-arm64'), { recursive: true });
		await mkdir(path.join(input, 'desktop-darwin-x64'), { recursive: true });
		await mkdir(path.join(input, 'desktop-linux-x64'), { recursive: true });
		await writeFile(
			path.join(input, 'desktop-darwin-arm64/sprocket-desktop-1.2.3-mac-arm64.zip'),
			'arm64-zip'
		);
		await writeFile(
			path.join(input, 'desktop-darwin-x64/sprocket-desktop-1.2.3-mac-x64.zip'),
			'x64-zip'
		);
		await writeFile(
			path.join(input, 'desktop-linux-x64/sprocket-desktop-1.2.3-linux-x64.AppImage'),
			'linux'
		);
		await writeFile(
			path.join(input, 'desktop-darwin-arm64/canary-mac.yml'),
			macManifest('arm64', { version: '1.2.3-canary.1', releaseNotes: 'canary' })
		);
		await writeFile(
			path.join(input, 'desktop-darwin-x64/canary-mac.yml'),
			macManifest('x64', { version: '1.2.3-canary.1', releaseNotes: 'canary' })
		);
		await writeFile(path.join(input, 'desktop-darwin-arm64/builder-debug.yml'), 'skip me');
		await mergeUpdateMetadata(input, output);

		const merged = parseUpdateInfoYaml(await readFile(path.join(output, 'canary-mac.yml'), 'utf8'));
		assert.equal(merged.version, '1.2.3-canary.1');
		assert.equal(merged.releaseNotes, 'canary');
		assert.equal(
			merged.files.some((file) => file.url.includes('arm64')),
			true
		);
		assert.equal(
			merged.files.some((file) => file.url.includes('x64')),
			true
		);
		assert.equal(
			await readFile(path.join(output, 'sprocket-desktop-1.2.3-mac-arm64.zip'), 'utf8'),
			'arm64-zip'
		);
		assert.equal(
			await readFile(path.join(output, 'sprocket-desktop-1.2.3-mac-x64.zip'), 'utf8'),
			'x64-zip'
		);
		await assert.rejects(readFile(path.join(output, 'builder-debug.yml')));
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test('fails instead of overwriting colliding installers', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'sprocket-desktop-collide-'));
	try {
		const input = path.join(temporary, 'input');
		await mkdir(path.join(input, 'a'), { recursive: true });
		await mkdir(path.join(input, 'b'), { recursive: true });
		await writeFile(path.join(input, 'a/sprocket-desktop-1.2.3-mac-x64.zip'), 'one');
		await writeFile(path.join(input, 'b/sprocket-desktop-1.2.3-mac-x64.zip'), 'two');
		await assert.rejects(
			mergeUpdateMetadata(input, path.join(temporary, 'output')),
			/Refusing to overwrite sprocket-desktop-1\.2\.3-mac-x64\.zip/
		);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test('rejects a nonempty or overlapping output without deleting it', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'sprocket-desktop-output-'));
	try {
		const input = path.join(temporary, 'input');
		const output = path.join(temporary, 'output');
		await mkdir(path.join(input, 'desktop-darwin-arm64'), { recursive: true });
		await mkdir(output);
		await writeFile(path.join(input, 'desktop-darwin-arm64/latest-mac.yml'), macManifest('arm64'));
		await writeFile(path.join(output, 'keep-me'), 'sentinel');
		await assert.rejects(mergeUpdateMetadata(input, output), /nonexistent or empty/);
		assert.equal(await readFile(path.join(output, 'keep-me'), 'utf8'), 'sentinel');
		await assert.rejects(
			mergeUpdateMetadata(input, path.join(input, 'nested')),
			/output must not overlap input/
		);
		assert.equal(await readFile(path.join(output, 'keep-me'), 'utf8'), 'sentinel');
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test('CLI requires input and output directories', () => {
	const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /usage: merge-update-metadata\.mjs --input DIR --output DIR/);
});
