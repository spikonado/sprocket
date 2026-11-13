import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'anthropics/skills';
const skillPath = 'skills/frontend-design';

export async function updateSkill(root, request = fetch) {
	async function fetchOk(url, options) {
		const response = await request(url, options);

		if (!response.ok) {
			throw new Error(`Request failed for ${url}: ${response.status}`);
		}

		return response;
	}

	const headers = { Accept: 'application/vnd.github+json' };
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const { sha } = await (
		await fetchOk(`https://api.github.com/repos/${repository}/commits/main`, { headers })
	).json();

	const source = `https://github.com/${repository}`;
	const raw = `https://raw.githubusercontent.com/${repository}/${sha}/${skillPath}`;
	const directory = join(root, 'crates/sprocket-workspace/skills/frontend-design');

	const files = await Promise.all(
		['SKILL.md', 'LICENSE.txt'].map(async (name) => ({
			path: join(directory, name),
			contents: await (await fetchOk(`${raw}/${name}`)).text(),
			previous: await readFile(join(directory, name), 'utf8')
		}))
	);

	if (files.every(({ contents, previous }) => contents === previous)) {
		console.log('frontend-design is already current.');

		return;
	}

	const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md');
	const notices = await readFile(noticesPath, 'utf8');
	const section = /^## Frontend design skill\n[\s\S]*?(?=^## )/m;

	if (!section.test(notices)) {
		throw new Error('Frontend design skill section is missing from THIRD_PARTY_NOTICES.md');
	}

	const replacement = `## Frontend design skill

Sprocket bundles the unmodified \`frontend-design\` skill from
[${repository}](${source}/tree/${sha}/${skillPath}),
at commit \`${sha}\`, under
[Apache-2.0](${source}/blob/${sha}/${skillPath}/LICENSE.txt).

`;

	for (const { path, contents } of files) {
		await writeFile(path, contents);
	}

	await writeFile(
		noticesPath,
		notices.replace(section, () => replacement)
	);
	console.log(`Updated frontend-design to ${sha}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await updateSkill(join(dirname(fileURLToPath(import.meta.url)), '../..'));
}
