import { expect, mock, test } from 'bun:test';
import type { AstroCookies } from 'astro';
import { beginPricingSignIn, completePricingSignIn, type PricingAuthServer } from './auth-server';

function fakeCookies() {
	const jar = new Map<string, string>();
	const cookies = {
		get: (name: string) => {
			const value = jar.get(name);
			return value === undefined ? undefined : { value, json: () => JSON.parse(value) };
		},
		set: (name: string, value: string | object) =>
			jar.set(name, typeof value === 'string' ? value : JSON.stringify(value)),
		delete: (name: string) => jar.delete(name)
	} as unknown as Pick<AstroCookies, 'get' | 'set' | 'delete'>;
	return { jar, cookies };
}

function fakeServer() {
	const authenticateWithCode = mock(async () => ({ sealedSession: 'sealed-session' }));
	const server = {
		cookiePassword: 'x'.repeat(32),
		workos: {
			userManagement: {
				getAuthorizationUrlWithPKCE: async () => ({
					url: 'https://api.workos.com/authorize',
					state: 'state-1',
					codeVerifier: 'verifier-1'
				}),
				authenticateWithCode
			}
		}
	} as unknown as PricingAuthServer;
	return { server, authenticateWithCode };
}

test('sign-in returns to the plan chosen before signing in', async () => {
	const { server, authenticateWithCode } = fakeServer();
	const { jar, cookies } = fakeCookies();

	await beginPricingSignIn(
		server,
		cookies,
		new URL('https://spikonado.com/api/pricing/sign-in?tier=pro&interval=annual')
	);
	const returnTo = await completePricingSignIn(
		server,
		cookies,
		new URL('https://spikonado.com/pricing/callback?code=code-1&state=state-1')
	);

	expect(returnTo).toBe('/pricing?checkout=resume&tier=pro&interval=annual');
	expect(authenticateWithCode).toHaveBeenCalledWith(
		expect.objectContaining({ code: 'code-1', codeVerifier: 'verifier-1' })
	);
	expect(jar.get('__Host-spikonado-pricing-session')).toBe('sealed-session');
	expect(jar.has('__Host-spikonado-pricing-login')).toBe(false);
});

test('sign-in completion requires the state issued to this browser', async () => {
	const { server, authenticateWithCode } = fakeServer();
	const { cookies } = fakeCookies();

	await beginPricingSignIn(server, cookies, new URL('https://spikonado.com/api/pricing/sign-in'));
	await expect(
		completePricingSignIn(
			server,
			cookies,
			new URL('https://spikonado.com/pricing/callback?code=code-1&state=other')
		)
	).rejects.toThrow('Sign-in could not be completed.');
	expect(authenticateWithCode).not.toHaveBeenCalled();
});
