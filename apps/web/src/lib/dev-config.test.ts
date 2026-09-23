import { describe, expect, it } from 'vitest';

import { canonicalDevWebUrl, usesLoopbackBrowserAuth } from '../../../desktop/local-config.mjs';

describe('canonicalDevWebUrl', () => {
	it('moves loopback IP URLs to localhost without losing callback state', () => {
		expect(canonicalDevWebUrl('http://127.0.0.1:5173/callback?code=code#workspace=%2Frepo')).toBe(
			'http://localhost:5173/callback?code=code#workspace=%2Frepo'
		);
	});

	it('moves IPv6 loopback URLs to localhost', () => {
		expect(canonicalDevWebUrl('http://[::1]:5173/callback?code=code')).toBe(
			'http://localhost:5173/callback?code=code'
		);
	});
});

it('uses browser callbacks locally and device codes on remote URLs', () => {
	for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
		expect(usesLoopbackBrowserAuth(hostname, false)).toBe(true);
	}
	expect(usesLoopbackBrowserAuth('sprocket.tailnet.ts.net', false)).toBe(false);
	expect(usesLoopbackBrowserAuth('sprocket.tailnet.ts.net', true)).toBe(true);
});
