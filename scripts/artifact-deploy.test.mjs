import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deployArtifacts, deploymentArguments } from './artifact-deploy.mjs';
import { stageArtifactSchema } from './artifact-stage-source.mjs';

const schema = `export default defineSchema({
	oldArtifacts: defineTable(vOldArtifactDocument),
	artifacts: defineTable({ registrationId: v.string() })
});`;

test('staging overlays the table definitions without duplicating their validators', () => {
	const staged = stageArtifactSchema(schema);
	assert.match(staged, /const finalSchema = defineSchema/);
	assert.match(staged, /\.\.\.finalSchema.tables/);
	assert.match(staged, /artifacts: stagingArtifactsTable/);
	assert.throws(() => stageArtifactSchema(staged));
	assert.throws(() => stageArtifactSchema('export default defineSchema({});'));
});

test('archive commands target the same production or preview deployment as deploy', () => {
	assert.deepEqual(deploymentArguments([]).run, ['--prod']);
	const preview = deploymentArguments([
		'--preview-name',
		'pr-123',
		'--env-file',
		'.env.preview',
		'--message',
		'test'
	]);
	assert.deepEqual(preview.run, ['--preview-name', 'pr-123', '--env-file', '.env.preview']);
	assert.deepEqual(preview.deploy, [
		'--preview-name',
		'pr-123',
		'--env-file',
		'.env.preview',
		'--message',
		'test'
	]);
	assert.throws(() => deploymentArguments(['--dry-run']));
	assert.throws(() => deploymentArguments(['--preview-create', 'pr-123']));
	assert.throws(() => deploymentArguments([], 'preview:team:project|key'));
});

async function withSchema(work) {
	const directory = await mkdtemp(path.join(tmpdir(), 'sprocket-artifact-deploy-'));
	const schemaPath = path.join(directory, 'schema.ts');
	try {
		await writeFile(schemaPath, schema);
		await work(schemaPath);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('archives all pages before restoring source and deploying the strict schema', async () => {
	await withSchema(async (schemaPath) => {
		const calls = [];
		let page = 0;
		let checks = 0;
		await deployArtifacts({
			schemaPath,
			deployArgs: ['--preview-name', 'pr-123'],
			runArgs: ['--preview-name', 'pr-123'],
			command: async (args) => {
				calls.push(args);
				if (args[0] === 'deploy') {
					assert.equal((await readFile(schemaPath, 'utf8')) === schema, calls.length > 1);
					return '';
				}
				if (args.includes('artifactArchive:leftoverLegacyPresent')) {
					checks += 1;
					assert.deepEqual(JSON.parse(args.at(-1)), {
						cursor: checks === 1 ? null : 'verify-next'
					});
					return JSON.stringify({
						leftover: false,
						isDone: checks === 2,
						continueCursor: checks === 2 ? null : 'verify-next'
					});
				}
				page += 1;
				return JSON.stringify({
					isDone: page === 2,
					continueCursor: page === 2 ? null : 'next',
					archivedVersions: 4,
					deletedArtifacts: 0,
					scanned: 1
				});
			}
		});
		assert.equal(calls.length, 6);
		assert.deepEqual(calls[0].slice(-2), ['--typecheck', 'disable']);
		assert.deepEqual(calls.at(-1), ['deploy', '--preview-name', 'pr-123']);
		assert.equal(await readFile(schemaPath, 'utf8'), schema);
	});
});

for (const failure of [
	'stage',
	'archive',
	'stalled',
	'leftover',
	'verification-stalled',
	'final'
]) {
	test(`restores local source after ${failure} failure and fails closed`, async () => {
		await withSchema(async (schemaPath) => {
			let deploys = 0;
			let checks = 0;
			await assert.rejects(
				deployArtifacts({
					schemaPath,
					deployArgs: [],
					runArgs: ['--prod'],
					command: async (args) => {
						if (args[0] === 'deploy') {
							deploys += 1;
							if (failure === 'stage' || (failure === 'final' && deploys === 2))
								throw new Error('deploy failed');
							return '';
						}
						if (failure === 'archive') throw new Error('archive failed');
						if (args.includes('artifactArchive:leftoverLegacyPresent')) {
							checks += 1;
							if (failure === 'leftover' && checks === 1)
								return JSON.stringify({ leftover: false, isDone: false, continueCursor: 'later' });
							return JSON.stringify({
								leftover: failure === 'leftover',
								isDone: failure !== 'verification-stalled',
								continueCursor: null
							});
						}
						return JSON.stringify({
							isDone: failure !== 'stalled',
							continueCursor: null,
							archivedVersions: 0,
							deletedArtifacts: 0,
							scanned: 1
						});
					}
				})
			);
			assert.equal(deploys, failure === 'final' ? 2 : 1);
			assert.equal(await readFile(schemaPath, 'utf8'), schema);
		});
	});
}

test('preserves concurrent schema edits and the recovery backup', async () => {
	await withSchema(async (schemaPath) => {
		await assert.rejects(
			deployArtifacts({
				schemaPath,
				deployArgs: [],
				runArgs: ['--prod'],
				command: async () => {
					await writeFile(schemaPath, 'concurrent edit');
					throw new Error('interrupted');
				}
			}),
			/Schema changed/
		);
		assert.equal(await readFile(schemaPath, 'utf8'), 'concurrent edit');
		assert.equal(await readFile(`${schemaPath}.artifact-backup`, 'utf8'), schema);
	});
});
