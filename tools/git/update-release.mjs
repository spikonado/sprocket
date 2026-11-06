// Pins the latest stable MinGit release (or the Git for Windows tag passed as the first
// argument, such as v2.56.0.windows.4) in releases.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'git-for-windows/git';

// The BusyBox builds can't run the `!` credential helpers agents get.
const TARGETS = {
	'win32-arm64': /^MinGit-[\d.]+-arm64\.zip$/,
	'win32-x64': /^MinGit-[\d.]+-64-bit\.zip$/
};

// Git runs `!` helpers and hooks through MinGit's own `sh`.
const REQUIRED_ENTRIES = ['cmd/git.exe', 'usr/bin/sh.exe'];

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
	throw new Error(`Git for Windows ${release.tag_name} is not a stable release`);
}

const version = release.tag_name.replace(/^v/, '');

const scratch = await mkdtemp(join(tmpdir(), 'mingit-release-'));

const platforms = {};

try {
	for (const [platform, pattern] of Object.entries(TARGETS)) {
		const published = release.assets.find((asset) => pattern.test(asset.name));

		if (!published) {
			throw new Error(`Git for Windows ${release.tag_name} has no asset matching ${pattern}`);
		}

		const url = published.browser_download_url;
		const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
		const sha256 = createHash('sha256').update(bytes).digest('hex');

		if (bytes.length !== published.size || published.digest !== `sha256:${sha256}`) {
			throw new Error(`Downloaded ${published.name} does not match the published size or digest`);
		}

		const archive = join(scratch, published.name);
		await writeFile(archive, bytes);
		const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n');

		for (const required of REQUIRED_ENTRIES) {
			if (!entries.includes(required)) {
				throw new Error(`${published.name} has no ${required}`);
			}
		}

		platforms[platform] = { url, bytes: bytes.length, sha256 };
	}
} finally {
	await rm(scratch, { recursive: true, force: true });
}

await writeFile(releasesPath, `${JSON.stringify({ version, platforms }, null, '\t')}\n`);

console.log(`Pinned MinGit ${version}.`);
