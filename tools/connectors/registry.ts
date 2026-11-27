import { parse } from 'tldts';

export type RegistryEntry = {
	server: {
		name: string;
		remotes?: { type: string; url: string }[];
	};
	_meta?: {
		'io.modelcontextprotocol.registry/official'?: { status: string; isLatest: boolean };
	};
};

export function registrableDomain(host: string): string | null {
	const result = parse(host, { allowPrivateDomains: true, extractHostname: false });

	return result.isIcann || result.isPrivate ? result.domain : null;
}

// Registry names under `io.github.<org>` don't prove ownership of any web domain.
export function namespaceDomain(registryName: string): string | null {
	const namespace = registryName.split('/')[0].toLowerCase();

	if (namespace.startsWith('io.github.')) return null;

	return registrableDomain(namespace.split('.').reverse().join('.'));
}

export function remoteUrl(entry: RegistryEntry): string | undefined {
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

		if (registrableDomain(url.hostname) === domain) return url.href;
	}
}
