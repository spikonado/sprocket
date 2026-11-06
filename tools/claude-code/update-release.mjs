// Pins the latest Claude Code release (or the version passed as the first argument) in releases.json.
// Claude Code is downloaded from its per-platform npm packages, whose tarballs the host can unpack with tar.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORMS = [
	'darwin-arm64',
	'darwin-x64',
	'linux-arm64',
	'linux-x64',
	'win32-arm64',
	'win32-x64'
];

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
	(await (await fetchOk('https://registry.npmjs.org/@anthropic-ai/claude-code/latest')).json())
		.version;

const platforms = {};

for (const platform of PLATFORMS) {
	const metadata = await (
		await fetchOk(`https://registry.npmjs.org/@anthropic-ai/claude-code-${platform}/${version}`)
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

console.log(`Pinned Claude Code ${version}.`);
