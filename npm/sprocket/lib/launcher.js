import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { createHost, parseUpdateArgs, runUpdateCli, UPDATE_API_FILENAME } from './update.js';

const require = createRequire(import.meta.url);

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

export function run(binary, args, options = {}) {
	const result = (options.spawn ?? spawnSync)(binary, args, {
		stdio: 'inherit',
		env: options.env ?? process.env
	});

	if (result.error) {
		throw result.error;
	}
	if (result.signal) {
		process.kill(process.pid, result.signal);
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
		process.exitCode = run(binary, args, {
			env: nativeChildEnvironment(
				env,
				staticDir,
				options.execPath ?? process.execPath,
				path.resolve(libDir, UPDATE_API_FILENAME)
			),
			spawn: options.spawn
		});
		return process.exitCode;
	} catch (error) {
		console.error(`sprocket: ${error.message}`);
		process.exitCode = 1;
		return 1;
	}
}
