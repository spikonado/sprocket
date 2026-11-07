import { expect, spyOn, test } from 'bun:test';
import { beginPricingSignIn, completePricingSignIn, createPricingAuthServer } from './auth-server';

function fakeCookies() {
	const jar = new Map<string, string>();

	const cookies = {
		get: (name: string) => {
			const value = jar.get(name);

			return value === undefined ? undefined : { value };
		},
		set: (name: string, value: string) => jar.set(name, value),
		delete: (name: string) => jar.delete(name)
	};

	return { jar, cookies };
}

function fakeServer() {
	const server = createPricingAuthServer('sk_test', 'x'.repeat(32), 'client_test');
	const { userManagement } = server.workos;

	spyOn(userManagement, 'getAuthorizationUrlWithPKCE').mockResolvedValue({
		url: 'https://api.workos.com/authorize',
		state: 'state-1',
		codeVerifier: 'verifier-1'
	});

	const authenticateWithCode = spyOn(userManagement, 'authenticateWithCode').mockResolvedValue({
		user: {
			object: 'user',
			id: 'user_1',
			email: 'ada@example.com',
			emailVerified: true,
			profilePictureUrl: null,
			name: null,
			firstName: null,
			lastName: null,
			lastSignInAt: null,
			locale: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			externalId: null,
			metadata: {}
		},
		accessToken: 'access-token',
		refreshToken: 'refresh-token',
		sealedSession: 'sealed-session'
	});

	return { server, authenticateWithCode };
}

test('sign-in returns to the plan chosen before signing in', async () => {
	const { server, authenticateWithCode } = fakeServer();
	const { jar, cookies } = fakeCookies();

	await beginPricingSignIn(
		server,
		cookies,
		new URL('https://usesprocket.dev/api/pricing/sign-in?tier=pro&interval=annual')
	);

	const returnTo = await completePricingSignIn(
		server,
		cookies,
		new URL('https://usesprocket.dev/pricing/callback?code=code-1&state=state-1')
	);

	expect(returnTo).toBe('/pricing?checkout=resume&tier=pro&interval=annual');
	expect(authenticateWithCode).toHaveBeenCalledWith(
		expect.objectContaining({ code: 'code-1', codeVerifier: 'verifier-1' })
	);
	expect(jar.get('__Host-sprocket-pricing-session')).toBe('sealed-session');
	expect(jar.has('__Host-sprocket-pricing-login')).toBe(false);
});

test('sign-in returns to the credit pack chosen before signing in', async () => {
	const { server } = fakeServer();
	const { cookies } = fakeCookies();

	await beginPricingSignIn(
		server,
		cookies,
		new URL('https://usesprocket.dev/api/pricing/sign-in?pack=pdt_10')
	);

	expect(
		await completePricingSignIn(
			server,
			cookies,
			new URL('https://usesprocket.dev/pricing/callback?code=code-1&state=state-1')
		)
	).toBe('/pricing?checkout=resume&pack=pdt_10');
});

test('sign-in completion requires the state issued to this browser', async () => {
	const { server, authenticateWithCode } = fakeServer();
	const { cookies } = fakeCookies();

	await beginPricingSignIn(server, cookies, new URL('https://usesprocket.dev/api/pricing/sign-in'));
	await expect(
		completePricingSignIn(
			server,
			cookies,
			new URL('https://usesprocket.dev/pricing/callback?code=code-1&state=other')
		)
	).rejects.toThrow('Sign-in could not be completed.');
	expect(authenticateWithCode).not.toHaveBeenCalled();
});
