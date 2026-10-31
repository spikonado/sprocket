// Pins the latest Bun release (or the version passed as the first argument) in releases.json.
// Bun is downloaded from its per-platform npm packages, whose tarballs the host can unpack with tar.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Baseline x64 builds run on CPUs without AVX2.
const PACKAGES = {
	'darwin-arm64': 'bun-darwin-aarch64',
	'darwin-x64': 'bun-darwin-x64-baseline',
	'linux-arm64': 'bun-linux-aarch64',
	'linux-x64': 'bun-linux-x64-baseline',
	'win32-arm64': 'bun-windows-aarch64',
	'win32-x64': 'bun-windows-x64-baseline'
};

const releasesPath = join(dirname(fileURLToPath(import.meta.url)), 'releases.json');

async function fetchOk(url) {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Request failed for ${url}: ${response.status}`);
	}

	return response;
}

const version =
	process.argv[2] ??
	(await (await fetchOk('https://registry.npmjs.org/@oven/bun-linux-x64-baseline/latest')).json())
		.version;

const platforms = {};

for (const [platform, name] of Object.entries(PACKAGES)) {
	const metadata = await (
		await fetchOk(`https://registry.npmjs.org/@oven/${name}/${version}`)
	).json();

	const url = metadata.dist.tarball;
	const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
	const [algorithm, digest] = metadata.dist.integrity.split('-');

	if (createHash(algorithm).update(bytes).digest('base64') !== digest) {
		throw new Error(`${url} does not match its npm integrity`);
	}

	platforms[platform] = {
		url,
		bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}

await writeFile(releasesPath, `${JSON.stringify({ version, platforms }, null, '\t')}\n`);

console.log(`Pinned Bun ${version}.`);
