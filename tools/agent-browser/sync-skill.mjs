// Regenerates the built-in agent-browser skill from `agent-browser skills get core`
// using the CLI and skill data pinned in releases.json. Only the frontmatter is replaced.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTMATTER = `---
name: agent-browser
description: Browser automation CLI. Use for website interaction, Electron app automation, and exploratory testing.
---
`;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const releases = JSON.parse(
	await readFile(join(root, 'tools/agent-browser/releases.json'), 'utf8')
);

const release = releases.agentBrowser;

const cache = join(root, 'node_modules/.cache/sprocket-agent-browser', release.version);

const skillPath = join(root, 'crates/sprocket-workspace/skills/agent-browser/SKILL.md');

function platformKey() {
	const keys = {
		'darwin-arm64': 'darwin-arm64',
		'darwin-x64': 'darwin-x64',
		'linux-arm64': 'linux-musl-arm64',
		'linux-x64': 'linux-musl-x64',
		'win32-x64': 'win32-x64',
		'win32-arm64': 'win32-x64'
	};

	const key = keys[`${process.platform}-${process.arch}`];

	if (!key) {
		throw new Error(`No pinned agent-browser release for ${process.platform}/${process.arch}`);
	}

	return key;
}

function matches(bytes, asset) {
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	return bytes.length === asset.bytes && sha256 === asset.sha256;
}

async function readIfExists(path) {
	try {
		return await readFile(path);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return undefined;
		}

		throw error;
	}
}

async function cached(name, url, asset) {
	const path = join(cache, name);
	const existing = await readIfExists(path);

	if (existing && matches(existing, asset)) {
		return path;
	}

	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Download failed for ${url}: ${response.status}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());

	if (!matches(bytes, asset)) {
		throw new Error(`Pinned release size or SHA256 mismatch for ${url}`);
	}

	await mkdir(cache, { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o755 });
	await rename(temporary, path);

	return path;
}

const asset = release.platforms[platformKey()];

const cli = await cached(
	asset.asset,
	`https://github.com/${release.repository}/releases/download/${release.tag}/${asset.asset}`,
	asset
);

const archive = await cached('source.tar.gz', releases.skillData.url, releases.skillData);

const source = await mkdtemp(join(cache, 'source-'));

try {
	execFileSync('tar', ['-xzf', archive, '-C', source]);
	const [top, ...rest] = await readdir(source);

	if (!top || rest.length > 0) {
		throw new Error('Unexpected agent-browser source archive layout');
	}

	const output = execFileSync(cli, ['skills', 'get', 'core'], {
		encoding: 'utf8',
		env: { ...process.env, AGENT_BROWSER_SKILLS_DIR: join(source, top, 'skill-data') }
	});

	await writeFile(skillPath, FRONTMATTER + output.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
} finally {
	await rm(source, { recursive: true, force: true });
}
