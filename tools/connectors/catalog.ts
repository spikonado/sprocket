import { parse } from 'tldts';

export type RegistryEntry = {
	server: {
		name: string;
		description: string;
		version: string;
		title?: string;
		websiteUrl?: string;
		icons?: { src: string; mimeType?: string }[];
		remotes?: { type: string; url: string }[];
	};
	_meta?: {
		'io.modelcontextprotocol.registry/official'?: { status: string; isLatest: boolean };
	};
};

export type Vendor = {
	id: string;
	name: string;
	server: string;
	domains: string[];
	githubName?: string;
};

export type Connector = {
	id: string;
	name: string;
	description: string;
	url: string;
	registryName: string;
	version: string;
	websiteUrl?: string;
	iconUrl?: string;
	listedOnGitHub: boolean;
};

export function registrableDomain(host: string): string | null {
	const result = parse(host, { allowPrivateDomains: true, extractHostname: false });

	return result.isIcann || result.isPrivate ? result.domain : null;
}

export function namespaceDomain(registryName: string): string | null {
	const namespace = registryName.split('/')[0].toLowerCase();

	if (namespace === 'io.github' || namespace.startsWith('io.github.')) return null;
	const host = namespace.split('.').reverse().join('.');

	return registrableDomain(host);
}

export function remoteUrl(entry: RegistryEntry, allowedDomains: string[] = []): string | undefined {
	const official = entry._meta?.['io.modelcontextprotocol.registry/official'];
	const domain = namespaceDomain(entry.server.name);

	if (official?.status !== 'active' || !official.isLatest || !domain) return;

	for (const remote of entry.server.remotes ?? []) {
		if (remote.type !== 'streamable-http' || /[{}]|%7[bd]/i.test(remote.url)) continue;
		let url: URL;

		try {
			url = new URL(remote.url);
		} catch {
			continue;
		}

		if (url.protocol !== 'https:' || url.username || url.password) continue;
		const remoteDomain = registrableDomain(url.hostname);

		if (remoteDomain && (remoteDomain === domain || allowedDomains.includes(remoteDomain))) {
			return url.href;
		}
	}
}

export function normalizedUrl(url: string): string {
	return new URL(url).href.replace(/\/$/, '');
}

export function connector(
	entry: RegistryEntry,
	vendor: Vendor,
	githubNames: Set<string>,
	githubUrls: Set<string>
): Connector | undefined {
	const url = remoteUrl(entry, vendor.domains);

	if (!url) return;
	const server = entry.server;

	return {
		id: vendor.id,
		name: vendor.name,
		description: server.description.replace(/\s+/g, ' ').trim(),
		url,
		registryName: server.name,
		version: server.version,
		websiteUrl: server.websiteUrl,
		iconUrl: server.icons?.find((icon) => icon.src.startsWith('https://'))?.src,
		listedOnGitHub:
			githubNames.has(server.name) ||
			(vendor.githubName !== undefined && githubNames.has(vendor.githubName)) ||
			githubUrls.has(normalizedUrl(url))
	};
}
