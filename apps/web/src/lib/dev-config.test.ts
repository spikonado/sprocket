import { describe, expect, it } from 'vitest';

import { canonicalDevWebUrl, usesLoopbackBrowserAuth } from '../../../desktop/local-config.mjs';

describe('canonicalDevWebUrl', () => {
	it('moves loopback IP URLs to localhost without losing callback state', () => {
		expect(canonicalDevWebUrl('http://127.0.0.1:5173/callback?code=code#pairing-token')).toBe(
			'http://localhost:5173/callback?code=code#pairing-token'
		);
	});

	it('moves IPv6 loopback URLs to localhost', () => {
		expect(canonicalDevWebUrl('http://[::1]:5173/callback?code=code')).toBe(
			'http://localhost:5173/callback?code=code'
		);
	});

	it('leaves the canonical development origin alone', () => {
		expect(canonicalDevWebUrl('http://localhost:5173/callback')).toBeNull();
	});
});

describe('usesLoopbackBrowserAuth', () => {
	it('uses the registered server callback for the installed browser app', () => {
		expect(usesLoopbackBrowserAuth('127.0.0.1', false, false)).toBe(true);
		expect(usesLoopbackBrowserAuth('localhost', false, false)).toBe(true);
		expect(usesLoopbackBrowserAuth('[::1]', false, false)).toBe(true);
	});

	it('keeps localhost development on the normal web callback', () => {
		expect(usesLoopbackBrowserAuth('localhost', false, true)).toBe(false);
		expect(usesLoopbackBrowserAuth('localhost', true, true)).toBe(true);
	});
});
