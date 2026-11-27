import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import {
	connector,
	namespaceDomain,
	normalizedUrl,
	remoteUrl,
	type Connector,
	type RegistryEntry,
	type Vendor
} from './catalog.ts';

const officialRegistry = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const directory = new URL('./', import.meta.url);

const vendors: Record<string, Vendor> = JSON.parse(
	await readFile(new URL('vendors.json', directory), 'utf8')
);

const excluded = new Set<string>(
	JSON.parse(await readFile(new URL('excluded.json', directory), 'utf8'))
);

type Page = { servers: RegistryEntry[]; metadata?: { nextCursor?: string } };

type Candidate = { id: string; registryName: string; url: string };

async function fetchJson(url: URL | string) {
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(30_000)
			});

			if (response.status === 404) return;

			if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

			return await response.json();
		} catch (error) {
			if (attempt === 2) throw error;
			console.warn(`Retrying ${url}: ${error}`);
			await setTimeout(1000 * (attempt + 1));
		}
	}
}

function officialServer(name: string): Promise<RegistryEntry | undefined> {
	return fetchJson(`${officialRegistry}/${encodeURIComponent(name)}/versions/latest`);
}

async function* entries(endpoint: string): AsyncGenerator<RegistryEntry> {
	const url = new URL(endpoint);
	url.searchParams.set('limit', '100');
	url.searchParams.set('version', 'latest');

	for (;;) {
		const page: Page | undefined = await fetchJson(url);

		if (!Array.isArray(page?.servers)) throw new Error(`${url}: missing servers array`);

		yield* page.servers;
		const next = page.metadata?.nextCursor;

		if (!next) break;
		url.searchParams.set('cursor', next);
	}
}

const githubNames = new Set<string>();
const githubUrls = new Set<string>();

for await (const { server } of entries('https://api.mcp.github.com/v0.1/servers')) {
	githubNames.add(server.name);

	for (const remote of server.remotes ?? []) {
		try {
			githubUrls.add(normalizedUrl(remote.url));
		} catch {
			// The advisory registry can contain template URLs or malformed remotes.
		}
	}
}

const catalog: Connector[] = [];
const ids = new Set<string>();

for (const [namespace, vendor] of Object.entries(vendors)) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(vendor.id) || ids.has(vendor.id)) {
		throw new Error(`Invalid or duplicate connector id: ${vendor.id}`);
	}

	ids.add(vendor.id);

	if (excluded.has(vendor.id)) continue;

	const name = `${namespace}/${vendor.server}`;
	const entry = await officialServer(name);
	const selected = entry && connector(entry, vendor, githubNames, githubUrls);

	if (selected) catalog.push(selected);
	else console.warn(`No qualifying official server for ${name}`);
}

catalog.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const candidates: Candidate[] = [];
const candidateDomains = new Set<string>();

const vendorDomains = new Set(
	Object.entries(vendors).flatMap(([namespace, vendor]) => [
		namespaceDomain(namespace),
		...vendor.domains
	])
);

for await (const entry of entries(officialRegistry)) {
	const name = entry.server.name;
	const domain = namespaceDomain(name);

	if (!domain) continue;

	const id = domain.split('.')[0];

	if (excluded.has(id) || vendorDomains.has(domain) || candidateDomains.has(domain)) continue;

	const url = remoteUrl(entry);

	if (!url) continue;
	candidates.push({ id, registryName: name, url });
	candidateDomains.add(domain);

	if (candidates.length === 10) break;
}

const write = (file: string, data: Connector[] | Candidate[]) =>
	writeFile(new URL(file, directory), JSON.stringify(data, null, '\t') + '\n');

await write('../../crates/sprocket-host/connector-catalog.json', catalog);

await write('candidates.json', candidates);

console.log(`Wrote ${catalog.length} connectors and ${candidates.length} discovery candidates.`);
