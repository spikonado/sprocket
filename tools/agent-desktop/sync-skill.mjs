// Copies the upstream agent-desktop skill at the version pinned in releases.json. It is the
// same guide that `agent-desktop skills get desktop` prints.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

const { version } = JSON.parse(
	await readFile(join(root, 'tools/agent-desktop/releases.json'), 'utf8')
).agentDesktop;

const url = `https://raw.githubusercontent.com/vercel-labs/agent-desktop/v${version}/skills/agent-desktop/SKILL.md`;

const response = await fetch(url);

if (!response.ok) {
	throw new Error(`Download failed for ${url}: ${response.status}`);
}

await writeFile(
	join(root, 'crates/sprocket-workspace/skills/agent-desktop/SKILL.md'),
	await response.text()
);
