import { expect, spyOn, test } from 'bun:test';
import { CookieSession, type AccessTokenClaims, type User } from '@workos-inc/node';
import {
	beginPricingSignIn,
	completePricingSignIn,
	createPricingAuthServer,
	getPricingSession,
	pricingLogoutUrl
} from './auth-server';

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

const user: User = {
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
	createdAt: new Date('2026-01-01T00:00:00.000Z'),
	updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	externalId: null,
	metadata: {}
};

function verifiedClaims(exp: number) {
	return {
		sub: user.id,
		sid: 'session_1',
		iss: 'https://api.workos.com/',
		exp,
		iat: 0,
		auth_time: 0
	};
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
		user,
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

test('session expiry comes from the verified access token', async () => {
	const { server } = fakeServer();
	const { cookies } = fakeCookies();
	const exp = Math.floor(Date.now() / 1000) + 3600;

	cookies.set('__Host-sprocket-pricing-session', 'sealed-session');
	spyOn(server.workos.userManagement, 'getSessionFromCookie').mockResolvedValue({
		user,
		accessToken: 'access-token',
		refreshToken: 'refresh-token'
	});

	spyOn(server.workos.userManagement, 'verifyAccessToken').mockResolvedValue(verifiedClaims(exp));

	expect(
		await getPricingSession(server, cookies, new URL('https://usesprocket.dev/api/pricing/session'))
	).toEqual({
		user: { id: 'user_1', email: 'ada@example.com' },
		accessToken: 'access-token',
		expiresAt: exp * 1000
	});
});

function refreshingServer(verifyFreshToken: () => Promise<AccessTokenClaims>) {
	const { server } = fakeServer();
	const { jar, cookies } = fakeCookies();
	const { userManagement } = server.workos;
	const sealed = new CookieSession(userManagement, 'sealed-session', server.cookiePassword);

	cookies.set('__Host-sprocket-pricing-session', 'sealed-session');
	spyOn(userManagement, 'getSessionFromCookie').mockResolvedValue({
		user,
		accessToken: 'expired-token',
		refreshToken: 'refresh-token'
	});
	spyOn(userManagement, 'verifyAccessToken').mockImplementation(async (token) =>
		token === 'fresh-token' ? verifyFreshToken() : null
	);
	spyOn(sealed, 'refresh').mockResolvedValue({
		authenticated: true,
		sessionId: 'session_1',
		authenticationMethod: 'Password',
		user,
		sealedSession: 'refreshed-session',
		session: { user, accessToken: 'fresh-token', refreshToken: 'refresh-token-2' }
	});
	spyOn(userManagement, 'loadSealedSession').mockReturnValue(sealed);

	return {
		jar,
		session: () =>
			getPricingSession(server, cookies, new URL('https://usesprocket.dev/api/pricing/session'))
	};
}

test('a rejected access token is refreshed and the new session cookie is kept', async () => {
	const exp = Math.floor(Date.now() / 1000) + 3600;
	const { jar, session } = refreshingServer(async () => verifiedClaims(exp));

	expect(await session()).toMatchObject({ accessToken: 'fresh-token', expiresAt: exp * 1000 });
	expect(jar.get('__Host-sprocket-pricing-session')).toBe('refreshed-session');
});

test('the rotated session cookie is kept when verifying the refreshed token fails', async () => {
	const { jar, session } = refreshingServer(async () => {
		throw new Error('JWKS unavailable');
	});

	await expect(session()).rejects.toThrow('JWKS unavailable');
	expect(jar.get('__Host-sprocket-pricing-session')).toBe('refreshed-session');
});

test('logout ends the WorkOS session after the access token expires', async () => {
	const { server } = fakeServer();
	const expiredClaims = { exp: Math.floor(Date.now() / 1000) - 60, sid: 'session_1' };
	spyOn(server.workos.userManagement, 'getSessionFromCookie').mockResolvedValue({
		user,
		accessToken: `header.${Buffer.from(JSON.stringify(expiredClaims)).toString('base64url')}.sig`,
		refreshToken: 'refresh-token'
	});

	const logoutUrl = await pricingLogoutUrl(
		server,
		'sealed-session',
		new URL('https://usesprocket.dev/api/pricing/sign-out')
	);

	expect(new URL(logoutUrl ?? '').searchParams.get('session_id')).toBe('session_1');
});
