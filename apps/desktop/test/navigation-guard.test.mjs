import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDenyUntrustedNavigation } from '../navigation-guard.mjs';

const rendererOrigin = 'http://127.0.0.1:7731';

test('allows navigation to the renderer origin', () => {
	assert.equal(shouldDenyUntrustedNavigation(`${rendererOrigin}/`, rendererOrigin), false);
	assert.equal(shouldDenyUntrustedNavigation(`${rendererOrigin}/chat`, rendererOrigin), false);
});

test('denies navigation away from the renderer origin', () => {
	assert.equal(shouldDenyUntrustedNavigation('https://evil.example/', rendererOrigin), true);
	assert.equal(shouldDenyUntrustedNavigation('http://127.0.0.1:9/', rendererOrigin), true);
});

test('denies malformed URLs instead of throwing', () => {
	for (const url of ['', 'not a url', '://missing-scheme', '/relative', 'http://']) {
		assert.equal(shouldDenyUntrustedNavigation(url, rendererOrigin), true);
	}
});
