import { describe, expect, it } from 'vitest';

import { canonicalDevWebUrl } from '../../../desktop/local-config.mjs';

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
