// Pins the latest Node.js LTS release, or the version passed as the first argument, in
// releases.json. Each archive must match the SHA256 that nodejs.org publishes in SHASUMS256.txt.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = 'https://nodejs.org/dist';

const TARGETS = {
	'darwin-arm64': 'darwin-arm64.tar.gz',
	'darwin-x64': 'darwin-x64.tar.gz',
	'linux-arm64': 'linux-arm64.tar.gz',
	'linux-x64': 'linux-x64.tar.gz',
	'win32-arm64': 'win-arm64.zip',
	'win32-x64': 'win-x64.zip'
};

const releasesPath = join(dirname(fileURLToPath(import.meta.url)), 'releases.json');

async function fetchOk(url) {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Request failed for ${url}: ${response.status}`);
	}

	return response;
}

const latestOrRequested =
	process.argv[2] ??
	(await (await fetchOk(`${DIST}/index.json`)).json()).find((release) => release.lts)?.version;

if (!latestOrRequested) {
	throw new Error('nodejs.org lists no LTS release');
}

const version = latestOrRequested.replace(/^v/, '');
const tag = `v${version}`;

const checksums = new Map(
	(await (await fetchOk(`${DIST}/${tag}/SHASUMS256.txt`)).text())
		.trim()
		.split('\n')
		.map((line) => line.trim().split(/\s+/).reverse())
);

const platforms = {};

for (const [platform, suffix] of Object.entries(TARGETS)) {
	const name = `node-${tag}-${suffix}`;
	const url = `${DIST}/${tag}/${name}`;
	const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (checksums.get(name) !== sha256) {
		throw new Error(`${name} does not match its published SHA256`);
	}

	platforms[platform] = { url, bytes: bytes.length, sha256 };
}

await writeFile(releasesPath, `${JSON.stringify({ version, platforms }, null, '\t')}\n`);

console.log(`Pinned Node.js ${version}.`);
