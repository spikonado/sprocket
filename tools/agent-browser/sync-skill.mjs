// Regenerates the built-in agent-browser skill from `agent-browser skills get core`
// using the CLI and skill data pinned in releases.json. Only the frontmatter is replaced.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTMATTER = `---
name: agent-browser
description: Browser automation CLI. Use for website interaction, Electron app automation, and exploratory testing.
---
`;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const release = JSON.parse(await readFile(join(root, 'tools/agent-browser/releases.json'), 'utf8'));

const cache = join(root, 'node_modules/.cache/sprocket-agent-browser', release.version);

const skillPath = join(root, 'crates/sprocket-workspace/skills/agent-browser/SKILL.md');

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

async function cached(name, asset) {
	const path = join(cache, name);
	const existing = await readIfExists(path);

	if (existing && matches(existing, asset)) {
		return path;
	}

	const response = await fetch(asset.url);

	if (!response.ok) {
		throw new Error(`Download failed for ${asset.url}: ${response.status}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());

	if (!matches(bytes, asset)) {
		throw new Error(`Pinned release size or SHA256 mismatch for ${asset.url}`);
	}

	await mkdir(cache, { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, bytes, { mode: 0o755 });
	await rename(temporary, path);

	return path;
}

const asset = release.platforms[`${process.platform}-${process.arch}`];

if (!asset) {
	throw new Error(`No pinned agent-browser release for ${process.platform}/${process.arch}`);
}

const cli = await cached(basename(asset.url), asset);

const archive = await cached('source.tar.gz', release.skillData);

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
