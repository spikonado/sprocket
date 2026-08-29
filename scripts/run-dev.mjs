import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
let dataDir = null;
let envFile = null;
let mode = null;
const unexpectedArguments = [];

for (const arg of args) {
	if (arg === '--desktop') {
		mode = '--desktop';
	} else if (arg.startsWith('--data-dir=')) {
		dataDir = arg.slice('--data-dir='.length);
	} else if (arg.startsWith('--env-file=')) {
		envFile = arg.slice('--env-file='.length);
	} else {
		unexpectedArguments.push(arg);
	}
}

if (unexpectedArguments.length > 0) {
	console.error(
		'Usage: bun scripts/run-dev.mjs [--desktop] [--data-dir=<path>] [--env-file=<path>]'
	);
	process.exit(1);
}

const childEnv = { ...process.env };
if (envFile) {
	const filePath = path.resolve(repositoryRoot, envFile);
	Object.assign(childEnv, parseEnv(readFileSync(filePath, 'utf8')));
}

if (dataDir) {
	childEnv.SPROCKET_DATA_DIR = path.resolve(repositoryRoot, dataDir);
}

const desktop = mode === '--desktop';
const names = desktop ? 'web,electron' : 'api,web';
const colors = desktop ? 'green,magenta' : 'blue,green';
const commands = desktop
	? [
			'node scripts/wait-for-api.mjs && bun run --cwd apps/web dev',
			'bun run --cwd apps/desktop dev'
		]
	: [
			'cargo run -p sprocket-cli -- serve --port 7731 --api-only',
			'node scripts/wait-for-api.mjs && bun run --cwd apps/web dev'
		];

const child = spawn(
	process.execPath,
	['x', 'concurrently', '-k', '-n', names, '-c', colors, ...commands],
	{
		cwd: repositoryRoot,
		env: childEnv,
		stdio: 'inherit'
	}
);

child.on('error', (error) => {
	console.error('Failed to launch the development environment:', error);
	process.exit(1);
});

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 1);
});
