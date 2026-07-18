import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const [mode, ...unexpectedArguments] = process.argv.slice(2);

if (unexpectedArguments.length > 0 || (mode !== undefined && mode !== '--desktop')) {
	console.error('Usage: bun scripts/run-dev.mjs [--desktop]');
	process.exit(1);
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
			'cargo run -p sprocket-cli -- serve --port 7731 --data-dir .sprocket-dev --api-only',
			'node scripts/wait-for-api.mjs && bun run --cwd apps/web dev'
		];

const child = spawn(
	process.execPath,
	['x', 'concurrently', '-k', '-n', names, '-c', colors, ...commands],
	{
		cwd: repositoryRoot,
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
