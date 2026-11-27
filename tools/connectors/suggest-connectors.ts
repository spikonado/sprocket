import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { namespaceDomain, registrableDomain, remoteUrl, type RegistryEntry } from './registry.ts';

const registry = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const directory = new URL('./', import.meta.url);

const readJson = async (file: string) =>
	JSON.parse(await readFile(new URL(file, directory), 'utf8'));

const catalog: { url: string }[] = await readJson(
	'../../crates/sprocket-host/connector-catalog.json'
);

const excluded = new Set<string>(await readJson('excluded.json'));
const knownDomains = new Set(catalog.map(({ url }) => registrableDomain(new URL(url).hostname)));

type Page = { servers: RegistryEntry[]; metadata?: { nextCursor?: string } };

type Candidate = { id: string; registryName: string; url: string };

async function fetchPage(url: URL): Promise<Page> {
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(30_000)
			});

			if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
			const page = await response.json();

			if (!Array.isArray(page?.servers)) throw new Error(`${url}: missing servers array`);

			return page;
		} catch (error) {
			if (attempt === 2) throw error;
			console.warn(`Retrying ${url}: ${error}`);
			await setTimeout(1000 * (attempt + 1));
		}
	}
}

async function* entries(): AsyncGenerator<RegistryEntry> {
	const url = new URL(registry);
	url.searchParams.set('limit', '100');
	url.searchParams.set('version', 'latest');

	for (;;) {
		const page = await fetchPage(url);
		yield* page.servers;
		const next = page.metadata?.nextCursor;

		if (!next) break;
		url.searchParams.set('cursor', next);
	}
}

const candidates: Candidate[] = [];
const candidateDomains = new Set<string>();

for await (const entry of entries()) {
	const name = entry.server.name;
	const domain = namespaceDomain(name);

	if (!domain || knownDomains.has(domain) || candidateDomains.has(domain)) continue;

	const id = domain.split('.')[0];
	const url = remoteUrl(entry);

	if (excluded.has(id) || !url) continue;
	candidates.push({ id, registryName: name, url });
	candidateDomains.add(domain);

	if (candidates.length === 10) break;
}

await writeFile(
	new URL('candidates.json', directory),
	JSON.stringify(candidates, null, '\t') + '\n'
);

console.log(`Wrote ${candidates.length} connector suggestions.`);
