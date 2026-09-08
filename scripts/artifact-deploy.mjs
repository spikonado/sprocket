import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stageArtifactSchema } from './artifact-stage-source.mjs';

const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));

export function deploymentArguments(argv, deployKey = process.env.CONVEX_DEPLOY_KEY) {
	const { values } = parseArgs({
		args: argv,
		options: {
			'preview-name': { type: 'string' },
			'env-file': { type: 'string' },
			message: { type: 'string' },
			help: { type: 'boolean', short: 'h' }
		}
	});
	assert.ok(
		values.help || !deployKey?.startsWith('preview:') || values['preview-name'],
		'Preview deploy keys require --preview-name.'
	);
	const deploy = [];
	const run = values['preview-name'] ? ['--preview-name', values['preview-name']] : ['--prod'];
	for (const name of ['preview-name', 'env-file', 'message']) {
		if (values[name] !== undefined) {
			assert.ok(values[name].trim(), `--${name} requires a nonempty value.`);
			deploy.push(`--${name}`, values[name]);
		}
	}
	if (values['env-file']) run.push('--env-file', values['env-file']);
	return { deploy, run, help: values.help ?? false };
}

function archivePage(output) {
	const result = JSON.parse(output);
	assert.ok([true, false].includes(result.isDone), 'Invalid archive completion result.');
	assert.ok(
		result.continueCursor === null || String(result.continueCursor) === result.continueCursor
	);
	for (const field of ['archivedVersions', 'deletedArtifacts', 'scanned']) {
		assert.ok(
			Number.isSafeInteger(result[field]) && result[field] >= 0,
			`Invalid archive ${field}.`
		);
	}
	return result;
}

export async function deployArtifacts({ schemaPath, command, deployArgs, runArgs }) {
	const original = await readFile(schemaPath, 'utf8');
	const staging = stageArtifactSchema(original);
	const backupPath = `${schemaPath}.artifact-backup`;
	await writeFile(backupPath, original, { flag: 'wx' });
	try {
		await writeFile(schemaPath, staging);
		// The temporary union widens DataModel. Final source still typechecks before release.
		await command(['deploy', ...deployArgs, '--typecheck', 'disable']);
		let cursor = null;
		for (let page = 0; ; page += 1) {
			assert.ok(page < 100_000, 'Archive page limit exceeded; rerun to resume.');
			const result = archivePage(
				await command([
					'run',
					...runArgs,
					'artifactArchive:archiveLegacyArtifactsPage',
					JSON.stringify({ cursor })
				])
			);
			if (result.isDone) break;
			assert.ok(
				result.continueCursor !== cursor ||
					result.archivedVersions > 0 ||
					result.deletedArtifacts > 0,
				'Artifact archive made no progress; refusing the final deploy.'
			);
			cursor = result.continueCursor;
		}
		cursor = null;
		for (let page = 0; ; page += 1) {
			assert.ok(page < 100_000, 'Archive verification page limit exceeded; rerun to resume.');
			const check = JSON.parse(
				await command([
					'run',
					...runArgs,
					'artifactArchive:leftoverLegacyPresent',
					JSON.stringify({ cursor })
				])
			);
			assert.equal(check.leftover, false, 'Legacy artifacts remain; refusing the final deploy.');
			assert.ok([true, false].includes(check.isDone), 'Invalid archive verification result.');
			if (check.isDone) break;
			assert.ok(
				check.continueCursor &&
					String(check.continueCursor) === check.continueCursor &&
					check.continueCursor !== cursor,
				'Archive verification made no progress; refusing the final deploy.'
			);
			cursor = check.continueCursor;
		}
	} finally {
		const current = await readFile(schemaPath, 'utf8');
		assert.ok(
			current === staging || current === original,
			`Schema changed during deployment. Original saved at ${backupPath}; restore it after resolving the local edits.`
		);
		await writeFile(schemaPath, original);
		await rm(backupPath);
	}
	await command(['deploy', ...deployArgs]);
}

function convexCommand(signal) {
	return (args) =>
		new Promise((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			const child = spawn('bunx', ['convex', ...args], {
				cwd: webRoot,
				stdio: ['ignore', 'pipe', 'inherit'],
				env: { ...process.env, NO_COLOR: '1' },
				signal
			});
			let output = '';
			let spawnError;
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (data) => {
				output += data;
			});
			child.on('error', (error) => {
				spawnError = error;
			});
			child.on('close', (code) => {
				if (spawnError) reject(spawnError);
				else if (code === 0) resolve(output);
				else reject(new Error(`convex ${args[0]} failed with exit code ${code}.`));
			});
		});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const abort = new AbortController();
	const cancel = () => abort.abort(new Error('Artifact deployment interrupted.'));
	process.once('SIGINT', cancel);
	process.once('SIGTERM', cancel);
	try {
		const args = deploymentArguments(process.argv.slice(2));
		if (args.help) {
			console.log(
				'Usage: bun scripts/artifact-deploy.mjs [--preview-name NAME] [--env-file PATH] [--message TEXT]'
			);
		} else {
			await deployArtifacts({
				schemaPath: path.join(webRoot, 'src/convex/schema.ts'),
				command: convexCommand(abort.signal),
				deployArgs: args.deploy,
				runArgs: args.run
			});
		}
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		process.removeListener('SIGINT', cancel);
		process.removeListener('SIGTERM', cancel);
	}
}
