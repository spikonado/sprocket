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
	},
	'frontend-design': {
		upstream: 'anthropics/skills/main/skills/frontend-design/SKILL.md',
		description:
			"Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defaults."
	},
	'ui-sdk': {
		upstream: 'vercel-labs/ui/main/packages/core/skills/ui-sdk/SKILL.md',
		description:
			"Builds interfaces with ui-sdk in React, Vue, Svelte, Solid or web components. Covers choosing and composing its components, building a component or behavior it doesn't ship from @ui-sdk/core (like a stepper, splitter, transfer list or emoji picker), making the interface usable by agents through createAgent, agent tools and WebMCP, and testing keyboard, focus, ARIA, server rendering and right to left, including writing tests for an existing component. Use whenever a project has @ui-sdk/* installed or the user mentions ui-sdk."
	}
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const [name, { upstream, description }] of Object.entries(SKILLS)) {
	if (!upstream.includes('{version}') && !process.argv.includes('--include-unversioned')) {
		continue;
	}

	let source = upstream;

	if (upstream.includes('{version}')) {
		const { version } = JSON.parse(
			await readFile(join(root, 'tools', name, 'releases.json'), 'utf8')
		);

		source = upstream.replace('{version}', version);
	}

	const url = `https://raw.githubusercontent.com/${source}`;
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Download failed for ${url}: ${response.status}`);
	}

	await writeFile(
		join(root, 'crates/sprocket-workspace/skills', name, 'SKILL.md'),
		`---\nname: ${name}\ndescription: ${description}\n---\n` +
			// Built-in skills ship as one file, so links to sibling files must point at upstream.
			(await response.text())
				.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
				.replaceAll('](references/', `](${url.replace(/\/SKILL\.md$/, '')}/references/`)
	);
}
