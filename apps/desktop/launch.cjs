const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function resolveWaylandDisplay(env) {
	if (process.platform !== 'linux') {
		return null;
	}

	if (env.XDG_SESSION_TYPE === 'x11') {
		return null;
	}

	if (env.WAYLAND_DISPLAY) {
		return env.WAYLAND_DISPLAY;
	}

	const runtimeDir = env.XDG_RUNTIME_DIR;
	if (!runtimeDir) {
		return null;
	}

	for (const candidate of ['wayland-0', 'wayland-1']) {
		if (fs.existsSync(path.join(runtimeDir, candidate))) {
			return candidate;
		}
	}

	return null;
}

async function main() {
	const env = { ...process.env };
	const waylandDisplay = resolveWaylandDisplay(env);

	if (waylandDisplay) {
		env.WAYLAND_DISPLAY = waylandDisplay;
		env.XDG_SESSION_TYPE ??= 'wayland';
	}

	const electronBinary = path.join(
		__dirname,
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'electron.cmd' : 'electron'
	);
	const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
		cwd: __dirname,
		env,
		stdio: 'inherit'
	});

	child.on('exit', (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}

		process.exit(code ?? 0);
	});

	child.on('error', (error) => {
		console.error('Failed to launch Electron.', error);
		process.exit(1);
	});
}

main().catch((error) => {
	console.error('Failed to launch Electron.', error);
	process.exit(1);
});
