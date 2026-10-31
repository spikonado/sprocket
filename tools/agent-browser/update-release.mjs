// Pins the latest stable agent-browser release (or the version passed as the first argument)
// in releases.json. Each asset must match GitHub's size and digest.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'vercel-labs/agent-browser';

// Static musl builds run on any Linux, and the x64 build runs on Windows on Arm.
const ASSETS = {
	'darwin-arm64': 'agent-browser-darwin-arm64',
	'darwin-x64': 'agent-browser-darwin-x64',
	'linux-arm64': 'agent-browser-linux-musl-arm64',
	'linux-x64': 'agent-browser-linux-musl-x64',
	'win32-arm64': 'agent-browser-win32-x64.exe',
	'win32-x64': 'agent-browser-win32-x64.exe'
};

const directory = dirname(fileURLToPath(import.meta.url));

const dashboardPatches = JSON.parse(
	await readFile(join(directory, 'dashboard-patches.json'), 'utf8')
);

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

async function download(url) {
	const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());

	return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const release = await (
	await fetchOk(
		`https://api.github.com/repos/${REPOSITORY}/releases/${process.argv[2] ? `tags/v${process.argv[2]}` : 'latest'}`,
		{ headers }
	)
).json();

if (release.prerelease || release.draft) {
	throw new Error(`agent-browser ${release.tag_name} is not a stable release`);
}

const version = release.tag_name.replace(/^v/, '');

const platforms = {};

for (const [platform, name] of Object.entries(ASSETS)) {
	const published = release.assets.find((asset) => asset.name === name);

	if (!published) {
		throw new Error(`agent-browser ${release.tag_name} has no ${name} asset`);
	}

	const url = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
	const { bytes, sha256 } = await download(url);

	if (bytes.length !== published.size || published.digest !== `sha256:${sha256}`) {
		throw new Error(`Downloaded ${name} does not match the published size or digest`);
	}

	for (const [pattern] of dashboardPatches) {
		if (!bytes.includes(pattern)) {
			throw new Error(`${name} no longer contains dashboard patch pattern ${pattern}`);
		}
	}

	platforms[platform] = { url, bytes: bytes.length, sha256 };
}

const skillUrl = `https://codeload.github.com/${REPOSITORY}/tar.gz/refs/tags/${release.tag_name}`;

const skill = await download(skillUrl);

await writeFile(
	join(directory, 'releases.json'),
	`${JSON.stringify(
		{
			version,
			platforms,
			skillData: { url: skillUrl, bytes: skill.bytes.length, sha256: skill.sha256 }
		},
		null,
		'\t'
	)}\n`
);

console.log(`Pinned agent-browser ${version}.`);
