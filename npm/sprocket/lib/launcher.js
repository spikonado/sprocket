import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function launch(args) {
	try {
		const packageRoot = path.dirname(fileURLToPath(import.meta.url));
		const staticDir = path.resolve(packageRoot, '../web');
		const binary = resolveNativeBinary();
		ensureExecutable(binary);
		process.exitCode = run(binary, args, {
			env: {
				...process.env,
				SPROCKET_STATIC_DIR: process.env.SPROCKET_STATIC_DIR || staticDir
			}
		});
	} catch (error) {
		console.error(`sprocket: ${error.message}`);
		process.exitCode = 1;
	}
}
