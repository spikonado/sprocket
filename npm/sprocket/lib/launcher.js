import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createHost, parseUpdateArgs, runUpdateCli, UPDATE_API_FILENAME } from './update.js';

const require = createRequire(import.meta.url);

// Must match crates/sprocket-cli/src/main.rs.
export const RESTART_EXIT_CODE = 75;

const TARGETS = JSON.parse(readFileSync(path.join(import.meta.dirname, '../targets.json'), 'utf8'));

const PLATFORM_PACKAGES = new Map(
	TARGETS.map((target) => [`${target.os}:${target.cpu}`, [target.packageName, target.executable]])
);

export function nativePackage(platform = process.platform, arch = process.arch) {
	return PLATFORM_PACKAGES.get(`${platform}:${arch}`);
}

export function resolveNativeBinary(platform = process.platform, arch = process.arch) {
	const target = nativePackage(platform, arch);

	if (!target) {
		throw new Error(
			`Sprocket does not provide a binary for ${platform}/${arch}. ` +
				'Supported targets are Linux x64/arm64, macOS x64/arm64, and Windows x64.'
		);
	}

	const [packageName, executable] = target;
	let packageJson;

	try {
		packageJson = require.resolve(`${packageName}/package.json`);
	} catch (error) {
		if (error?.code !== 'MODULE_NOT_FOUND') {
			throw error;
		}

		throw new Error(
			`The native package ${packageName} is missing. Reinstall @spikonado/sprocket ` +
				'without omitting optional dependencies.',
			{ cause: error }
		);
	}

	return path.join(path.dirname(packageJson), 'bin', executable);
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
		// The native server clears SPROCKET_RESTARTED, so only a launcher started by a restarting
		// launcher sees it and leaves the next restart to that parent.
		const ownsRestart = !env.SPROCKET_RESTARTED;

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
			while (code === RESTART_EXIT_CODE) {
				const launcher = readRestartLauncher(env.SPROCKET_RESTART_FILE);

				if (!launcher) break;
				code = await run(execPath, [launcher, ...args], {
					env: { ...env, SPROCKET_RESTARTED: '1' },
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
