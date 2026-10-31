// Pins the latest stable agent-desktop release (or the version passed as the first argument)
// in releases.json. Each archive must match GitHub's size and digest and hold the CLI at its root.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'vercel-labs/agent-desktop';

const TARGETS = {
	'darwin-arm64': 'aarch64-apple-darwin',
	'darwin-x64': 'x86_64-apple-darwin',
	'linux-arm64': 'aarch64-unknown-linux-gnu',
	'linux-x64': 'x86_64-unknown-linux-gnu',
	'win32-arm64': 'aarch64-pc-windows-msvc',
	'win32-x64': 'x86_64-pc-windows-msvc'
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
		`https://api.github.com/repos/${REPOSITORY}/releases/${process.argv[2] ? `tags/v${process.argv[2]}` : 'latest'}`,
		{ headers }
	)
).json();

if (release.prerelease || release.draft) {
	throw new Error(`agent-desktop ${release.tag_name} is not a stable release`);
}

const version = release.tag_name.replace(/^v/, '');

const platforms = {};

for (const [platform, target] of Object.entries(TARGETS)) {
	const name = `agent-desktop-${release.tag_name}-${target}.tar.gz`;
	const published = release.assets.find((asset) => asset.name === name);

	if (!published) {
		throw new Error(`agent-desktop ${release.tag_name} has no ${name} asset`);
	}

	const url = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
	const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (bytes.length !== published.size || published.digest !== `sha256:${sha256}`) {
		throw new Error(`Downloaded ${name} does not match the published size or digest`);
	}

	const cli = platform.startsWith('win32') ? 'agent-desktop.exe' : 'agent-desktop';

	const entries = execFileSync('tar', ['-tzf', '-'], { input: bytes, encoding: 'utf8' })
		.split('\n')
		.map((entry) => entry.replace(/^\.\//, ''))
		.filter((entry) => entry && !entry.endsWith('/'));

	// The host installs only top-level files.
	if (!entries.includes(cli) || entries.some((entry) => entry.includes('/'))) {
		throw new Error(`${name} must hold ${cli} and only top-level files`);
	}

	platforms[platform] = { url, bytes: bytes.length, sha256 };
}

await writeFile(releasesPath, `${JSON.stringify({ version, platforms }, null, '\t')}\n`);

console.log(`Pinned agent-desktop ${version}.`);
