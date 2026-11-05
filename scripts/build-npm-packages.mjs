import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const SOURCE_PACKAGE = path.join(ROOT, 'npm/tinker');

const TARGETS = JSON.parse(readFileSync(path.join(SOURCE_PACKAGE, 'targets.json'), 'utf8'));

function argumentsFrom(argv) {
	const values = new Map();

	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];

		if (!key?.startsWith('--') || !value) {
			throw new Error(
				'usage: build-npm-packages.mjs --version VERSION --artifacts DIR --web DIR --output DIR'
			);
		}

		values.set(key.slice(2), value);
	}

	return values;
}

async function copyRootPackage(output, web, version) {
	const destination = path.join(output, 'tinker');
	await mkdir(destination, { recursive: true });

	for (const entry of ['bin', 'lib', 'targets.json']) {
		await cp(path.join(SOURCE_PACKAGE, entry), path.join(destination, entry), { recursive: true });
	}

	await chmod(path.join(destination, 'bin', 'tinker.js'), 0o755);
	await cp(path.join(ROOT, 'LICENSE.md'), path.join(destination, 'LICENSE'));
	await cp(path.join(ROOT, 'README.md'), path.join(destination, 'README.md'));
	await cp(
		path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
		path.join(destination, 'THIRD_PARTY_NOTICES.md')
	);
	await cp(web, path.join(destination, 'web'), { recursive: true });

	const manifest = JSON.parse(await readFile(path.join(SOURCE_PACKAGE, 'package.json'), 'utf8'));
	manifest.version = version;
	manifest.optionalDependencies = Object.fromEntries(
		TARGETS.map((target) => [target.packageName, version])
	);
	await writeJson(path.join(destination, 'package.json'), manifest);
}

// Released Sprocket clients only update `@spikonado/sprocket` and restart into its
// `bin/sprocket.js`; this copy of the Tinker package moves them to `usetinker`.
async function copyLegacyPackage(output) {
	const destination = path.join(output, 'sprocket');
	await cp(path.join(output, 'tinker'), destination, { recursive: true });
	await rename(path.join(destination, 'bin/tinker.js'), path.join(destination, 'bin/sprocket.js'));

	const manifestPath = path.join(destination, 'package.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	manifest.name = '@spikonado/sprocket';
	manifest.description = 'Sprocket is now Tinker. Install usetinker instead.';
	manifest.bin = { sprocket: 'bin/sprocket.js' };
	await writeJson(manifestPath, manifest);
}

async function copyPlatformPackage(output, artifacts, version, target) {
	const destination = path.join(output, target.id);
	const binaryDestination = path.join(destination, 'bin', target.executable);
	await mkdir(path.dirname(binaryDestination), { recursive: true });
	await cp(path.join(artifacts, target.id, target.executable), binaryDestination);

	if (target.os !== 'win32') {
		await chmod(binaryDestination, 0o755);
	}

	await cp(path.join(ROOT, 'LICENSE.md'), path.join(destination, 'LICENSE'));
	await cp(path.join(ROOT, 'README.md'), path.join(destination, 'README.md'));
	await cp(
		path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
		path.join(destination, 'THIRD_PARTY_NOTICES.md')
	);

	const manifest = {
		name: target.packageName,
		version,
		description: `Tinker native executable for ${target.os}/${target.cpu}`,
		license: 'FSL-1.1-ALv2',
		os: [target.os],
		cpu: [target.cpu],
		files: ['bin/', 'THIRD_PARTY_NOTICES.md'],
		repository: {
			type: 'git',
			url: 'git+https://github.com/spikonado/sprocket.git'
		},
		publishConfig: { access: 'public' }
	};

	if (target.libc) {
		manifest.libc = [target.libc];
	}

	await writeJson(path.join(destination, 'package.json'), manifest);
}

async function writeJson(file, value) {
	await writeFile(file, `${JSON.stringify(value, null, '\t')}\n`);
}

async function main() {
	const args = argumentsFrom(process.argv.slice(2));
	const version = args.get('version');
	const artifacts = args.get('artifacts');
	const output = args.get('output');
	const web = args.get('web');

	if (!version || !artifacts || !output || !web) {
		throw new Error('version, artifacts, output, and web are required');
	}

	const resolvedOutput = path.resolve(output);
	await rm(resolvedOutput, { recursive: true, force: true });
	await mkdir(resolvedOutput, { recursive: true });
	await copyRootPackage(resolvedOutput, path.resolve(web), version);
	await copyLegacyPackage(resolvedOutput);
	await Promise.all(
		TARGETS.map((target) =>
			copyPlatformPackage(resolvedOutput, path.resolve(artifacts), version, target)
		)
	);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
