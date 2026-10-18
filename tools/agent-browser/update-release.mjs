// Pins the latest stable agent-browser release in releases.json. Every asset is downloaded
// and hashed locally; GitHub's reported size and digest must agree with the download.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const releasesPath = join(root, 'tools/agent-browser/releases.json');

const dashboardPatches = JSON.parse(
	await readFile(join(root, 'tools/agent-browser/dashboard-patches.json'), 'utf8')
);

const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md');

const releases = JSON.parse(await readFile(releasesPath, 'utf8'));

const pinned = releases.agentBrowser;

const headers = { Accept: 'application/vnd.github+json' };

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

if (token) {
	headers.Authorization = `Bearer ${token}`;
}

function parseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

	if (!match) {
		throw new Error(`Unsupported agent-browser version: ${version}`);
	}

	return match.slice(1).map(Number);
}

function isNewer(candidate, current) {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	const index = a.findIndex((part, position) => part !== b[position]);

	return index !== -1 && a[index] > b[index];
}

async function download(url) {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Request failed for ${url}: ${response.status}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());

	return {
		content: bytes,
		measured: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
	};
}

const response = await fetch(`https://api.github.com/repos/${pinned.repository}/releases/latest`, {
	headers
});

if (!response.ok) {
	throw new Error(`GitHub latest release lookup failed: ${response.status}`);
}

const latest = await response.json();

const tag = latest.tag_name;

const version = tag.replace(/^v/, '');

if (latest.prerelease || latest.draft || !isNewer(version, pinned.version)) {
	console.log(`agent-browser ${pinned.version} is already current (latest is ${tag}).`);
	process.exit(0);
}

const platforms = {};

for (const [platform, { asset }] of Object.entries(pinned.platforms)) {
	const published = latest.assets.find((candidate) => candidate.name === asset);

	if (!published) {
		throw new Error(`agent-browser ${tag} has no ${asset} asset`);
	}

	const { content, measured } = await download(
		`https://github.com/${pinned.repository}/releases/download/${tag}/${asset}`
	);

	if (
		measured.bytes !== published.size ||
		(published.digest && published.digest !== `sha256:${measured.sha256}`)
	) {
		throw new Error(`Downloaded ${asset} does not match the published size or digest`);
	}

	for (const [pattern] of dashboardPatches) {
		if (!content.includes(pattern)) {
			throw new Error(`${asset} no longer contains dashboard patch pattern ${pattern}`);
		}
	}

	platforms[platform] = { asset, ...measured };
}

const skillUrl = `https://codeload.github.com/${pinned.repository}/tar.gz/refs/tags/${tag}`;

releases.skillData = {
	url: skillUrl,
	...(await download(skillUrl)).measured
};

releases.agentBrowser = { ...pinned, version, tag, platforms };

await writeFile(releasesPath, `${JSON.stringify(releases, null, '\t')}\n`);

const notices = await readFile(noticesPath, 'utf8');

const updatedNotices = notices.replaceAll(
	`${pinned.repository}/blob/${pinned.tag}/`,
	`${pinned.repository}/blob/${tag}/`
);

if (updatedNotices === notices) {
	throw new Error('THIRD_PARTY_NOTICES.md has no pinned agent-browser link to update');
}

await writeFile(noticesPath, updatedNotices);

console.log(`Pinned agent-browser ${pinned.version} -> ${version}.`);
