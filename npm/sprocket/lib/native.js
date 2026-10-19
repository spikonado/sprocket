import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const TARGETS = JSON.parse(readFileSync(path.join(import.meta.dirname, '../targets.json'), 'utf8'));

const PLATFORM_PACKAGES = new Map(
	TARGETS.map((target) => [`${target.os}:${target.cpu}`, [target.packageName, target.executable]])
);

export function nativePackage(platform = process.platform, arch = process.arch) {
	return PLATFORM_PACKAGES.get(`${platform}:${arch}`);
}

export function resolveNativePackage(platform = process.platform, arch = process.arch) {
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

	return {
		packageName,
		version: JSON.parse(readFileSync(packageJson, 'utf8')).version,
		binary: path.join(path.dirname(packageJson), 'bin', executable)
	};
}

export function installedNativeVersion() {
	try {
		return resolveNativePackage().version;
	} catch {
		return '';
	}
}
