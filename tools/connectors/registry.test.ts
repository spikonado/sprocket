import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteUrl, type RegistryEntry } from './registry.ts';

function entry(name: string, ...urls: string[]): RegistryEntry {
	return {
		server: {
			name,
			remotes: urls.map((url) => ({ type: 'streamable-http', url }))
		},
		_meta: {
			'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true }
		}
	};
}

test('matches registrable domains, including multi-label suffixes and namespace subdomains', () => {
	assert.equal(
		remoteUrl(entry('uk.co.example.docs/mcp', 'https://api.example.co.uk/mcp')),
		'https://api.example.co.uk/mcp'
	);

	for (const url of [
		'https://example.co.uk.attacker.com/mcp',
		'https://other.co.uk/mcp',
		'https://127.0.0.1/mcp',
		'https://example.co.uk@attacker.com/mcp'
	]) {
		assert.equal(remoteUrl(entry('uk.co.example/mcp', url)), undefined);
	}

	assert.equal(
		remoteUrl(entry('com.blogspot.vendor/mcp', 'https://other.blogspot.com/mcp')),
		undefined
	);
	assert.equal(
		remoteUrl(entry('io.github.example/mcp', 'https://example.github.io/mcp')),
		undefined
	);
});

test('selects an eligible remote and drops inactive, old, and SSE-only records', () => {
	const record = entry(
		'com.example/mcp',
		'https://{tenant}.example.com/mcp',
		'https://example.com/%7Btenant%7D',
		'http://example.com/mcp',
		'https://example.com/mcp'
	);

	assert.equal(remoteUrl(record), 'https://example.com/mcp');
	record._meta!['io.modelcontextprotocol.registry/official']!.isLatest = false;
	assert.equal(remoteUrl(record), undefined);
	record._meta!['io.modelcontextprotocol.registry/official'] = {
		status: 'deprecated',
		isLatest: true
	};
	assert.equal(remoteUrl(record), undefined);
	const sse = entry('com.example/mcp', 'https://example.com/sse');
	sse.server.remotes![0].type = 'sse';
	assert.equal(remoteUrl(sse), undefined);
});
