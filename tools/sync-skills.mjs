// Copies each built-in skill from upstream at the version pinned in its releases.json.
// Only the frontmatter is replaced.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS = {
	'agent-browser': {
		// What `agent-browser skills get core` prints.
		upstream: 'vercel-labs/agent-browser/v{version}/skill-data/core/SKILL.md',
		description:
			'Browser automation CLI. Use for website interaction, Electron app automation, and exploratory testing.'
	},
	'agent-desktop': {
		// What `agent-desktop skills get desktop` prints.
		upstream: 'vercel-labs/agent-desktop/v{version}/skills/agent-desktop/SKILL.md',
		description:
			'Operate desktop applications on macOS, Windows and Linux through native accessibility trees, using the agent-desktop CLI. Use when an AI agent must see or act on a desktop GUI.'
	}
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const [name, { upstream, description }] of Object.entries(SKILLS)) {
	const { version } = JSON.parse(
		await readFile(join(root, 'tools', name, 'releases.json'), 'utf8')
	);

	const url = `https://raw.githubusercontent.com/${upstream.replace('{version}', version)}`;
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Download failed for ${url}: ${response.status}`);
	}

	await writeFile(
		join(root, 'crates/sprocket-workspace/skills', name, 'SKILL.md'),
		`---\nname: ${name}\ndescription: ${description}\n---\n` +
			(await response.text()).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
	);
}
