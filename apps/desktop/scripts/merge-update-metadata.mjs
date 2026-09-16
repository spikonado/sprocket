import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';

const SKIP_NAMES = new Set(['builder-debug.yml', 'builder-effective-config.yaml']);
const UPDATE_METADATA_NAME = /^(latest|alpha|beta|canary)(?:-linux(?:-arm64|-arm)?|-mac)?\.yml$/;
const FILE_LIST_KEYS = new Set(['files', 'path', 'sha512', 'releaseDate']);
const CORE_DUMP_KEYS = new Set(['version', 'files', 'path', 'sha512']);

export function isUpdateMetadataName(name) {
	return UPDATE_METADATA_NAME.test(name);
}

export function archHints(url) {
	const hints = new Set();
	if (/(?:^|[^a-z0-9])arm64(?:[^a-z0-9]|$)/i.test(url) || /aarch64/i.test(url)) {
		hints.add('arm64');
	} else if (/(?:^|[^a-z0-9])x64(?:[^a-z0-9]|$)/i.test(url) || /x86_64/i.test(url)) {
		hints.add('x64');
	} else if (/(?:^|[^a-z0-9])arm(?:[^a-z0-9]|$)/i.test(url)) {
		hints.add('arm');
	}
	return hints;
}

function isPlainObject(value) {
	return value !== null && value === Object(value) && !Array.isArray(value);
}

function reviveYamlValue(value) {
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (Array.isArray(value)) {
		return value.map(reviveYamlValue);
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [key, reviveYamlValue(nested)])
		);
	}
	return value;
}

function valuesEqual(left, right) {
	if (Object.is(left, right)) {
		return true;
	}
	return JSON.stringify(left) === JSON.stringify(right);
}

export function parseUpdateInfoYaml(text, filePath = 'update.yml') {
	let loaded;
	try {
		loaded = reviveYamlValue(loadYaml(text));
	} catch (error) {
		throw new Error(`${filePath} is not valid YAML: ${error.message}`);
	}
	if (!isPlainObject(loaded) || loaded.version == null || loaded.version === '') {
		throw new Error(`${filePath} is not electron-builder update metadata.`);
	}
	if (!Array.isArray(loaded.files) || loaded.files.length === 0) {
		throw new Error(`${filePath} is not electron-builder update metadata.`);
	}
	for (const file of loaded.files) {
		if (!isPlainObject(file) || !file.url || !file.sha512) {
			throw new Error(`${filePath} has an incomplete files entry.`);
		}
	}
	return { ...loaded, version: String(loaded.version) };
}

function fileSortKey(file) {
	const url = file.url;
	if (url.endsWith('.zip')) {
		return 0;
	}
	if (url.endsWith('.exe') || url.endsWith('.AppImage')) {
		return 1;
	}
	return 2;
}

export function serializeUpdateInfoYaml(info) {
	const files = [...info.files].sort((left, right) => fileSortKey(left) - fileSortKey(right));
	const primary = files[0];
	const document = {
		version: info.version,
		files,
		path: info.path ?? primary.url,
		sha512: info.sha512 ?? primary.sha512
	};
	for (const [key, value] of Object.entries(info)) {
		if (CORE_DUMP_KEYS.has(key) || value === undefined) {
			continue;
		}
		document[key] = value;
	}
	return dumpYaml(document, { lineWidth: -1, noRefs: true, quotingType: "'" });
}

function mergeFileEntry(existing, incoming, filePath) {
	const merged = { ...existing };
	for (const key of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
		if (!(key in existing)) {
			merged[key] = incoming[key];
			continue;
		}
		if (!(key in incoming)) {
			continue;
		}
		if (!valuesEqual(existing[key], incoming[key])) {
			throw new Error(
				`Refusing to overwrite ${existing.url} from ${filePath}. x64 and arm64 artifacts must both be kept.`
			);
		}
	}
	return merged;
}

function assertCompatibleMetadata(base, other, filePath) {
	if (other.version !== base.version) {
		throw new Error(
			`Refusing to merge ${filePath} at version ${other.version} with ${base.version}.`
		);
	}
	for (const key of new Set([...Object.keys(base), ...Object.keys(other)])) {
		if (FILE_LIST_KEYS.has(key) || key === 'version') {
			continue;
		}
		if (key in base && key in other && !valuesEqual(base[key], other[key])) {
			throw new Error(`Refusing to merge ${filePath}: ${key} is not compatible.`);
		}
	}
}

export function mergeUpdateInfo(manifests) {
	if (manifests.length === 0) {
		throw new Error('No update metadata to merge.');
	}
	const base = { ...manifests[0].info };
	const requiredArches = new Set();
	const filesByUrl = new Map();

	for (const { info, filePath } of manifests) {
		assertCompatibleMetadata(base, info, filePath);
		for (const [key, value] of Object.entries(info)) {
			if (FILE_LIST_KEYS.has(key) || key === 'version' || value === undefined) {
				continue;
			}
			if (!(key in base)) {
				base[key] = value;
			}
		}
		if (
			info.releaseDate &&
			(!base.releaseDate || String(info.releaseDate) > String(base.releaseDate))
		) {
			base.releaseDate = info.releaseDate;
		}
		for (const file of info.files) {
			for (const arch of archHints(file.url)) {
				requiredArches.add(arch);
			}
			const existing = filesByUrl.get(file.url);
			filesByUrl.set(
				file.url,
				existing == null ? { ...file } : mergeFileEntry(existing, file, filePath)
			);
		}
	}

	const files = [...filesByUrl.values()];
	const presentArches = new Set(files.flatMap((file) => [...archHints(file.url)]));
	for (const arch of requiredArches) {
		if (!presentArches.has(arch)) {
			throw new Error(`Merged update metadata dropped the ${arch} artifact.`);
		}
	}

	const zip = files.find((file) => file.url.endsWith('.zip')) ?? files[0];
	return {
		...base,
		files,
		path: zip.url,
		sha512: zip.sha512
	};
}

async function hashFile(file) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		digest.update(chunk);
	}
	return digest.digest('hex');
}

function isPathInside(inner, outer) {
	const relative = path.relative(outer, inner);
	return (
		relative === '' ||
		(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
	);
}

async function listSources(input) {
	const entries = await readdir(input, { withFileTypes: true });
	const directories = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(input, entry.name));
	return directories.length > 0 ? directories.sort() : [input];
}

async function prepareOutputDirectory(input, output) {
	const resolvedInput = path.resolve(input);
	const resolvedOutput = path.resolve(output);
	let inputStat;
	try {
		inputStat = await stat(resolvedInput);
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new Error(`input does not exist: ${resolvedInput}`);
		}
		throw error;
	}
	if (!inputStat.isDirectory()) {
		throw new Error('input must be a directory');
	}
	if (isPathInside(resolvedOutput, resolvedInput) || isPathInside(resolvedInput, resolvedOutput)) {
		throw new Error('output must not overlap input');
	}

	let outputStat;
	try {
		outputStat = await stat(resolvedOutput);
	} catch (error) {
		if (error.code === 'ENOENT') {
			await mkdir(resolvedOutput, { recursive: true });
			return { resolvedInput, resolvedOutput };
		}
		throw error;
	}
	if (!outputStat.isDirectory()) {
		throw new Error('output must be a directory');
	}
	const entries = await readdir(resolvedOutput);
	if (entries.length > 0) {
		throw new Error('output must be nonexistent or empty');
	}
	return { resolvedInput, resolvedOutput };
}

export async function mergeUpdateMetadata(input, output) {
	const { resolvedInput, resolvedOutput } = await prepareOutputDirectory(input, output);
	const planned = new Map();
	const metadata = new Map();

	for (const source of await listSources(resolvedInput)) {
		for (const name of await readdir(source)) {
			if (SKIP_NAMES.has(name)) {
				continue;
			}
			const filePath = path.join(source, name);
			if (!(await stat(filePath)).isFile()) {
				continue;
			}
			if (isUpdateMetadataName(name)) {
				const list = metadata.get(name) ?? [];
				list.push({
					filePath,
					info: parseUpdateInfoYaml(await readFile(filePath, 'utf8'), filePath)
				});
				metadata.set(name, list);
				continue;
			}
			const digest = await hashFile(filePath);
			const existing = planned.get(name);
			if (existing != null && existing.digest !== digest) {
				throw new Error(
					`Refusing to overwrite ${name}. Keep both ${existing.filePath} and ${filePath}.`
				);
			}
			planned.set(name, { filePath, digest });
		}
	}

	for (const [name, manifests] of metadata) {
		const merged = mergeUpdateInfo(manifests);
		await writeFile(path.join(resolvedOutput, name), serializeUpdateInfoYaml(merged), {
			flag: 'wx'
		});
	}
	await Promise.all(
		[...planned.entries()].map(([name, file]) =>
			copyFile(file.filePath, path.join(resolvedOutput, name), fsConstants.COPYFILE_EXCL)
		)
	);
}

function argumentsFrom(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith('--') || !value) {
			throw new Error('usage: merge-update-metadata.mjs --input DIR --output DIR');
		}
		values.set(key.slice(2), value);
	}
	return values;
}

async function main() {
	const args = argumentsFrom(process.argv.slice(2));
	const input = args.get('input');
	const output = args.get('output');
	if (!input || !output) {
		throw new Error('usage: merge-update-metadata.mjs --input DIR --output DIR');
	}
	await mergeUpdateMetadata(input, output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
