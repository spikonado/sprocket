import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveNativePackage } from './native.js';
import {
	createHost,
	PACKAGE_ROOT,
	parseUpdateArgs,
	runUpdateCli,
	UPDATE_API_FILENAME
} from './update.js';

const RELAUNCHED_BY_LAUNCHER_ENV = 'SPROCKET_RELAUNCHED_BY_LAUNCHER';
const LEGACY_RELAUNCHED_ENV = 'SPROCKET_RESTARTED';

export function resolveNativeBinary() {
	const native = resolveNativePackage();
	const version = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

	if (native.version !== version) {
		throw new Error(
			`Sprocket ${version} needs ${native.packageName}@${version}, but ${native.version} is ` +
				'installed. Run `sprocket update` to repair the install.'
		);
	}

	return native.binary;
}

export function ensureExecutable(binary) {
	if (process.platform === 'win32') {
		return;
	}

	try {
		accessSync(binary, constants.X_OK);
	} catch {
		try {
			chmodSync(binary, 0o755);
		} catch {
			// Best-effort; spawn reports EACCES if still unusable.
		}
	}
}

export async function run(binary, args, options = {}) {
	const child = (options.spawn ?? spawn)(binary, args, {
		stdio: 'inherit',
		env: options.env ?? process.env
	});

	let interrupted;

	const handlers = new Map(
		['SIGINT', 'SIGTERM'].map((signal) => [
			signal,
			() => {
				interrupted ??= signal;

				// Windows already sends Ctrl+C to both processes; child.kill would force termination.
				if (process.platform !== 'win32' || signal !== 'SIGINT') {
					child.kill(signal);
				}
			}
		])
	);

	for (const [signal, handler] of handlers) {
		process.on(signal, handler);
	}

	let result;

	try {
		result = await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('close', (status, signal) => resolve({ status, signal }));
		});
	} finally {
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
	}

	const signal = result.signal ?? interrupted;

	if (signal) {
		process.kill(process.pid, signal);

		return undefined;
	}

	return result.status ?? 1;
}

export function nativeChildEnvironment(env, staticDir, updateNode, updateScript) {
	const next = {
		...env,
		SPROCKET_STATIC_DIR: env.SPROCKET_STATIC_DIR || staticDir,
		SPROCKET_UPDATE_NODE: updateNode,
		SPROCKET_UPDATE_SCRIPT: updateScript
	};

	delete next.SPROCKET_UPDATE_MANAGED;

	return next;
}

function readRestartLauncher(restartFile) {
	try {
		return readFileSync(restartFile, 'utf8');
	} catch {
		return null;
	} finally {
		rmSync(restartFile, { force: true });
	}
}

export async function launch(args, options = {}) {
	const env = { ...(options.env ?? process.env) };
	delete env.SPROCKET_UPDATE_MANAGED;

	if (env[LEGACY_RELAUNCHED_ENV]) {
		env[RELAUNCHED_BY_LAUNCHER_ENV] = '1';
	}

	delete env[LEGACY_RELAUNCHED_ENV];
	const parsed = parseUpdateArgs(args);

	if (parsed.kind !== 'none' && parsed.kind !== 'native') {
		const code = await runUpdateCli(parsed, options.host ?? createHost({ env }));
		process.exitCode = code;

		return code;
	}

	try {
		const libDir = options.libDir ?? import.meta.dirname;
		const staticDir = path.resolve(libDir, '../web');
		const binary = (options.resolveBinary ?? resolveNativeBinary)();
		(options.ensureExecutable ?? ensureExecutable)(binary);
		const execPath = options.execPath ?? process.execPath;
		const ownsRestart = !env[RELAUNCHED_BY_LAUNCHER_ENV];

		if (ownsRestart) {
			env.SPROCKET_RESTART_FILE = path.join(
				options.tmpdir ?? tmpdir(),
				`sprocket-restart-${randomUUID()}`
			);
		}

		let code = await run(binary, args, {
			env: nativeChildEnvironment(
				env,
				staticDir,
				execPath,
				path.resolve(libDir, UPDATE_API_FILENAME)
			),
			spawn: options.spawn
		});

		if (ownsRestart) {
			for (;;) {
				const launcher = readRestartLauncher(env.SPROCKET_RESTART_FILE);

				if (!launcher) break;
				code = await run(execPath, [launcher, ...args], {
					env: { ...env, [RELAUNCHED_BY_LAUNCHER_ENV]: '1' },
					spawn: options.spawn
				});
			}
		}

		process.exitCode = code;

		return process.exitCode;
	} catch (error) {
		console.error(`sprocket: ${error.message}`);
		process.exitCode = 1;

		return 1;
	}
}
