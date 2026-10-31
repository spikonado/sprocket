// Pins the latest stable uv release (or the version passed as the first argument) in releases.json.
// Each archive must match GitHub's published size and digest.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'astral-sh/uv';

// The static musl builds run on any Linux libc.
const ASSETS = {
	'darwin-arm64': 'uv-aarch64-apple-darwin.tar.gz',
	'darwin-x64': 'uv-x86_64-apple-darwin.tar.gz',
	'linux-arm64': 'uv-aarch64-unknown-linux-musl.tar.gz',
	'linux-x64': 'uv-x86_64-unknown-linux-musl.tar.gz',
	'win32-arm64': 'uv-aarch64-pc-windows-msvc.zip',
	'win32-x64': 'uv-x86_64-pc-windows-msvc.zip'
};

const releasesPath = join(dirname(fileURLToPath(import.meta.url)), 'releases.json');

const headers = { Accept: 'application/vnd.github+json' };

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

if (token) {
	headers.Authorization = `Bearer ${token}`;
}

async function fetchOk(url, options) {
	const response = await fetch(url, options);

	if (!response.ok) {
		throw new Error(`Request failed for ${url}: ${response.status}`);
	}

	return response;
}

const release = await (
	await fetchOk(
		`https://api.github.com/repos/${REPOSITORY}/releases/${process.argv[2] ? `tags/${process.argv[2]}` : 'latest'}`,
		{ headers }
	)
).json();

if (release.prerelease || release.draft) {
	throw new Error(`uv ${release.tag_name} is not a stable release`);
}

const version = release.tag_name;

const platforms = {};

for (const [platform, name] of Object.entries(ASSETS)) {
	const published = release.assets.find((asset) => asset.name === name);

	if (!published) {
		throw new Error(`uv ${version} has no ${name} asset`);
	}

	const url = `https://github.com/${REPOSITORY}/releases/download/${version}/${name}`;
	const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (bytes.length !== published.size || published.digest !== `sha256:${sha256}`) {
		throw new Error(`Downloaded ${name} does not match the published size or digest`);
	}

	platforms[platform] = { url, bytes: bytes.length, sha256 };
}

await writeFile(releasesPath, `${JSON.stringify({ version, platforms }, null, '\t')}\n`);

console.log(`Pinned uv ${version}.`);
