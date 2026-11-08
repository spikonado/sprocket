import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { DEV_API_PORT } from '../apps/desktop/local-config.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);

let dataDir = null;

let envFile = null;

let mode = null;

let printConvexUrl = false;

const unexpectedArguments = [];

for (const arg of args) {
	if (arg === '--desktop') {
		mode = '--desktop';
	} else if (arg === '--print-convex-url') {
		printConvexUrl = true;
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
		'Usage: bun scripts/run-dev.mjs [--desktop] [--data-dir=<path>] [--env-file=<path>] [--print-convex-url]'
	);
	process.exit(1);
}

const fileEnv = envFile
	? parseEnv(readFileSync(path.resolve(repositoryRoot, envFile), 'utf8'))
	: {};

const fileConvexUrl = fileEnv.VITE_CONVEX_URL;

if (printConvexUrl) {
	process.stdout.write(fileConvexUrl ?? '');
	process.exit(0);
}

// Bun loads the root `.env`, so this clears its production key. An `--env-file` can opt back in.
const childEnv = { ...process.env, PUBLIC_POSTHOG_KEY: '', ...fileEnv };

// `convex dev` writes only VITE_CONVEX_URL; point the Rust API at the same deployment as the web app.
if (fileConvexUrl) {
	childEnv.PUBLIC_CONVEX_URL = fileConvexUrl;
}

if (dataDir) {
	childEnv.SPROCKET_DATA_DIR = path.resolve(repositoryRoot, dataDir);
} else if (mode === '--desktop') {
	childEnv.SPROCKET_DATA_DIR = path.join(homedir(), '.sprocket');
} else {
	delete childEnv.SPROCKET_DATA_DIR;
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
			`cargo run -p sprocket-cli -- serve --port ${DEV_API_PORT} --api-only`,
			'node scripts/wait-for-api.mjs && bun run --cwd apps/web dev'
		];

// A cold build outlasts wait-for-api.mjs's 120 s limit, which then kills the whole dev stack.
const build = spawnSync('cargo', ['build', '-p', 'sprocket-cli'], {
	cwd: repositoryRoot,
	env: childEnv,
	stdio: 'inherit'
});

if (build.status !== 0) {
	if (build.error) console.error('Failed to build sprocket-cli:', build.error);
	process.exit(build.status ?? 1);
}

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
