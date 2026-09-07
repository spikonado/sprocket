import { describe, expect, it } from 'vitest';
import { hostedWebFromPublicFlag, isHostedWeb, isHostedWebApiPath } from './runtime-mode';

describe('hostedWebFromPublicFlag', () => {
	it('treats only the explicit true string as hosted', () => {
		expect(hostedWebFromPublicFlag('true')).toBe(true);
		expect(hostedWebFromPublicFlag(undefined)).toBe(false);
		expect(hostedWebFromPublicFlag('')).toBe(false);
		expect(hostedWebFromPublicFlag('1')).toBe(false);
		expect(hostedWebFromPublicFlag('TRUE')).toBe(false);
		expect(hostedWebFromPublicFlag('false')).toBe(false);
	});
});

describe('isHostedWeb', () => {
	it('is false in the default bundled test build', () => {
		expect(isHostedWeb).toBe(false);
	});
});

describe('isHostedWebApiPath', () => {
	it('matches only hosted config and session routes', () => {
		expect(isHostedWebApiPath('/api/config')).toBe(true);
		expect(isHostedWebApiPath('/api/auth/sign-in')).toBe(true);
		expect(isHostedWebApiPath('/api/auth/sign-up')).toBe(true);
		expect(isHostedWebApiPath('/api/auth/callback')).toBe(true);
		expect(isHostedWebApiPath('/api/auth/session/token')).toBe(true);
		expect(isHostedWebApiPath('/api/auth/sign-out')).toBe(true);
		expect(isHostedWebApiPath('/api/auth/native-session')).toBe(false);
		expect(isHostedWebApiPath('/api/auth/native-session/token')).toBe(false);
		expect(isHostedWebApiPath('/api/auth/desktop-login/start')).toBe(false);
		expect(isHostedWebApiPath('/api/auth')).toBe(false);
	});
});
