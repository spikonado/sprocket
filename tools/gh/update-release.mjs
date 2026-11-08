// Pins the latest stable GitHub CLI release (or the version passed as the first argument) in
// releases.json. Each archive must match GitHub's size and digest and hold `bin/gh`, or
// `bin/gh.exe` on Windows, the only file the host installs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'cli/cli';

const TARGETS = {
	'darwin-arm64': 'macOS_arm64.zip',
	'darwin-x64': 'macOS_amd64.zip',
	'linux-arm64': 'linux_arm64.tar.gz',
	'linux-x64': 'linux_amd64.tar.gz',
	'win32-arm64': 'windows_arm64.zip',
	'win32-x64': 'windows_amd64.zip'
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
	throw new Error(`GitHub CLI ${release.tag_name} is not a stable release`);
}

const version = release.tag_name.replace(/^v/, '');

const scratch = await mkdtemp(join(tmpdir(), 'gh-release-'));

const platforms = {};

try {
	for (const [platform, target] of Object.entries(TARGETS)) {
		const name = `gh_${version}_${target}`;
		const published = release.assets.find((asset) => asset.name === name);

		if (!published) {
			throw new Error(`GitHub CLI ${release.tag_name} has no ${name} asset`);
		}

		const url = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
		const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
		const sha256 = createHash('sha256').update(bytes).digest('hex');

		if (bytes.length !== published.size || published.digest !== `sha256:${sha256}`) {
			throw new Error(`Downloaded ${name} does not match the published size or digest`);
		}

		const archive = join(scratch, name);
		await writeFile(archive, bytes);
		const [command, args] = name.endsWith('.zip') ? ['unzip', ['-Z1']] : ['tar', ['-tzf']];
		const gh = platform.startsWith('win32') ? 'bin/gh.exe' : 'bin/gh';
		const entries = execFileSync(command, [...args, archive], { encoding: 'utf8' }).split('\n');

		if (!entries.some((entry) => entry === gh || entry.endsWith(`/${gh}`))) {
			throw new Error(`${name} has no ${gh}`);
		}

		platforms[platform] = { url, bytes: bytes.length, sha256 };
	}
} finally {
	await rm(scratch, { recursive: true, force: true });
}

await writeFile(releasesPath, `${JSON.stringify({ version, platforms }, null, '\t')}\n`);

console.log(`Pinned GitHub CLI ${version}.`);
